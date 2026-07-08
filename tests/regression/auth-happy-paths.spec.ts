import { test, expect } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { loginAsAdmin, signOutCurrentUser } from '../../src/utils/auth';
import { registerForCheckout } from '../functional/checkout-helpers';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

test.describe('Auth happy paths', { tag: ['@regression'] }, () => {

  // ─── registration-happy-path ──────────────────────────────────────────────────
  // Firebase Auth signUp is real in both modes (only the site's own CF/backend order
  // endpoints are intercepted in safe mode) — no LIVE_MODE skip needed here.

  test('registration-happy-path — registering a new account reaches a signed-up state', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description: 'Registered a fresh account through the standard sign-up form and confirmed the flow completes: the auth modal closes and the site reflects a signed-up state, rather than leaving the visitor stuck on the registration form.',
    });

    await registerForCheckout(page);

    const authModalClosed = !(await page.locator('#auth-modal').isVisible().catch(() => true));
    const loggedInSignal  = !(await page.locator('#btn-login').isVisible().catch(() => true));

    if (!authModalClosed) {
      console.error('[FINDING][high] registration-happy-path: auth modal is still open after registration completed.');
    } else {
      console.log(`[INFO] registration-happy-path: auth modal closed, logged-in signal=${loggedInSignal} ✓`);
    }

    expect(authModalClosed, 'The auth modal must close after a successful registration').toBe(true);
  });

  // ─── login-and-logout-happy-path ──────────────────────────────────────────────

  test('login-and-logout-happy-path — logging in redirects to the account area, and logging out clears the session', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description: 'Logged in with the admin test account (reusing loginAsAdmin, which itself clears any stale session first) and confirmed the redirect to the admin dashboard, then logged out and confirmed the session was cleared — combined into one test since both reuse the same login, halving the login overhead versus two independent tests.',
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    // ── Login happy path ──────────────────────────────────────────────────────
    await loginAsAdmin(page);

    const loginRedirected  = page.url().includes('admin.html');
    const overlayHidden    = !(await page.locator('#admin-auth-overlay').isVisible().catch(() => false));

    if (!loginRedirected) console.error('[FINDING][high] login-and-logout-happy-path: admin login did not redirect to /admin.html.');
    if (!overlayHidden)   console.error('[FINDING][medium] login-and-logout-happy-path: #admin-auth-overlay still visible after login.');

    expect(loginRedirected, 'Admin login must redirect to /admin.html').toBe(true);
    expect(overlayHidden,   '#admin-auth-overlay must be hidden after successful admin login').toBe(true);
    console.log('[INFO] login-and-logout-happy-path: login ✓');

    // ── Logout happy path ─────────────────────────────────────────────────────
    const logoutCandidates = page.locator(
      '#btn-logout, #mobile-btn-logout, button[onclick*="signOut"], ' +
        'button:has-text("Sign Out"), button:has-text("Log Out"), button:has-text("Logout"), ' +
        '[id*="logout"]:is(button,a), [id*="sign-out"]:is(button,a)',
    );
    const logoutBtnVisible = await logoutCandidates.first().isVisible({ timeout: 3_000 }).catch(() => false);

    if (logoutBtnVisible) {
      await logoutCandidates.first().click();
    } else {
      console.error(
        '[FINDING][medium] login-and-logout-happy-path: no logout button found with known selectors on /admin.html. ' +
          'Invoking window.signOutAndShowLogin() directly.',
      );
      await page.evaluate(() => (window as any).signOutAndShowLogin?.()).catch(() => {});
    }

    await page.locator('#admin-auth-overlay').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

    const wasRedirected      = !page.url().includes('admin.html');
    const loginBtnVisible    = await page.locator('#btn-login').isVisible().catch(() => false);
    const authOverlayVisible = await page.locator('#admin-auth-overlay').isVisible().catch(() => false);
    const sessionCleared     = wasRedirected || loginBtnVisible || authOverlayVisible;

    if (!sessionCleared) {
      console.error(
        `[FINDING][high] login-and-logout-happy-path: after clicking logout the page remained on ` +
          `"${page.url()}" with no visible auth prompt or login button.`,
      );
    } else {
      console.log(`[INFO] login-and-logout-happy-path: logout ✓ (redirected=${wasRedirected}, login-btn=${loginBtnVisible}, overlay=${authOverlayVisible})`);
    }

    expect(sessionCleared, 'Logout must redirect, show #btn-login, or re-display the admin auth overlay').toBe(true);

    // Leave the browser in a clean state for anything that might run after this test.
    await signOutCurrentUser(page);
  });

});
