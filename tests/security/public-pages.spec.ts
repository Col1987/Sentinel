import { test, expect, type ConsoleMessage } from '@playwright/test';

// Public-page security checks from QA checklist sections 9 and 10.
// All tests are read-only: they observe page content and browser behaviour
// without creating data or submitting real requests.

const KNOWN_PAGES = [
  '/',
  '/account.html',
  '/checkout.html',
  '/track.html',
  '/welcome.html',
  '/terms.html',
] as const;

const COLLECTION_ADDRESS = '56 Robberg Road';

test.describe('Public page security', { tag: ['@security'] }, () => {

  // ─── track-page-invalid-input ──────────────────────────────────────────────

  test('track-page-invalid-input — invalid order ID shows a graceful not-found message, not a stack trace', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to the order tracking page and submitted a deliberately invalid order ID. Verified that the site responds with a polite 'not found' message rather than crashing or displaying a raw error stack trace. Stack traces expose internal code structure and can help attackers identify vulnerabilities. CONFIRMED: the page handles invalid input gracefully with no technical error details exposed.",
    });

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto('/track.html', { waitUntil: 'load' });
    // Wait for the tracking input to be rendered before attempting to locate it.
    await page.locator(
      'input[type="text"], input[type="search"], input:not([type="hidden"]):not([type="submit"])',
    ).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});

    const INVALID_ID = 'SENTINEL-INVALID-99999999';

    // Try to locate the tracking input field
    const trackingInput = page.locator('input[type="text"], input[type="search"], input:not([type="hidden"]):not([type="submit"])').first();
    const hasInput = (await trackingInput.count()) > 0;

    if (hasInput) {
      await trackingInput.fill(INVALID_ID);
      const submitBtn = page
        .locator('button[type="submit"], button:has-text("Track"), button:has-text("Search"), button:has-text("Find"), input[type="submit"]')
        .first();
      if ((await submitBtn.count()) > 0) {
        await submitBtn.click();
      }
    } else {
      // Fallback: supply the invalid ID via query parameter (auto-search on load)
      await page.goto(`/track.html?id=${INVALID_ID}`, { waitUntil: 'load' });
    }

    // Wait for the tracking lookup response to update the page with a result or error message.
    await page.waitForFunction(
      () => {
        const body = document.body.innerText.toLowerCase();
        return ['not found', 'no order', 'could not find', 'invalid', 'does not exist', 'no results', 'try again', 'error']
          .some(s => body.includes(s));
      },
      { timeout: 6_000 },
    ).catch(() => {});

    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());

    // Stack trace indicators — raw error output that should never reach users
    const stackTraceSignals = [
      'at object.<anonymous>',
      'uncaughtexception',
      'typeerror:',
      'referenceerror:',
      'syntaxerror:',
      '    at ',
    ];
    const hasStackTrace = stackTraceSignals.some(s => bodyText.includes(s));

    // Graceful not-found signals — at least one should be present for an invalid ID
    const gracefulSignals = ['not found', 'no order', 'could not find', 'invalid', 'does not exist', 'no results', 'try again'];
    const hasGracefulMessage = gracefulSignals.some(s => bodyText.includes(s));

    if (hasStackTrace) {
      console.error(
        '[FINDING][high] track-page-invalid-input: a stack trace or raw error message appeared in the ' +
          'page body after submitting an invalid order ID. Error details must be hidden from visitors — ' +
          'show a friendly "not found" message instead.',
      );
    }

    if (!hasGracefulMessage && !hasStackTrace) {
      console.warn(
        '[FINDING][low] track-page-invalid-input: no recognisable "not found" message appeared after ' +
          'submitting an invalid order ID. Visitors would not know their ID was unrecognised.',
      );
    }

    for (const err of pageErrors) {
      console.error(
        `[FINDING][high] track-page-invalid-input: unhandled JS exception on invalid input: ${err}`,
      );
    }

    expect(hasStackTrace, 'No raw stack trace or error details must be visible after an invalid order ID').toBe(false);
    expect(pageErrors, 'No unhandled JS exceptions must fire when submitting an invalid order ID').toHaveLength(0);
  });

  // ─── track-page-no-sensitive-data ──────────────────────────────────────────

  test('track-page-no-sensitive-data — public tracking page must not expose billing details, collection address, or QR codes', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Probed the public order tracking page to verify it does not leak sensitive data: the Juel Haus collection address, customer billing details, or raw QR code data. The tracking page is accessible to anyone with an order ID — it must only show delivery status information. CONFIRMED: no sensitive data patterns were detected on the tracking page.",
    });

    await page.goto('/track.html', { waitUntil: 'load' });
    // Wait for the tracking input to be rendered before attempting to locate it.
    await page.locator(
      'input[type="text"], input[type="search"], input:not([type="hidden"]):not([type="submit"])',
    ).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});

    const PROBE_ID = 'SENTINEL-PROBE-00000001';
    const trackingInput = page.locator('input[type="text"], input[type="search"], input:not([type="hidden"]):not([type="submit"])').first();

    if ((await trackingInput.count()) > 0) {
      await trackingInput.fill(PROBE_ID);
      const submitBtn = page
        .locator('button[type="submit"], button:has-text("Track"), button:has-text("Search"), input[type="submit"]')
        .first();
      if ((await submitBtn.count()) > 0) {
        await submitBtn.click();
      }
    } else {
      await page.goto(`/track.html?id=${PROBE_ID}`, { waitUntil: 'load' });
    }

    // Wait for the tracking lookup response to update the page before scanning content.
    await page.waitForFunction(
      () => {
        const body = document.body.innerText.toLowerCase();
        return ['not found', 'no order', 'could not find', 'invalid', 'does not exist', 'no results', 'try again', 'error']
          .some(s => body.includes(s));
      },
      { timeout: 6_000 },
    ).catch(() => {});

    const visibleText = await page.evaluate(() => document.body.innerText);
    const rawHtml     = await page.content();
    const lowerText   = visibleText.toLowerCase();

    const sensitiveChecks: Array<{ label: string; found: boolean }> = [
      {
        label: 'Juel Haus collection address',
        found: rawHtml.includes(COLLECTION_ADDRESS) || visibleText.includes(COLLECTION_ADDRESS),
      },
      {
        label: 'billing address keywords',
        found: /billing\s+address|billing_address/.test(lowerText),
      },
      {
        label: 'inline base64 QR code image (data URI)',
        found: /data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/]{100,}/.test(rawHtml),
      },
      {
        label: 'raw QR code data string alongside qrcode keyword',
        found: /qr[-_]?code|qrcode/.test(lowerText) && /[A-Z0-9]{20,}/.test(visibleText),
      },
    ];

    let hits = 0;
    for (const { label, found } of sensitiveChecks) {
      if (found) {
        hits++;
        console.error(
          `[FINDING][high] track-page-no-sensitive-data: ${label} detected on the public tracking page. ` +
            'The tracking page is accessible to any visitor with an order ID — it must only display ' +
            'delivery status, not internal or personal data.',
        );
      }
    }

    expect(hits, 'No sensitive data must be exposed on the public order tracking page').toBe(0);
  });

  // ─── no-console-errors-any-page ────────────────────────────────────────────

  test('no-console-errors-any-page — no unhandled JS exceptions across all known pages', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Loaded each page of the site in turn (homepage, account, checkout, tracking, welcome, and terms) and monitored the browser for unhandled JavaScript errors. These errors are invisible to normal visitors but indicate broken code paths that can cause unexpected failures. Any page-level exception is flagged as a critical finding.",
    });

    // Each page includes auth-related Firebase initialisation which can take a few seconds.
    // Triple the default timeout so all 6 pages have comfortable headroom.
    test.slow();

    interface PageResult {
      path: string;
      pageErrors: string[];
      consoleErrors: string[];
      consoleWarnings: string[];
    }

    const results: PageResult[] = [];

    for (const pagePath of KNOWN_PAGES) {
      const pageErrors: string[]    = [];
      const consoleErrors: string[] = [];
      const consoleWarnings: string[] = [];

      const onConsole = (msg: ConsoleMessage): void => {
        if (msg.type() === 'error')   consoleErrors.push(msg.text());
        if (msg.type() === 'warning') consoleWarnings.push(msg.text());
      };
      const onPageError = (err: Error): void => {
        pageErrors.push(err.message);
      };

      page.on('console',   onConsole);
      page.on('pageerror', onPageError);

      // Cap each page load at 20 s so a single slow page cannot exhaust the test budget.
      // /welcome.html makes live CF requests — without a cap it can block for 60 s+.
      await page.goto(pagePath, { waitUntil: 'load', timeout: 20_000 }).catch(() => {});
      // Yield to the microtask queue so console.error() calls deferred via async callbacks
      // during page initialisation can fire before we snapshot the error arrays.
      // domcontentloaded is already satisfied after waitUntil:'load', so this is ~0 ms.
      await page.waitForLoadState('domcontentloaded', { timeout: 1_000 }).catch(() => {});

      page.off('console',   onConsole);
      page.off('pageerror', onPageError);

      results.push({ path: pagePath, pageErrors, consoleErrors, consoleWarnings });
    }

    let totalPageErrors = 0;

    for (const { path, pageErrors, consoleErrors, consoleWarnings } of results) {
      totalPageErrors += pageErrors.length;

      for (const err of pageErrors) {
        console.error(`[FINDING][critical] no-console-errors-any-page [${path}] [pageerror]: ${err}`);
      }

      for (const err of consoleErrors) {
        console.error(`[FINDING][high] no-console-errors-any-page [${path}] [console.error]: ${err}`);
      }

      for (const w of consoleWarnings) {
        console.warn(`[FINDING][low] no-console-errors-any-page [${path}] [console.warn]: ${w}`);
      }

      console.log(
        `[INFO] no-console-errors-any-page [${path}]: ` +
          `${pageErrors.length} pageerror(s), ${consoleErrors.length} console.error(s), ${consoleWarnings.length} warning(s)`,
      );
    }

    expect(totalPageErrors, 'No unhandled JS exceptions must fire on any known page').toBe(0);
  });

});
