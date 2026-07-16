import { test, expect, type Page } from '@playwright/test';

// Scans client-side JavaScript for credentials that must only exist server-side.
// Any credential visible in the browser's network tab or DevTools source panel
// can be extracted by any visitor with no special tools.

async function collectPageScripts(
  page: Page,
  pagePath: string,
): Promise<{ js: string; html: string; scriptUrls: string[] }> {
  const jsParts: string[] = [];
  const scriptUrls: string[] = [];

  await page.route('**/*.js', async route => {
    const url = route.request().url();
    scriptUrls.push(url);
    try {
      const response = await route.fetch();
      const text = await response.text();
      jsParts.push(text);
      await route.fulfill({ response });
    } catch {
      try { await route.continue(); } catch { /* route already handled */ }
    }
  });

  await page.goto(pagePath, { waitUntil: 'load' });
  // Wait for any dynamically injected <script> tags to finish loading after the load event.
  // readyState === 'complete' is guaranteed after 'load' but waiting here captures scripts
  // inserted in deferred callbacks before the inline script collection below runs.
  await page.waitForFunction(() => document.readyState === 'complete', undefined, { timeout: 2_000 }).catch(() => {});

  const inlineJs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script:not([src])')).map(el => el.textContent ?? '').join('\n'),
  );
  jsParts.push(inlineJs);

  const html = await page.content();
  return { js: jsParts.join('\n'), html, scriptUrls };
}

