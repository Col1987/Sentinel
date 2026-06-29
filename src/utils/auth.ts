import { type Page } from '@playwright/test';

// Requires ADMIN_EMAIL and ADMIN_PASSWORD in .env (Playwright loads .env automatically).
// Admin accounts are redirected to /admin.html by Firebase custom claim check on login.

export async function loginAsAdmin(page: Page): Promise<void> {
  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env to run admin tests.\n' +
        'Add to .env in the project root:\n' +
        '  ADMIN_EMAIL=your-admin@email.com\n' +
        '  ADMIN_PASSWORD=your-password',
    );
  }

  await page.goto('/');
  await page.locator('#btn-login').click();
  await page.locator('#login-email').waitFor({ state: 'visible' });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.locator('button[type="submit"]:has-text("Login")').click();

  // timeout: 0 means "no cap on this function" — Playwright waits indefinitely until the
  // predicate returns true. The calling test's own timeout (60 s normally, 180 s with
  // test.slow()) is the only gate. This avoids a double-timeout where a Playwright default
  // (30 s) fires before the test budget runs out and produces a misleading error message.
  await page.waitForFunction(() => {
    // Signal 1: redirected to the admin page
    const onAdminPage = window.location.pathname.includes('admin');
    if (!onAdminPage) return false;

    // Guard: the URL changes to admin.html mid-navigation (before the page's load event
    // fires). At that point admin.html's scripts have not run yet, so getElementById
    // returns null — without this guard we would exit immediately and the test would
    // proceed before the dashboard has rendered.
    if (document.readyState !== 'complete') return false;

    // Signal 2: auth overlay gone (Firebase admin claim resolved and UI updated)
    const overlay = document.getElementById('admin-auth-overlay');
    if (!overlay) return true; // no overlay = access is unrestricted
    // offsetParent is always null for position:fixed elements — use getComputedStyle.
    const style = window.getComputedStyle(overlay);
    return (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      overlay.classList.contains('hidden')
    );
  }, { timeout: 0 });
}
