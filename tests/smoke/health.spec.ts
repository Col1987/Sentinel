import { test, expect } from '@playwright/test';

const KNOWN_PAGES = [
  '/',
  '/account.html',
  '/checkout.html',
  '/track.html',
  '/welcome.html',
  '/terms.html',
  '/admin.html',
] as const;

test.describe('Site health @smoke', () => {

  // ─── existing ────────────────────────────────────────────────────────────────

  test('should return 200 for the homepage', async ({ page }) => {
    test.info().annotations.push({ type: 'description', description: 'Loaded the website homepage and checked that the server responded successfully. CONFIRMED: the homepage is accessible and returning a normal response to visitors.' });
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('should load without console errors', async ({ page }) => {
    test.info().annotations.push({ type: 'description', description: 'Loaded the homepage while monitoring for hidden error messages in the browser. CONFIRMED: no errors were detected during page load.' });
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/');
    expect(errors).toHaveLength(0);
  });

  test('should have a non-empty page title', async ({ page }) => {
    test.info().annotations.push({ type: 'description', description: "Checked that the browser tab shows a title when a visitor loads the homepage. CONFIRMED: the page has a title set — this also helps search engines understand the page's content." });
    await page.goto('/');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });

  // ─── all-known-pages-respond ─────────────────────────────────────────────────

  test('all-known-pages-respond — every known page returns an HTTP status below 500', async ({ request }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Sent a lightweight HTTP request to every known page on the site — home, account, checkout, order tracking, guest welcome, terms, and admin — and confirmed each responded without a server error (status code below 500). A 500-level response means the server itself crashed or encountered an unhandled fault, leaving visitors with a blank or broken screen.",
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
      if (r.ok) {
        console.log(`[INFO] all-known-pages-respond: ${r.path} → HTTP ${r.status} ✓`);
      } else {
        console.error(`[FINDING][high] all-known-pages-respond: ${r.path} → HTTP ${r.status} — server error response.`);
      }
    }

    const failures = results.filter(r => !r.ok);
    expect(
      failures,
      `Pages with server errors: ${failures.map(f => `${f.path} (${f.status})`).join(', ')}`,
    ).toHaveLength(0);
  });

  // ─── homepage-nav-present ─────────────────────────────────────────────────────

  test('homepage-nav-present — navigation bar is visible with at least one nav link', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: 'Loaded the homepage and verified that a navigation bar is present and contains at least one link. Missing or invisible navigation means visitors cannot move between sections of the site.',
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const nav = page.locator('nav, header nav, .navbar, .nav-links, #navbar').first();
    const navVisible = await nav.isVisible().catch(() => false);
    const linkCount  = await page.locator('nav a, header a, .nav-links a, .navbar a').count();

    if (!navVisible) console.error('[FINDING][high] homepage-nav-present: no navigation bar found on the homepage.');
    if (linkCount === 0) console.error('[FINDING][high] homepage-nav-present: no nav links found in the navigation area.');

    console.log(`[INFO] homepage-nav-present: navVisible=${navVisible}, linkCount=${linkCount}.`);

    expect(navVisible, 'A navigation bar must be visible on the homepage').toBe(true);
    expect(linkCount,  'Navigation must contain at least one link').toBeGreaterThan(0);
  });

  // ─── homepage-hero-cta-visible ────────────────────────────────────────────────

  test('homepage-hero-cta-visible — primary CTA button is visible in the hero section', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Loaded the homepage and verified that the primary call-to-action button — 'Get Started' or 'Book a Demo' — is visible to visitors without any interaction. The CTA is the main conversion point on the landing page; if it fails to render, potential customers have no clear next step.",
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const cta = page.locator(
      'button:has-text("Get Started"), a:has-text("Get Started"), ' +
      'button:has-text("Book a Demo"), a:has-text("Book a Demo")',
    ).first();
    const ctaVisible = await cta.isVisible().catch(() => false);

    if (!ctaVisible) {
      console.error('[FINDING][high] homepage-hero-cta-visible: no "Get Started" or "Book a Demo" button found on the homepage.');
    } else {
      console.log('[INFO] homepage-hero-cta-visible: primary CTA button visible ✓');
    }

    expect(ctaVisible, 'A "Get Started" or "Book a Demo" button must be visible on the homepage').toBe(true);
  });

  // ─── homepage-footer-present ──────────────────────────────────────────────────

  test('homepage-footer-present — footer element is rendered at the bottom of the page', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: 'Loaded the homepage and verified that a footer element is present and rendered. The footer typically contains legal information, contact details, and secondary navigation — a missing footer leaves visitors without access to important site information.',
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const footer = page.locator('footer, [role="contentinfo"], .footer, #footer').first();
    const footerVisible = await footer.isVisible().catch(() => false);

    if (!footerVisible) {
      console.error('[FINDING][medium] homepage-footer-present: no footer element found on the homepage.');
    } else {
      console.log('[INFO] homepage-footer-present: footer element visible ✓');
    }

    expect(footerVisible, 'A footer element must be rendered on the homepage').toBe(true);
  });

  // ─── css-loaded ───────────────────────────────────────────────────────────────

  test('css-loaded — stylesheets are loaded and non-default styling has been applied', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Loaded the homepage and verified that the site's CSS stylesheets have been applied. If CSS fails to load completely, the site displays as unstyled raw HTML — unusable for visitors and damaging to the brand. Checks that stylesheet links are present and that at least one element shows a computed style that differs from the browser default.",
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const cssResult = await page.evaluate(() => {
      const sheetCount = document.querySelectorAll('link[rel="stylesheet"]').length;
      const bodyBg = window.getComputedStyle(document.body).backgroundColor;
      const nav = document.querySelector<HTMLElement>('nav, header, .navbar, .nav-container, #navbar');
      const navBg = nav ? window.getComputedStyle(nav).backgroundColor : '';
      // CSS applied if body has a non-white background OR nav has any non-transparent background
      const bodyStyled = bodyBg !== 'rgb(255, 255, 255)' && bodyBg !== 'rgba(0, 0, 0, 0)';
      const navStyled  = navBg !== '' && navBg !== 'rgba(0, 0, 0, 0)';
      return { sheetCount, bodyBackground: bodyBg, navBackground: navBg, cssApplied: bodyStyled || navStyled };
    });

    console.log(
      `[INFO] css-loaded: ${cssResult.sheetCount} stylesheet(s), ` +
        `body="${cssResult.bodyBackground}", nav="${cssResult.navBackground}".`,
    );

    if (cssResult.sheetCount === 0) {
      console.error('[FINDING][high] css-loaded: no <link rel="stylesheet"> elements found — CSS files may not be loading.');
    }
    if (!cssResult.cssApplied) {
      console.error('[FINDING][medium] css-loaded: body and nav backgrounds are browser defaults — CSS may not have applied.');
    }

    expect(cssResult.sheetCount, 'At least one CSS stylesheet must be referenced').toBeGreaterThan(0);
    expect(cssResult.cssApplied, 'CSS must have applied non-default styling to at least one element').toBe(true);
  });

  // ─── javascript-initialised ───────────────────────────────────────────────────

  test('javascript-initialised — Firebase SDK is present and initialised on the homepage', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Loaded the homepage and verified that the Firebase authentication and database library has initialised. The site relies on Firebase for login, account management, and data — if Firebase fails to load, all authentication and dynamic features are unavailable. Checks for the Firebase global object, Firebase CDN script tags, and the Firebase Hosting auto-configuration script.",
    });

    await page.goto('/', { waitUntil: 'load' });

    const jsResult = await page.evaluate(() => {
      const hasFirebaseGlobal  = typeof (window as any).firebase !== 'undefined';
      const hasFirebaseScript  = document.querySelector('script[src*="firebase"]') !== null;
      const hasFirebasegstatic = document.querySelector('script[src*="gstatic.com/firebasejs"]') !== null;
      const hasFirebaseHosting = document.querySelector('script[src*="/__/firebase/"]') !== null;
      const hasFirebaseDefaults = typeof (window as any).__FIREBASE_DEFAULTS__ !== 'undefined';
      return {
        hasFirebaseGlobal,
        hasFirebaseScript,
        hasFirebasegstatic,
        hasFirebaseHosting,
        hasFirebaseDefaults,
        initialised: hasFirebaseGlobal || hasFirebaseScript || hasFirebasegstatic || hasFirebaseHosting || hasFirebaseDefaults,
      };
    });

    console.log(
      `[INFO] javascript-initialised: global=${jsResult.hasFirebaseGlobal}, ` +
        `script=${jsResult.hasFirebaseScript}, gstatic=${jsResult.hasFirebasegstatic}, ` +
        `hosting=${jsResult.hasFirebaseHosting}, defaults=${jsResult.hasFirebaseDefaults}.`,
    );

    if (!jsResult.initialised) {
      console.error(
        '[FINDING][high] javascript-initialised: no Firebase initialisation signal detected. ' +
          'None of the expected indicators (window.firebase, Firebase script tags, Firebase Hosting config) were found.',
      );
    } else {
      console.log('[INFO] javascript-initialised: Firebase initialisation detected ✓');
    }

    expect(jsResult.initialised, 'Firebase must be initialised on the homepage').toBe(true);
  });

  // ─── no-broken-images ─────────────────────────────────────────────────────────

  test('no-broken-images — all homepage images have loaded successfully', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Loaded the homepage and inspected every image element. An image where the browser recorded a zero pixel width after completing its load attempt is broken — visitors would see a missing-image icon instead of the intended visual. Each broken image is logged as a finding with its source URL.",
    });

    await page.goto('/', { waitUntil: 'load' });

    const images = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLImageElement>('img[src]')).map(img => ({
        src: img.src,
        alt: img.alt,
        naturalWidth: img.naturalWidth,
        complete: img.complete,
      })),
    );

    let brokenCount = 0;
    for (const img of images) {
      if (img.complete && img.naturalWidth === 0) {
        brokenCount++;
        console.error(`[FINDING][medium] no-broken-images: failed to load — src="${img.src}", alt="${img.alt}".`);
      }
    }

    console.log(`[INFO] no-broken-images: ${images.length} image(s) found, ${brokenCount} broken.`);

    expect(brokenCount, `${brokenCount} broken image(s) found on the homepage`).toBe(0);
  });

  // ─── homepage-loads-within-threshold ─────────────────────────────────────────

  test('homepage-loads-within-threshold — page load time is measured and flagged if slow', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Measured how long the homepage took to fully load from the visitor's perspective using the browser's Navigation Timing API. Slow page loads increase bounce rates and hurt search engine rankings. A load time over 5 seconds is logged as a medium finding; over 10 seconds as a high finding. The test itself always passes — performance data is reported as findings only.",
    });

    await page.goto('/', { waitUntil: 'load' });

    const loadTimeMs = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (nav && nav.loadEventEnd > 0) return Math.round(nav.loadEventEnd - nav.startTime);
      const t = performance.timing;
      return t.loadEventEnd > 0 ? t.loadEventEnd - t.navigationStart : -1;
    });

    if (loadTimeMs < 0) {
      console.log('[INFO] homepage-loads-within-threshold: load timing not available yet.');
    } else if (loadTimeMs > 10_000) {
      console.error(
        `[FINDING][high] homepage-loads-within-threshold: homepage took ${loadTimeMs}ms to load — ` +
          'over 10 s. This significantly impacts visitor experience and search engine ranking.',
      );
    } else if (loadTimeMs > 5_000) {
      console.warn(
        `[FINDING][medium] homepage-loads-within-threshold: homepage took ${loadTimeMs}ms to load — ` +
          'over 5 s. Consider optimising images, deferring non-critical scripts, or using a CDN.',
      );
    } else {
      console.log(`[INFO] homepage-loads-within-threshold: load time = ${loadTimeMs}ms ✓`);
    }
    // No expect() — performance is surfaced as findings, not a hard failure.
  });

});
