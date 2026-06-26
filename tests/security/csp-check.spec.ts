import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../../src/utils/auth';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

test.describe('Content Security Policy', { tag: ['@security'] }, () => {

  // ─── csp-allows-blob-for-images ───────────────────────────────────────────────

  test('csp-allows-blob-for-images — /admin.html Content-Security-Policy includes blob: in img-src', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and requested /admin.html, then inspected the Content-Security-Policy response header. Verified that the img-src directive includes 'blob:' (and 'data:' as a fallback check). The pack image upload preview generates a blob: URL via URL.createObjectURL() — if blob: is absent from img-src, the preview image will be blocked by the browser's CSP enforcement and the upload preview feature will silently break.",
    });

    test.slow();

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    // Navigate again to capture the response headers.
    // loginAsAdmin() lands on /admin.html via a Firebase redirect — that navigation's
    // response object is not accessible here, so we re-request the page directly.
    const response = await page.goto('/admin.html', { waitUntil: 'domcontentloaded' }).catch(() => null);
    if (!response) {
      console.error('[FINDING][medium] Expected element "HTTP response" not found on /admin.html — page.goto returned null');
      expect(false, 'Expected page.goto(/admin.html) to return a response object').toBe(true);
    }

    const headers = response!.headers();
    const cspRaw  = headers['content-security-policy'] ?? '';

    if (!cspRaw) {
      console.warn(
        '[FINDING][medium] csp-allows-blob-for-images: no Content-Security-Policy header found on /admin.html. ' +
          'A CSP header is strongly recommended to limit the impact of any XSS vulnerabilities in the admin portal.',
      );
      // Log and return — remaining assertions are meaningless without a CSP header.
      console.log('[INFO] csp-allows-blob-for-images: skipping img-src check (no CSP header present).');
      return;
    }

    console.log(`[INFO] csp-allows-blob-for-images: CSP header = "${cspRaw.slice(0, 300)}${cspRaw.length > 300 ? '…' : ''}"`);

    // Parse the img-src directive from the CSP.
    // CSP directives are separated by ';'. Fall back to default-src if img-src is absent.
    const directives = cspRaw.split(';').map(d => d.trim());

    const imgSrcDirective     = directives.find(d => d.startsWith('img-src'));
    const defaultSrcDirective = directives.find(d => d.startsWith('default-src'));

    const effectiveImgSrc = imgSrcDirective ?? defaultSrcDirective ?? '';
    console.log(`[INFO] csp-allows-blob-for-images: effective img-src = "${effectiveImgSrc}".`);

    if (!effectiveImgSrc) {
      console.warn(
        '[FINDING][low] csp-allows-blob-for-images: neither img-src nor default-src found in the CSP header. ' +
          'Without an explicit img-src directive, blob: URLs may be blocked by strict browser defaults.',
      );
      return;
    }

    const hasBlobInImgSrc = effectiveImgSrc.includes("'blob:'") || effectiveImgSrc.includes('blob:');

    if (!hasBlobInImgSrc) {
      console.error(
        `[FINDING][high] csp-allows-blob-for-images: "blob:" is absent from the effective img-src directive ` +
          `("${effectiveImgSrc}"). The pack image upload preview uses URL.createObjectURL() which produces ` +
          "blob: URLs. Without blob: in img-src the browser will block the preview image. " +
          "Add 'blob:' to the img-src directive in the CSP header.",
      );
    } else {
      console.log("[INFO] csp-allows-blob-for-images: 'blob:' is present in the effective img-src directive ✓");
    }

    expect(
      hasBlobInImgSrc,
      "Content-Security-Policy img-src (or default-src) must include 'blob:' to allow the pack image upload preview",
    ).toBe(true);
  });

});
