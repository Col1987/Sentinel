import { test } from '@playwright/test';

// Response headers are read from the initial page load. Playwright's response.headers()
// returns lower-cased keys (RFC 7230 §3.2 — header field names are case-insensitive).

test.describe('Security headers', { tag: ['@security'] }, () => {

  // ─── security-headers-present ────────────────────────────────────────────────

  test('security-headers-present — homepage response headers include recommended security directives', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Loaded the homepage and inspected the HTTP response headers returned by the server. Security headers are a low-cost, high-impact defence layer — they instruct the browser to enforce protections against common attacks such as clickjacking, content-type sniffing, and protocol downgrade. Each missing header is logged as a finding with an explanation of the risk. The test itself always passes — all results are surfaced as findings for review.",
    });

    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });

    if (!response) {
      console.error('[FINDING][high] security-headers-present: page.goto returned no response object.');
      return;
    }

    const headers = response.headers();

    // ── HSTS ────────────────────────────────────────────────────────────────────
    const hsts = headers['strict-transport-security'];
    if (!hsts) {
      console.error(
        '[FINDING][high] security-headers-present: Strict-Transport-Security header is missing. ' +
          'Without HSTS, browsers may connect over HTTP rather than HTTPS — attackers on the same ' +
          'network can intercept and modify traffic. Add: Strict-Transport-Security: max-age=31536000; includeSubDomains',
      );
    } else {
      console.log(`[INFO] security-headers-present: Strict-Transport-Security = "${hsts}" ✓`);
    }

    // ── X-Content-Type-Options ───────────────────────────────────────────────────
    const xcto = headers['x-content-type-options'];
    if (!xcto) {
      console.error(
        '[FINDING][medium] security-headers-present: X-Content-Type-Options header is missing. ' +
          'Without nosniff, some browsers may interpret uploaded files as a different MIME type than ' +
          'declared, enabling content-sniffing attacks. Add: X-Content-Type-Options: nosniff',
      );
    } else {
      console.log(`[INFO] security-headers-present: X-Content-Type-Options = "${xcto}" ✓`);
    }

    // ── X-Frame-Options / CSP frame-ancestors ────────────────────────────────────
    const xfo = headers['x-frame-options'];
    const csp = headers['content-security-policy'] ?? '';
    const hasFrameGuard = !!xfo || csp.toLowerCase().includes('frame-ancestors');
    if (!hasFrameGuard) {
      console.error(
        '[FINDING][medium] security-headers-present: neither X-Frame-Options nor a CSP frame-ancestors ' +
          'directive is present. Without one of these, the site can be embedded in an <iframe> on a ' +
          'malicious page, enabling clickjacking attacks that trick users into clicking hidden elements. ' +
          'Add: X-Frame-Options: DENY  or include frame-ancestors in your Content-Security-Policy.',
      );
    } else {
      const which = xfo ? `X-Frame-Options: "${xfo}"` : `CSP frame-ancestors present`;
      console.log(`[INFO] security-headers-present: frame embedding protection — ${which} ✓`);
    }

    // ── Referrer-Policy ──────────────────────────────────────────────────────────
    const rp = headers['referrer-policy'];
    if (!rp) {
      console.warn(
        '[FINDING][low] security-headers-present: Referrer-Policy header is missing. ' +
          'Without it, the browser may send the full URL (including query strings containing ' +
          'order IDs or guest tokens) in the Referer header to third-party resources. ' +
          'Add: Referrer-Policy: strict-origin-when-cross-origin',
      );
    } else {
      console.log(`[INFO] security-headers-present: Referrer-Policy = "${rp}" ✓`);
    }

    // ── Permissions-Policy ───────────────────────────────────────────────────────
    const pp = headers['permissions-policy'];
    if (!pp) {
      console.warn(
        '[FINDING][low] security-headers-present: Permissions-Policy header is missing. ' +
          'Without it, embedded scripts and iframes can request access to camera, microphone, or ' +
          'geolocation without restriction. Add: Permissions-Policy: camera=(), microphone=(), geolocation=()',
      );
    } else {
      console.log(`[INFO] security-headers-present: Permissions-Policy = "${pp}" ✓`);
    }

    // ── Summary ──────────────────────────────────────────────────────────────────
    const present = [hsts, xcto, hasFrameGuard, rp, pp].filter(Boolean).length;
    console.log(`[INFO] security-headers-present: ${present}/5 security header checks passed.`);
    // No expect() — findings surfaced for report, test always passes.
  });

  // ─── cookie-security-flags ───────────────────────────────────────────────────

  test('cookie-security-flags — all cookies are set with appropriate security flags', async ({ page, context }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Loaded the homepage and inspected every cookie the site sets on a visitor's browser. Each cookie is checked for three security flags: Secure (cookie only sent over HTTPS), HttpOnly (inaccessible to JavaScript, protecting against XSS theft), and SameSite (controls cross-site submission, mitigating CSRF). Missing flags are logged as findings. If the site sets no cookies on load, that is logged as informational and the test passes.",
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const cookies = await context.cookies();

    if (cookies.length === 0) {
      console.log('[INFO] cookie-security-flags: no cookies set on the homepage — nothing to check.');
      return;
    }

    console.log(`[INFO] cookie-security-flags: ${cookies.length} cookie(s) found.`);

    for (const cookie of cookies) {
      const issues: string[] = [];

      // Secure flag — must be set for any cookie on an HTTPS site
      if (!cookie.secure) {
        issues.push('Secure flag missing — cookie will be sent over HTTP connections');
      }

      // HttpOnly — protects session tokens from being read by malicious scripts
      if (!cookie.httpOnly) {
        issues.push('HttpOnly flag missing — cookie is accessible to JavaScript (XSS risk)');
      }

      // SameSite — None without Secure is the worst combination
      if (cookie.sameSite === 'None' && !cookie.secure) {
        issues.push('SameSite=None without Secure — cookie sent cross-site over HTTP');
      }
      if (!cookie.sameSite) {
        issues.push('SameSite not set — defaults vary by browser; explicit Lax or Strict is safer');
      }

      if (issues.length > 0) {
        const severity = issues.some(i => i.includes('HttpOnly') || i.includes('SameSite=None')) ? 'medium' : 'low';
        for (const issue of issues) {
          console.error(
            `[FINDING][${severity}] cookie-security-flags: cookie "${cookie.name}" — ${issue}.`,
          );
        }
      } else {
        console.log(`[INFO] cookie-security-flags: cookie "${cookie.name}" — all security flags present ✓`);
      }
    }
    // No expect() — cookie flags are surfaced as findings, test always passes.
  });

});
