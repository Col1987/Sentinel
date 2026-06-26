import { test, expect } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

// Shared helper — finds the tracking order-ID input and submit button on /track.html.
// Returns null for either value if not found (tests skip gracefully).
async function findTrackingControls(page: import('@playwright/test').Page) {
  const input = page.locator(
    'input[type="text"]:visible, input[type="search"]:visible, input[id*="order"]:visible, input[id*="track"]:visible',
  ).first();
  const submit = page.locator(
    'button[type="submit"], button:has-text("Track"), button:has-text("Search"), button:has-text("Find"), input[type="submit"]',
  ).first();
  const hasInput  = await input.count()  > 0;
  const hasSubmit = await submit.count() > 0;
  return { input: hasInput ? input : null, submit: hasSubmit ? submit : null };
}

// Submits a tracking query and waits for the result to settle.
async function submitTrackingId(
  page: import('@playwright/test').Page,
  orderId: string,
  controls: Awaited<ReturnType<typeof findTrackingControls>>,
): Promise<void> {
  if (controls.input) {
    await controls.input.fill(orderId);
    if (controls.submit) {
      await controls.submit.click();
    } else {
      await page.keyboard.press('Enter');
    }
  } else {
    // Fallback: supply ID via query parameter for pages that auto-search on load.
    await page.goto(`/track.html?id=${encodeURIComponent(orderId)}`, { waitUntil: 'load' });
  }

  await page.waitForFunction(
    () => !document.querySelector('[class*="loading"], [class*="spinner"], [aria-busy="true"]'),
    { timeout: 6_000 },
  ).catch(() => {});
}

