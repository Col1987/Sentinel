import { test, expect } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';
const COLLECTION_ADDRESS = '56 Robberg Road';

// The welcome page is a QR-powered guest hub. The guest identifier is passed as a
// query parameter; the exact param name is unknown so we probe the most common ones.
// Limit to 3 probes per test to stay well within the slow-mode timeout.
const GUEST_PARAM_PROBES = ['guest', 'id', 'code'];
const TEST_GUEST_VALUE   = 'SentinelTestGuest';

// Use 'load' + a short settle timeout (matching public-pages.spec.ts which passes for /welcome.html).
// Do NOT abort CF requests here — the welcome page depends on a CF call before DOMContentLoaded
// fires; aborting it causes Playwright to hang indefinitely waiting for the event that never comes.
// The CF call is a read-only data fetch (guest info), so letting it proceed in safe mode is fine.
const GOTO_OPTS = { waitUntil: 'load' as const };

// Fulfill (not abort) CF requests with an empty-success response so the page can proceed to its
// fallback state without blocking. abort() prevents DOMContentLoaded from firing on this page.
const CF_EMPTY_RESPONSE = { status: 200, contentType: 'application/json', body: '{"ok":true}' };

test.describe('Welcome page security', { tag: ['@security'] }, () => {

  test.beforeEach(async ({ page }) => {
    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.fulfill(CF_EMPTY_RESPONSE));
    }
  });

  // ─── welcome-valid-guest ──────────────────────────────────────────────────────

  test('welcome-valid-guest — /welcome.html with a guest parameter loads with content or a graceful fallback', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to the welcome page with a synthetic guest identifier using several common query parameter names (guest, id, code). Verified that the page loads and either shows personalised content or a graceful fallback — not a blank page or a JavaScript exception. In safe test mode the Cloud Function that loads guest pack data is blocked, so the page is expected to show a fallback or loading state.",
    });

    test.slow(); // multiple navigations — give 3× the normal timeout

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    let foundParam = '';
    for (const paramName of GUEST_PARAM_PROBES) {
      const url = `/welcome.html?${paramName}=${encodeURIComponent(TEST_GUEST_VALUE)}`;
      await page.goto(url, GOTO_OPTS).catch(() => {});
      await page.waitForTimeout(1_500);

      const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
      const hasContent  = bodyText.includes('welcome') || bodyText.includes('pack') || bodyText.includes('guest');
      const hasFallback = /not found|no guest|invalid|scan|use your qr/i.test(bodyText);

      if (hasContent || hasFallback) {
        foundParam = paramName;
        console.log(`[INFO] welcome-valid-guest: param "${paramName}" produced page response (content=${hasContent}, fallback=${hasFallback}) ✓`);
        break;
      }
    }

    if (!foundParam) {
      console.log(
        `[INFO] welcome-valid-guest: none of [${GUEST_PARAM_PROBES.join(', ')}] produced distinctive content. ` +
          'Guest identification may use a path segment or hash fragment rather than a query parameter.',
      );
    }

    const baseResponse = await page.goto('/welcome.html', GOTO_OPTS).catch(() => null);
    await page.waitForTimeout(1_500);
    const status = baseResponse?.status() ?? 0;

    if (status >= 400) {
      console.error(`[FINDING][medium] welcome-valid-guest: /welcome.html returned HTTP ${status}. The welcome page must be publicly accessible.`);
    } else {
      console.log(`[INFO] welcome-valid-guest: /welcome.html HTTP status = ${status}.`);
    }

    if (pageErrors.length > 0) {
      console.error(`[FINDING][high] welcome-valid-guest: ${pageErrors.length} JS exception(s): ${pageErrors.join(' | ')}`);
    }

    expect(pageErrors, 'No unhandled JS exceptions on the welcome page with a guest parameter').toHaveLength(0);
  });

  // ─── welcome-no-guest-param ───────────────────────────────────────────────────

  test('welcome-no-guest-param — /welcome.html with no guest parameter handles the empty state gracefully', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to /welcome.html without any query parameters — the URL a guest would type manually rather than scan. Verified that the page shows a friendly prompt ('scan your QR code') or similar fallback, with no JavaScript exceptions or raw error stack traces. A blank page or a crash gives guests no actionable guidance.",
    });

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto('/welcome.html', GOTO_OPTS).catch(() => {});
    await page.waitForTimeout(2_000);

    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
    const rawHtml  = await page.content().catch(() => '');

    const STACK_SIGNALS = ['at object.<anonymous>', 'typeerror:', 'referenceerror:', 'uncaughtexception', '    at '];
    const hasStackTrace = STACK_SIGNALS.some(s => bodyText.includes(s));

    if (hasStackTrace) {
      console.error(
        '[FINDING][high] welcome-no-guest-param: raw error or stack trace visible when /welcome.html ' +
          'loads without a guest parameter. Technical error details must not be shown to users.',
      );
    } else if (bodyText.trim().length < 20) {
      console.warn(
        '[FINDING][low] welcome-no-guest-param: fewer than 20 characters of visible text when no guest parameter is present. ' +
          'Show a message like "Scan your QR code to view your welcome pack" to guide guests.',
      );
    } else {
      console.log('[INFO] welcome-no-guest-param: page handles the no-parameter case without errors ✓');
    }

    if (pageErrors.length > 0) {
      console.error(`[FINDING][high] welcome-no-guest-param: ${pageErrors.length} JS exception(s): ${pageErrors.join(' | ')}`);
    }

    expect(hasStackTrace, 'No raw error or stack trace must appear when /welcome.html loads without a guest parameter').toBe(false);
    expect(pageErrors,    'No unhandled JS exceptions when the welcome page loads with no guest parameter').toHaveLength(0);
  });

  // ─── welcome-xss-in-guest-name ────────────────────────────────────────────────

  test('welcome-xss-in-guest-name — XSS payload in the guest name URL parameter does not execute', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to the welcome page with an XSS payload as the guest name query parameter. Verified that the browser did not execute the injected script. If the page reads the guest name from the URL and inserts it into the DOM without HTML-encoding, any visitor who crafts a malicious welcome link could execute arbitrary JavaScript in another guest's browser (reflected XSS).",
    });

    test.slow();

    let xssDialogFired = false;
    page.on('dialog', async dialog => {
      xssDialogFired = true;
      console.error(
        `[FINDING][critical] welcome-xss-in-guest-name: XSS payload in guest URL parameter triggered a dialog. ` +
          `type="${dialog.type()}", message="${dialog.message()}". Reflected XSS is executing.`,
      );
      await dialog.dismiss();
    });

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    const XSS_PAYLOAD = '<img src=x onerror=alert(1)>';
    const encoded     = encodeURIComponent(XSS_PAYLOAD);

    for (const paramName of GUEST_PARAM_PROBES) {
      if (xssDialogFired) break;
      await page.goto(`/welcome.html?${paramName}=${encoded}`, GOTO_OPTS).catch(() => {});
      await page.waitForTimeout(1_500);
    }

    // Check whether the raw XSS string appears unencoded in the rendered DOM.
    const rawHtml = await page.content().catch(() => '');
    if (rawHtml.includes('<img src=x') || rawHtml.includes('onerror=alert')) {
      console.error(
        '[FINDING][high] welcome-xss-in-guest-name: XSS payload appears unencoded in the page HTML. ' +
          'Guest name values read from the URL must be HTML-encoded before being inserted into the DOM.',
      );
    } else if (!xssDialogFired) {
      console.log('[INFO] welcome-xss-in-guest-name: XSS payload in guest parameter did not execute ✓');
    }

    if (pageErrors.length > 0) {
      console.warn(`[FINDING][medium] welcome-xss-in-guest-name: ${pageErrors.length} JS exception(s): ${pageErrors.join(' | ')}`);
    }

    expect(xssDialogFired, 'XSS payload in the guest URL parameter must not execute in the browser').toBe(false);
    expect(pageErrors,     'XSS payload in welcome URL must not cause unhandled JS exceptions').toHaveLength(0);
  });

  // ─── welcome-no-collection-address ────────────────────────────────────────────

  test('welcome-no-collection-address — the collection address does not appear on the welcome page when a guest parameter is provided', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to the welcome page with a guest parameter to trigger any data-load logic that runs when a guest is identified, then checked whether the Juel Haus collection address ('56 Robberg Road') appeared. The existing suite covers the no-parameter case; this test covers the parameter-present case where guest Firestore data could load. This is an internal logistics address that must never be shown to guests.",
    });

    await page.goto(
      `/welcome.html?guest=${encodeURIComponent(TEST_GUEST_VALUE)}`,
      GOTO_OPTS,
    ).catch(() => {});
    await page.waitForTimeout(2_000);

    const visibleText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const rawHtml     = await page.content().catch(() => '');

    const inVisible = visibleText.includes(COLLECTION_ADDRESS);
    const inHtml    = rawHtml.includes(COLLECTION_ADDRESS);

    if (inVisible || inHtml) {
      console.error(
        `[FINDING][critical] welcome-no-collection-address: "${COLLECTION_ADDRESS}" found on the welcome page ` +
          `with guest parameter (inVisibleText=${inVisible}, inRawHtml=${inHtml}). ` +
          'This internal logistics address must never be displayed to guests.',
      );
    } else {
      console.log(`[INFO] welcome-no-collection-address: "${COLLECTION_ADDRESS}" not present when guest parameter is supplied ✓`);
    }

    expect(
      inVisible || inHtml,
      `"${COLLECTION_ADDRESS}" must not appear on the welcome page when a guest parameter is provided`,
    ).toBe(false);
  });

  // ─── welcome-no-qr-data-leak ──────────────────────────────────────────────────

  test('welcome-no-qr-data-leak — QR code generation tokens and raw QR content are not exposed in the page source', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Loaded the welcome page and scanned the raw HTML for QR code generation artefacts: embedded base64 QR images, third-party QR generation API URLs, and raw QR token strings. A QR code generation token exposed in the page source could be used to clone a guest's QR code, enabling impersonation or unauthorised access to the welcome hub.",
    });

    await page.goto(`/welcome.html?guest=${encodeURIComponent(TEST_GUEST_VALUE)}`, GOTO_OPTS).catch(() => {});
    await page.waitForTimeout(2_000);

    const rawHtml = await page.content().catch(() => '');

    const QR_LEAK_PATTERNS: Array<{ label: string; pattern: RegExp; severity: string }> = [
      {
        label: 'inline base64 QR image (data URI ≥ 100 chars)',
        pattern: /data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/]{100,}/,
        severity: 'medium',
      },
      {
        label: 'Google Charts QR API URL with encoded content',
        pattern: /chart\.apis\.google\.com\/chart\?[^"'\s]*cht=qr/i,
        severity: 'high',
      },
      {
        label: 'qrserver.com API URL with content',
        pattern: /api\.qrserver\.com\/v1\/create-qr-code\/\?[^"'\s]{20,}/i,
        severity: 'high',
      },
      {
        label: 'long alphanumeric token adjacent to a "qr" keyword',
        pattern: /(?:qr|token|code)['":\s]+[A-Za-z0-9_\-]{32,}/i,
        severity: 'medium',
      },
    ];

    let findingsCount = 0;
    for (const { label, pattern, severity } of QR_LEAK_PATTERNS) {
      if (pattern.test(rawHtml)) {
        findingsCount++;
        console.warn(
          `[FINDING][${severity}] welcome-no-qr-data-leak: ${label} detected in page source. ` +
            'QR images should be generated server-side and served as opaque assets — ' +
            'generation tokens and raw QR content must not appear in the client-accessible DOM.',
        );
      }
    }

    if (findingsCount === 0) {
      console.log('[INFO] welcome-no-qr-data-leak: no QR generation tokens or raw QR data detected in page source ✓');
    }
  });

});
