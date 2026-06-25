import { test, expect } from '@playwright/test';
import { runJourney } from '../../src/runners/journey-runner';
import { journeys } from '../../src/config/journeys';

const find = (id: string) => journeys.find(j => j.id === id)!;

const navPlatform     = find('nav-platform-link');
const navHowItWorks   = find('nav-how-it-works-link');
const navWelcomePacks = find('nav-welcome-packs-link');
const navLogoHome     = find('nav-logo-home');

test.describe('Navigation', { tag: ['@functional'] }, () => {

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

});