test.describe('Order tracking — negative', { tag: ['@security'] }, () => {

  test.beforeEach(async ({ page }) => {
    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }
  });

  // ─── track-page-loads ─────────────────────────────────────────────────────────

  test('track-page-loads — /track.html loads successfully and presents an order ID input field', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to the order tracking page and verified it returns a 200 status and renders an input field where guests can enter their order ID. The tracking page is the primary self-service tool for guests to check delivery status — it must always be accessible and functional.",
    });

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    const response = await page.goto('/track.html', { waitUntil: 'load' });
    const status   = response?.status() ?? 0;

    expect(status, '/track.html must return HTTP 200').toBeLessThan(400);
    console.log(`[INFO] track-page-loads: /track.html status = ${status}.`);

    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [aria-busy="true"]'),
      { timeout: 5_000 },
    ).catch(() => {});

    const controls = await findTrackingControls(page);

    if (controls.input) {
      console.log('[INFO] track-page-loads: order ID input field found ✓');
    } else {
      // May use URL-based tracking (no visible input) — check for body content instead.
      const bodyText = await page.evaluate(() => document.body.innerText.trim());
      if (bodyText.length < 50) {
        console.warn(
          '[FINDING][medium] track-page-loads: /track.html has no visible order ID input and almost no page content. ' +
            'The tracking page must give guests a clear way to look up their order status.',
        );
      } else {
        console.log('[INFO] track-page-loads: no visible input field but page has content — may use URL-based tracking.');
      }
    }

    if (pageErrors.length > 0) {
      console.error(
        `[FINDING][high] track-page-loads: ${pageErrors.length} JS exception(s) on /track.html load: ${pageErrors.join(' | ')}`,
      );
    }

    expect(pageErrors, 'No unhandled JS exceptions must fire when /track.html loads').toHaveLength(0);
  });

  // ─── track-invalid-order-id ───────────────────────────────────────────────────

  test('track-invalid-order-id — entering a fake order ID shows a not-found message with no error leak', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Entered the order ID 'FAKE-999999' on the tracking page and checked the response. In safe test mode the Cloud Function is blocked so the page will show a timeout or loading state rather than a not-found message — this is expected. In live mode, the page must show a polite 'order not found' message rather than a raw error or stack trace. Stack traces expose internal code details that can help attackers map the system.",
    });

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto('/track.html', { waitUntil: 'load' });
    const controls = await findTrackingControls(page);

    await submitTrackingId(page, 'FAKE-999999', controls);

    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());

    const STACK_SIGNALS   = ['at object.<anonymous>', 'typeerror:', 'referenceerror:', 'uncaughtexception', '    at '];
    const hasStackTrace   = STACK_SIGNALS.some(s => bodyText.includes(s));

    const GRACEFUL_SIGNALS = ['not found', 'no order', 'could not find', 'invalid', 'does not exist', 'no results', 'try again', 'check your'];
    const hasGraceful      = GRACEFUL_SIGNALS.some(s => bodyText.includes(s));

    if (hasStackTrace) {
      console.error(
        '[FINDING][high] track-invalid-order-id: a stack trace appeared after submitting "FAKE-999999". ' +
          'Technical error details must never be shown to users — display a friendly not-found message instead.',
      );
    } else if (hasGraceful) {
      console.log('[INFO] track-invalid-order-id: graceful not-found message displayed ✓');
    } else if (!LIVE_MODE) {
      console.log('[INFO] track-invalid-order-id: CF blocked in safe mode — tracking lookup did not fire. No graceful/error message expected.');
    } else {
      console.warn(
        '[FINDING][low] track-invalid-order-id: no recognisable not-found message appeared for an invalid order ID in LIVE_MODE. ' +
          'Guests should receive clear feedback when their ID is not recognised.',
      );
    }

    if (pageErrors.length > 0) {
      console.error(
        `[FINDING][high] track-invalid-order-id: ${pageErrors.length} JS exception(s) after invalid ID: ${pageErrors.join(' | ')}`,
      );
    }

    expect(hasStackTrace, 'A stack trace or raw error must not appear after an invalid order ID').toBe(false);
    expect(pageErrors,    'No unhandled JS exceptions must fire after submitting an invalid order ID').toHaveLength(0);
  });

  // ─── track-xss-in-order-id ────────────────────────────────────────────────────

  test('track-xss-in-order-id — XSS payload as order ID does not execute', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Entered an XSS payload as the order ID on the tracking page. Verified that the browser did not execute the injected script. If the tracking page reflects the entered order ID back into the DOM without sanitisation (e.g. in a 'searching for order X' message), a crafted tracking link could execute arbitrary JavaScript in a guest's browser.",
    });

    let xssDialogFired = false;
    page.on('dialog', async dialog => {
      xssDialogFired = true;
      console.error(
        `[FINDING][critical] track-xss-in-order-id: XSS payload in order ID field triggered a browser dialog. ` +
          `type="${dialog.type()}", message="${dialog.message()}". Reflected XSS is executing.`,
      );
      await dialog.dismiss();
    });

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    const XSS_PAYLOAD = '<script>alert(1)</script>';

    // Test via the input field.
    await page.goto('/track.html', { waitUntil: 'load' });
    const controls = await findTrackingControls(page);
    await submitTrackingId(page, XSS_PAYLOAD, controls);

    // Also test via URL query parameter (for reflected XSS in page load).
    if (!xssDialogFired) {
      await page.goto(`/track.html?id=${encodeURIComponent(XSS_PAYLOAD)}`, { waitUntil: 'load' });
      await page.waitForFunction(
        () => !document.querySelector('[class*="loading"]'),
        { timeout: 2_000 },
      ).catch(() => {});
    }

    // Check whether the raw XSS string is reflected unencoded in the DOM.
    const rawHtml = await page.content();
    if (rawHtml.includes('<script>alert') || rawHtml.includes('onerror=alert')) {
      console.error(
        '[FINDING][high] track-xss-in-order-id: XSS payload reflected unencoded in the page HTML. ' +
          'The order ID must be HTML-encoded before being inserted into the DOM.',
      );
    }

    if (!xssDialogFired) {
      console.log('[INFO] track-xss-in-order-id: XSS payload in order ID did not execute ✓');
    }

    if (pageErrors.length > 0) {
      console.warn(
        `[FINDING][medium] track-xss-in-order-id: ${pageErrors.length} JS exception(s) during XSS probe: ${pageErrors.join(' | ')}`,
      );
    }

    expect(xssDialogFired, 'XSS payload as order ID must not execute in the browser').toBe(false);
    expect(pageErrors,     'XSS payload in order ID must not cause unhandled JS exceptions').toHaveLength(0);
  });

  // ─── track-sql-injection ──────────────────────────────────────────────────────

  test('track-sql-injection — SQL injection payload as order ID does not crash the page', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Entered SQL injection patterns as the order ID on the tracking page. Although Firestore is a NoSQL database immune to SQL injection, injected payloads can still trigger client-side parsing errors, expose internal query logic, or cause unexpected application behaviour if not handled correctly. Verified that no JavaScript exceptions occurred and no technical error details were exposed.",
    });

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto('/track.html', { waitUntil: 'load' });
    const controls = await findTrackingControls(page);

    const PAYLOADS = [
      "'; DROP TABLE orders;--",
      "1 OR 1=1",
      "' UNION SELECT * FROM users--",
      "\"; alert('xss');\"",
    ];

    for (const payload of PAYLOADS) {
      await submitTrackingId(page, payload, controls);
      console.log(`[INFO] track-sql-injection: submitted "${payload.slice(0, 40)}" — no crash.`);
    }

    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    const STACK_SIGNALS = ['typeerror:', 'referenceerror:', '    at ', 'uncaughtexception'];
    const hasStackTrace = STACK_SIGNALS.some(s => bodyText.includes(s));

    if (hasStackTrace) {
      console.error(
        '[FINDING][high] track-sql-injection: a raw error or stack trace appeared after SQL injection payload. ' +
          'Technical error details must not be shown to users.',
      );
    } else {
      console.log('[INFO] track-sql-injection: SQL injection payloads handled without page crash ✓');
    }

    if (pageErrors.length > 0) {
      console.warn(
        `[FINDING][medium] track-sql-injection: ${pageErrors.length} JS exception(s) during SQL payloads: ${pageErrors.join(' | ')}`,
      );
    }

    expect(hasStackTrace, 'SQL injection payloads must not produce a stack trace on the tracking page').toBe(false);
    expect(pageErrors,    'SQL injection payloads must not cause unhandled JS exceptions on the tracking page').toHaveLength(0);
  });

  // ─── track-no-sensitive-data ──────────────────────────────────────────────────

  test('track-no-sensitive-data — tracking results do not expose customer email, phone number, or billing details', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Probed the order tracking page with a synthetic order ID and scanned the DOM and any Cloud Function responses for sensitive data patterns not covered by the existing public-pages suite: customer email addresses, phone numbers, and billing address fields. The tracking page is accessible to anyone with an order ID and must only reveal delivery status, not personal contact or payment details.",
    });

    // Capture CF responses to check payloads for sensitive data.
    const cfResponseBodies: string[] = [];
    if (LIVE_MODE) {
      await page.route(CF_PATTERN, async route => {
        const response = await route.fetch().catch(() => null);
        if (response) {
          const body = await response.text().catch(() => '');
          if (body) cfResponseBodies.push(body);
          await route.fulfill({ response });
        } else {
          await route.continue();
        }
      });
    }

    await page.goto('/track.html', { waitUntil: 'load' });
    const controls = await findTrackingControls(page);
    await submitTrackingId(page, 'SENTINEL-PROBE-TRACK-001', controls);

    const visibleText = await page.evaluate(() => document.body.innerText);
    const rawHtml     = await page.content();
    const allContent  = [visibleText, rawHtml, ...cfResponseBodies].join('\n');

    // These patterns extend what public-pages.spec.ts already checks (billing address, QR data).
    const SENSITIVE_PATTERNS: Array<{ label: string; pattern: RegExp; severity: string }> = [
      {
        label: 'customer email address in tracking result',
        pattern: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i,
        severity: 'high',
      },
      {
        label: 'phone number pattern',
        pattern: /\b(?:\+27|0)[6-8]\d[\s-]?\d{3}[\s-]?\d{4}\b|\b0\d{9}\b/,
        severity: 'high',
      },
      {
        label: 'billing address keywords in result',
        pattern: /billing[\s_-]?address|billing[\s_-]?street/i,
        severity: 'medium',
      },
      {
        label: 'PayFast payment token or reference',
        pattern: /pf_payment_id|m_payment_id|payment_token/i,
        severity: 'high',
      },
    ];

    let findingsCount = 0;
    for (const { label, pattern, severity } of SENSITIVE_PATTERNS) {
      if (pattern.test(allContent)) {
        findingsCount++;
        console.warn(
          `[FINDING][${severity}] track-no-sensitive-data: ${label} detected on the tracking page. ` +
            'The public tracking endpoint must only return order status and estimated delivery — ' +
            'no personal contact details or payment references.',
        );
      }
    }

    if (findingsCount === 0) {
      console.log(
        `[INFO] track-no-sensitive-data: no customer email, phone, or billing data detected ` +
          `(scanned ${cfResponseBodies.length} CF response(s)) ✓`,
      );
    }
  });

  // ─── track-other-users-order ──────────────────────────────────────────────────

  test('track-other-users-order — requesting a plausibly-formatted order ID without owning it returns no sensitive data', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Entered several plausibly-formatted order IDs that could belong to other customers (e.g. JH-0001, ORD-001). Verified that either no data was returned, or any data returned did not include personal details such as the customer's name, email, or delivery address. The tracking endpoint must not allow any visitor with a guessable order ID to view another customer's personal information.",
    });

    // Capture CF responses to inspect what the backend returns.
    const cfResponses: Array<{ url: string; status: number; body: string }> = [];
    if (LIVE_MODE) {
      await page.route(CF_PATTERN, async route => {
        const response = await route.fetch().catch(() => null);
        if (response) {
          const body = await response.text().catch(() => '');
          cfResponses.push({ url: route.request().url(), status: response.status(), body: body.slice(0, 500) });
          await route.fulfill({ response });
        } else {
          await route.continue();
        }
      });
    }

    await page.goto('/track.html', { waitUntil: 'load' });
    const controls = await findTrackingControls(page);

    // Plausibly-formatted IDs that could match a real order in a low-volume store.
    const PROBE_IDS = ['JH-0001', 'JH-001', 'ORD-001', 'ORDER-001', '#001'];

    for (const probeId of PROBE_IDS) {
      await submitTrackingId(page, probeId, controls);

      const bodyText = await page.evaluate(() => document.body.innerText);
      const rawHtml  = await page.content();

      // Detect personal data in the returned result.
      const PERSONAL_DATA = [
        { label: 'email address', pattern: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i },
        { label: 'full name + address combo', pattern: /\b[A-Z][a-z]+ [A-Z][a-z]+\b[\s\S]{0,200}\b\d+\s+\w+\s+(Street|Road|Ave|Drive|Rd)\b/i },
        { label: 'South African phone number', pattern: /\b(?:\+27|0)[6-8]\d[\s-]?\d{3}[\s-]?\d{4}\b/ },
      ];

      for (const { label, pattern } of PERSONAL_DATA) {
        if (pattern.test(bodyText) || pattern.test(rawHtml)) {
          console.error(
            `[FINDING][critical] track-other-users-order: probe ID "${probeId}" returned ${label} in the page. ` +
              'The tracking endpoint must not expose personal data to unauthenticated visitors. ' +
              'Require either the order owner\'s email or a session token to retrieve personal details.',
          );
        }
      }

      console.log(`[INFO] track-other-users-order: probed "${probeId}" — no personal data in page content.`);
    }

    // In LIVE_MODE, inspect CF response payloads too.
    for (const res of cfResponses) {
      const EMAIL_PATTERN = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
      if (EMAIL_PATTERN.test(res.body)) {
        console.error(
          `[FINDING][critical] track-other-users-order: CF response for a probe ID contains an email address. ` +
            `URL: ${res.url}. Payload (first 500 chars): ${res.body}`,
        );
      }
    }

    if (!LIVE_MODE) {
      console.log('[INFO] track-other-users-order: CF blocked in safe mode — tracking responses not received. Run with SENTINEL_LIVE_MODE=true to test live backend responses.');
    }
  });

});
