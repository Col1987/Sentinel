import { test, expect } from '@playwright/test';

// Curated subset of tests/smoke/health.spec.ts's checks — page availability and the
// handful of critical UI elements a regression run needs to catch immediately, not the
// full smoke suite (that suite still runs independently via --project=smoke).
const KNOWN_PAGES = [
  '/',
  '/account.html',
  '/checkout.html',
  '/track.html',
  '/welcome.html',
  '/admin.html',
] as const;

test.describe('Site health', { tag: ['@regression'] }, () => {

  test('known-pages-respond — every known page returns an HTTP status below 500', async ({ request }) => {
    test.info().annotations.push({
      type: 'description',
      description: 'Sent a lightweight HTTP request to every known page and confirmed none returned a server error (HTTP 500+).',
    });

    const results = await Promise.all(
      KNOWN_PAGES.map(async path => {
        try {
          const res = await request.get(path);
          return { path, status: res.status(), ok: res.status() < 500 };
        } catch (err) {
          return { path, status: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );

    for (const r of results) {
      if (r.ok) console.log(`[INFO] known-pages-respond: ${r.path} → HTTP ${r.status} ✓`);
      else console.error(`[FINDING][high] known-pages-respond: ${r.path} → HTTP ${r.status} — server error response.`);
    }

    const failures = results.filter(r => !r.ok);
    expect(failures, `Pages with server errors: ${failures.map(f => `${f.path} (${f.status})`).join(', ')}`).toHaveLength(0);
  });

  test('critical-ui-elements-present — homepage nav, primary CTA, and footer are all visible', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: 'Loaded the homepage and confirmed the navigation bar, primary "Get Started"/"Book a Demo" CTA, and footer are all visible — the minimum set of elements a visitor needs to orient and act on the page.',
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const navVisible = await page.locator('nav, header nav, .navbar, .nav-links, #navbar').first()
      .isVisible().catch(() => false);
    const ctaVisible = await page.locator(
      'button:has-text("Get Started"), a:has-text("Get Started"), ' +
      'button:has-text("Book a Demo"), a:has-text("Book a Demo")',
    ).first().isVisible().catch(() => false);
    const footerVisible = await page.locator('footer, [role="contentinfo"], .footer, #footer').first()
      .isVisible().catch(() => false);

    if (!navVisible)    console.error('[FINDING][high] critical-ui-elements-present: navigation bar not visible.');
    if (!ctaVisible)    console.error('[FINDING][high] critical-ui-elements-present: primary CTA not visible.');
    if (!footerVisible) console.error('[FINDING][medium] critical-ui-elements-present: footer not visible.');

    console.log(`[INFO] critical-ui-elements-present: nav=${navVisible}, cta=${ctaVisible}, footer=${footerVisible}.`);

    expect(navVisible,    'Navigation bar must be visible on the homepage').toBe(true);
    expect(ctaVisible,    'Primary CTA must be visible on the homepage').toBe(true);
    expect(footerVisible, 'Footer must be visible on the homepage').toBe(true);
  });

});
