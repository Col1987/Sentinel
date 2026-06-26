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

  // Firebase sets the admin custom claim, then the client JS redirects to /admin.html.
  // Allow up to 20 s for the auth round-trip + redirect.
  await page.waitForURL('**/admin.html', { timeout: 20_000 });

  // #admin-auth-overlay covers the dashboard while Firebase resolves the admin claim.
  // Waiting for it to disappear is deterministic; the old fixed 2.5s delay was a race
  // condition that could fire before auth completed on slow CI machines.
  await page.locator('#admin-auth-overlay').waitFor({ state: 'hidden', timeout: 15_000 });
}
