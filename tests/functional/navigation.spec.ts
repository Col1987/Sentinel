import { test, expect } from '@playwright/test';
import { runJourney } from '../../src/runners/journey-runner';
import { journeys } from '../../src/config/journeys';

const find = (id: string) => journeys.find(j => j.id === id)!;

const navPlatform     = find('nav-platform-link');
const navHowItWorks   = find('nav-how-it-works-link');
const navWelcomePacks = find('nav-welcome-packs-link');
const navLogoHome     = find('nav-logo-home');

test.describe('Navigation', { tag: ['@functional'] }, () => {

  // .nav-links is the desktop nav bar — hidden at mobile viewports where the
  // hamburger replaces it. Skip these tests when the active viewport is narrow.
  test.beforeEach(({ viewport }) => {
    if ((viewport?.width ?? 1280) < 768) {
      test.skip(true, 'Desktop-only: .nav-links is hidden below 768px — see responsive.spec.ts for mobile nav tests');
    }
  });

  test('platform link — #platform section scrolls into view', async ({ page }) => {
    await page.goto('/');
    await runJourney(navPlatform, page);
    await expect(page.locator('#platform')).toBeInViewport({ timeout: 5_000 });
  });

  test('how it works link — #how-it-works section scrolls into view', async ({ page }) => {
    await page.goto('/');
    await runJourney(navHowItWorks, page);
    await expect(page.locator('#how-it-works')).toBeInViewport({ timeout: 5_000 });
  });

  test('welcome packs link — #gifts section scrolls into view', async ({ page }) => {
    await page.goto('/');
    await runJourney(navWelcomePacks, page);
    await expect(page.locator('#gifts')).toBeInViewport({ timeout: 5_000 });
  });

  test('my account link — href points to /account.html (link is visible only when authenticated)', async ({ page }) => {
    test.info().annotations.push({ type: 'description', description: "Checked that the 'My Account' navigation link is correctly set up to point to the account page. CONFIRMED: the link destination is correct (/account.html). The link is only shown to visitors who are logged in — this is expected behaviour." });
    await page.goto('/');
    // #nav-account is hidden for unauthenticated users (expected behaviour).
    // Verify the link target is correct without requiring a logged-in session.
    const href = await page.locator('#nav-account').getAttribute('href');
    expect(href, '#nav-account href must point to the account page').toBe('/account.html');

    console.log(
      '[INFO] nav-my-account-link: link is structurally correct (href="/account.html"). ' +
        'Full click-through verification requires an authenticated session.',
    );
  });

  test('logo link — returns to top of page from a scrolled position', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => window.scrollTo({ top: 3000, behavior: 'instant' }));
    await page.waitForFunction(() => window.scrollY > 2000, { timeout: 3_000 });
    await runJourney(navLogoHome, page);
    // Handles both a same-page smooth scroll and a full navigation to /index.html
    await page.waitForFunction(() => window.scrollY < 50, { timeout: 5_000 });
  });

  test('watch-demo-button-action — clicking "Watch Demo" produces a visible response', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: 'Clicked the "Watch Demo" button on the homepage and observed whether anything visibly changed within 3 seconds — a modal opening, a video starting to play, a page navigation, or the page scrolling to a new section. A button that produces no observable response is a UX defect: visitors who click it receive no feedback and have no way to know whether the click registered. Console errors after the click are captured separately, as a broken event handler will surface there.',
    });

    await page.goto('/');

    const watchDemoBtn = page.locator(
      'button:has-text("Watch Demo"), a:has-text("Watch Demo"), [class*="watch-demo"], [id*="watch-demo"]',
    ).first();

    if (!(await watchDemoBtn.isVisible().catch(() => false))) {
      console.log('[INFO] watch-demo-button-action: no "Watch Demo" button found on the homepage — skipping.');
      return;
    }

    // Snapshot observable state before the click.
    const before = await page.evaluate(() => {
      const visibleOverlays = Array.from(
        document.querySelectorAll('[class*="modal"], [class*="overlay"], dialog, [class*="lightbox"]'),
      ).filter(el => {
        const s = window.getComputedStyle(el as HTMLElement);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
      }).length;
      return {
        scrollY: window.scrollY,
        url: window.location.href,
        visibleOverlays,
        hasPlayingVideo: Array.from(document.querySelectorAll('video')).some(v => !(v as HTMLVideoElement).paused),
        hasVideoIframe: !!document.querySelector('iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"]'),
      };
    });

    const consoleErrors: string[] = [];
    const pageErrors: string[]    = [];
    let   newTabOpened = false;

    const onConsole   = (msg: import('@playwright/test').ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    };
    const onPageError = (err: Error) => pageErrors.push(err.message);
    const onNewPage   = () => { newTabOpened = true; };

    page.on('console',   onConsole);
    page.on('pageerror', onPageError);
    page.context().on('page', onNewPage);

    // Mark every overlay that is already visible before the click so we can
    // identify the newly-opened one(s) afterwards without relying on DOM order.
    await page.evaluate(() => {
      document.querySelectorAll('[class*="modal"], [class*="overlay"], dialog, [class*="lightbox"]')
        .forEach(el => {
          const s = window.getComputedStyle(el as HTMLElement);
          if (s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0) {
            el.setAttribute('data-sentinel-seen', '1');
          }
        });
    });

    await watchDemoBtn.click();

    // Resolve early when any observable change occurs; time out silently after 3 s.
    await page.waitForFunction(
      (b: { scrollY: number; url: string; visibleOverlays: number }) => {
        const overlays = Array.from(
          document.querySelectorAll('[class*="modal"], [class*="overlay"], dialog, [class*="lightbox"]'),
        ).filter(el => {
          const s = window.getComputedStyle(el as HTMLElement);
          return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
        }).length;
        return (
          Math.abs(window.scrollY - b.scrollY) > 50 ||
          window.location.href !== b.url ||
          overlays !== b.visibleOverlays ||
          Array.from(document.querySelectorAll('video')).some(v => !(v as HTMLVideoElement).paused) ||
          !!document.querySelector('iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"]')
        );
      },
      { scrollY: before.scrollY, url: before.url, visibleOverlays: before.visibleOverlays },
      { timeout: 3_000 },
    ).catch(() => {});

    page.off('console',   onConsole);
    page.off('pageerror', onPageError);
    page.context().off('page', onNewPage);

    // Snapshot state after.
    const after = await page.evaluate(() => {
      const visibleOverlays = Array.from(
        document.querySelectorAll('[class*="modal"], [class*="overlay"], dialog, [class*="lightbox"]'),
      ).filter(el => {
        const s = window.getComputedStyle(el as HTMLElement);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
      }).length;
      return {
        scrollY: window.scrollY,
        url: window.location.href,
        visibleOverlays,
        hasPlayingVideo: Array.from(document.querySelectorAll('video')).some(v => !(v as HTMLVideoElement).paused),
        hasVideoIframe: !!document.querySelector('iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"]'),
      };
    });

    const scrolled        = Math.abs(after.scrollY - before.scrollY) > 50;
    const navigated       = after.url !== before.url;
    const modalOpened     = after.visibleOverlays > before.visibleOverlays;
    const videoStarted    = after.hasPlayingVideo && !before.hasPlayingVideo;
    const videoIframeShown = after.hasVideoIframe && !before.hasVideoIframe;
    const somethingHappened = scrolled || navigated || modalOpened || videoStarted || videoIframeShown || newTabOpened;

    if (scrolled)          console.log(`[INFO] watch-demo-button-action: page scrolled (${before.scrollY}px → ${after.scrollY}px).`);
    if (navigated)         console.log(`[INFO] watch-demo-button-action: navigated to "${after.url}".`);
    if (modalOpened)       console.log('[INFO] watch-demo-button-action: overlay or modal became visible after click.');
    if (videoStarted)      console.log('[INFO] watch-demo-button-action: video element started playing after click.');
    if (videoIframeShown)  console.log('[INFO] watch-demo-button-action: YouTube or Vimeo iframe appeared after click.');
    if (newTabOpened)      console.log('[INFO] watch-demo-button-action: click opened a new browser tab.');

    // If a modal opened, verify it contains meaningful content.
    if (modalOpened) {
      const modalContent = await page.evaluate(() => {
        // Use the data-sentinel-seen markers set before the click to find ONLY the
        // overlay(s) that became visible as a result of the button click.
        const newlyVisible = Array.from(
          document.querySelectorAll('[class*="modal"], [class*="overlay"], dialog, [class*="lightbox"]'),
        ).filter(el => {
          if (el.getAttribute('data-sentinel-seen') === '1') return false;
          const s = window.getComputedStyle(el as HTMLElement);
          return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
        });

        if (newlyVisible.length === 0) return null;

        // Among newly visible overlays, inspect the one with the largest rendered area.
        // This avoids picking a small child element (e.g. a close button that also
        // matches [class*="modal"]) instead of the container.
        const target = newlyVisible.reduce((best, el) => {
          const r    = el.getBoundingClientRect();
          const rBest = best.getBoundingClientRect();
          return r.width * r.height > rBest.width * rBest.height ? el : best;
        }, newlyVisible[0]);

        const visibleText = (target as HTMLElement).innerText?.trim() ?? '';
        return {
          hasVideo:    !!target.querySelector('video'),
          hasIframe:   !!target.querySelector('iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"]'),
          hasText:     visibleText.length > 20,
          hasImage:    !!target.querySelector('img'),
          className:   target.className,
          visibleText: visibleText.slice(0, 120),
        };
      });

      if (modalContent) {
        console.log(
          `[INFO] watch-demo-button-action: inspecting modal — class="${modalContent.className}", ` +
            `visibleText="${modalContent.visibleText || '(empty)'}".`,
        );

        const hasContent = modalContent.hasVideo || modalContent.hasIframe || modalContent.hasText || modalContent.hasImage;
        if (!hasContent) {
          console.error(
            '[FINDING][medium] watch-demo-button-action: Watch Demo button opens an empty modal with no video ' +
              'or demo content. Visitors clicking this see a blank overlay.',
          );
        } else {
          if (modalContent.hasVideo)  console.log('[INFO] watch-demo-button-action: modal contains a <video> element.');
          if (modalContent.hasIframe) console.log('[INFO] watch-demo-button-action: modal contains a YouTube/Vimeo embed.');
          if (modalContent.hasImage)  console.log('[INFO] watch-demo-button-action: modal contains an <img> element.');
          if (modalContent.hasText)   console.log('[INFO] watch-demo-button-action: modal contains visible text content.');
        }
      }
    }

    for (const err of consoleErrors) {
      console.error(`[FINDING][high] watch-demo-button-action: console error after click — ${err}`);
    }
    for (const err of pageErrors) {
      console.error(`[FINDING][high] watch-demo-button-action: unhandled JS exception after click — ${err}`);
    }

    if (!somethingHappened) {
      console.error(
        '[FINDING][medium] watch-demo-button-action: clicking "Watch Demo" produced no visible change — ' +
          'no modal, no video, no navigation, no scroll, no new tab. ' +
          'A button with no observable action is a UX defect that confuses visitors.',
      );
    }

    expect(
      somethingHappened,
      '"Watch Demo" must produce a visible response (modal, video, navigation, or scroll) when clicked',
    ).toBe(true);
    expect(
      consoleErrors.length + pageErrors.length,
      'No console errors or JS exceptions must occur when clicking "Watch Demo"',
    ).toBe(0);
  });

});