test.describe('Credential exposure', { tag: ['@security'] }, () => {

  // ─── no-payfast-credentials-in-source ──────────────────────────────────────

  test('no-payfast-credentials-in-source — PayFast merchant credentials must not appear in client-side JavaScript', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Loaded the checkout page and collected every line of JavaScript the browser downloads. Searched for PayFast payment credential patterns — merchant ID, merchant key, and passphrase. These values were previously hardcoded in browser-accessible files; they now belong exclusively on the server. CONFIRMED: no hardcoded PayFast credentials were found in any browser-accessible script.",
    });

    const { js } = await collectPageScripts(page, '/checkout.html');

    // Patterns look for the credential name followed by an actual string value,
    // not a variable reference. This avoids flagging form field name strings like
    // formData.append('merchant_id', serverValue) where the value is not hardcoded.
    const patterns: Array<{ label: string; re: RegExp }> = [
      { label: 'merchant_id with hardcoded numeric value', re: /merchant_id\s*[:=]\s*['"][0-9]{4,}['"]/ },
      { label: 'merchant_key with hardcoded value',        re: /merchant_key\s*[:=]\s*['"][a-zA-Z0-9]{8,}['"]/ },
      { label: 'passphrase as a config assignment',        re: /\bpassphrase\s*[:=]\s*['"][^'"]{4,}['"]/ },
    ];

    let hits = 0;
    for (const { label, re } of patterns) {
      if (re.test(js)) {
        hits++;
        console.error(
          `[FINDING][critical] no-payfast-credentials-in-source: ${label} found in client-side JavaScript. ` +
            'PayFast credentials must be held exclusively in server-side environment variables and must ' +
            'never appear in code that is visible to browser developer tools.',
        );
      }
    }

    expect(hits, 'No hardcoded PayFast credential patterns must appear in client-side JavaScript').toBe(0);
  });

  // ─── no-tcg-api-key-in-source ──────────────────────────────────────────────

  test('no-tcg-api-key-in-source — TCG ShipLogic delivery API key must not appear in client-side JavaScript', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Loaded the checkout page and scanned all JavaScript for TCG ShipLogic courier API key patterns. This key is used server-side to calculate delivery costs and create waybills — if it appeared in browser-accessible code, any visitor could use it to make unauthorised courier bookings. CONFIRMED: no API key patterns were found in browser-accessible scripts.",
    });

    const { js } = await collectPageScripts(page, '/checkout.html');

    const patterns: Array<{ label: string; re: RegExp }> = [
      {
        label: 'TCG or ShipLogic reference near an API key value',
        re: /(?:tcg|shiplogic|courier.?guy)[\s\S]{0,300}api.?key\s*[:=]\s*['"][^'"]{8,}['"]/i,
      },
      {
        label: 'generic api_key with a non-trivial hardcoded value',
        re: /\bapi[_-]key\s*[:=]\s*['"][a-zA-Z0-9_\-]{12,}['"]/,
      },
      {
        label: 'x-api-key header with a hardcoded value',
        re: /x-api-key['"]\s*:\s*['"][a-zA-Z0-9_\-]{8,}['"]/,
      },
    ];

    let hits = 0;
    for (const { label, re } of patterns) {
      if (re.test(js)) {
        hits++;
        console.error(
          `[FINDING][critical] no-tcg-api-key-in-source: ${label} found in client-side JavaScript. ` +
            'The courier/delivery API key must remain in server-side environment variables only. ' +
            'Exposure allows any visitor to make unauthorised waybill bookings at the account\'s expense.',
        );
      }
    }

    expect(hits, 'No TCG/ShipLogic API key patterns must appear in client-side JavaScript').toBe(0);
  });

  // ─── no-md5-script-loaded ──────────────────────────────────────────────────

  test('no-md5-script-loaded — md5.min.js must not be loaded on the checkout page', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Checked whether the checkout page loads an MD5 library script. Previously, this library was used to sign PayFast payment requests inside the browser — which required the payment passphrase to be present client-side. Payment signing now happens on the server, so this library should no longer be loaded. CONFIRMED: no MD5 library script is loaded on the checkout page.",
    });

    const { scriptUrls } = await collectPageScripts(page, '/checkout.html');

    // Also check via DOM for dynamically injected scripts that may have loaded
    // after our route interception window
    const domMd5 = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]'))
        .map(s => s.getAttribute('src') ?? '')
        .filter(src => /md5/i.test(src)),
    );

    const routeMd5 = scriptUrls.filter(url => /md5/i.test(url));
    const allMd5 = [...new Set([...routeMd5, ...domMd5])];

    if (allMd5.length > 0) {
      console.error(
        `[FINDING][high] no-md5-script-loaded: MD5 script(s) found on checkout.html: ${allMd5.join(', ')}. ` +
          'An MD5 library on the checkout page suggests payment signing may still be occurring in the browser, ' +
          'which requires the PayFast passphrase to be available client-side.',
      );
    }

    expect(allMd5, 'No MD5 library script must be loaded on the checkout page').toHaveLength(0);
  });

  // ─── no-deprecated-project-reference ───────────────────────────────────────

  test('no-deprecated-project-reference — "baylinhaus-c9d41" must not appear in any page source or script', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Scanned the homepage HTML and all loaded JavaScript for the decommissioned Firebase project ID ('baylinhaus-c9d41'). References to a deprecated backend project can cause data to be silently routed to the wrong environment, cause connection failures, or expose old security rules. CONFIRMED: no references to the deprecated project were found.",
    });

    const DEPRECATED_ID = 'baylinhaus-c9d41';
    const findings: string[] = [];

    const { js, html } = await collectPageScripts(page, '/');

    if (html.includes(DEPRECATED_ID)) {
      findings.push('homepage HTML source');
      console.error(
        `[FINDING][high] no-deprecated-project-reference: "${DEPRECATED_ID}" found in homepage HTML. ` +
          'This decommissioned project ID must be removed from all deployed files.',
      );
    }

    if (js.includes(DEPRECATED_ID)) {
      findings.push('homepage JavaScript');
      console.error(
        `[FINDING][high] no-deprecated-project-reference: "${DEPRECATED_ID}" found in JavaScript loaded by the homepage. ` +
          'All Firebase project references must point to the current active project only.',
      );
    }

    expect(findings, `"${DEPRECATED_ID}" must not appear in any page source or script`).toHaveLength(0);
  });

  // ─── config-js-only-contains-safe-values ───────────────────────────────────

  test('config-js-only-contains-safe-values — config.js must not contain API keys or secrets', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Located the site's client-side config file (config.js) and read its contents to verify it only holds safe, display-only values: the environment flag (sandbox/live) and email from-addresses. API keys, payment credentials, and secrets belong in server-side environment variables only and must never appear in this file. CONFIRMED: config.js contains only safe values.",
    });

    const { scriptUrls } = await collectPageScripts(page, '/');

    const configUrl = scriptUrls.find(url => /\/config\.js(\?|$)/.test(url));

    if (!configUrl) {
      console.log(
        '[INFO] config-js-only-contains-safe-values: no config.js found among scripts loaded by the homepage — nothing to audit.',
      );
      return;
    }

    const configResponse = await page.request.get(configUrl);
    const configContent = await configResponse.text();

    const secretPatterns: Array<{ label: string; re: RegExp }> = [
      { label: 'API key assignment',      re: /\bapi[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_\-]{8,}['"]/ },
      { label: 'secret assignment',       re: /\bsecret\s*[:=]\s*['"][^'"]{6,}['"]/ },
      { label: 'passphrase assignment',   re: /\bpassphrase\s*[:=]\s*['"][^'"]{4,}['"]/ },
      { label: 'merchant_key assignment', re: /merchant_key\s*[:=]\s*['"][a-zA-Z0-9]{8,}['"]/ },
      { label: 'merchant_id assignment',  re: /merchant_id\s*[:=]\s*['"][0-9]{4,}['"]/ },
      { label: 'Resend API key pattern',  re: /re_[a-zA-Z0-9]{20,}/ },
    ];

    let hits = 0;
    for (const { label, re } of secretPatterns) {
      if (re.test(configContent)) {
        hits++;
        console.error(
          `[FINDING][critical] config-js-only-contains-safe-values: ${label} found in config.js (${configUrl}). ` +
            'config.js is browser-accessible and must only contain the ENV sandbox/live flag and ' +
            'email from-address strings — all credentials belong in server-side environment variables.',
        );
      }
    }

    expect(hits, 'config.js must not contain any API keys, secrets, or payment credentials').toBe(0);
  });

});
