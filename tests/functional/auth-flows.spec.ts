import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../../src/utils/auth';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN  = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';
const SIGN_IN_URL = '**/accounts:signInWithPassword**';

// Firebase error payload for an INVALID_PASSWORD response (HTTP 400).
// Used in safe mode so no real Firebase call is made for the error-message test.
const FIREBASE_WRONG_PW_BODY = JSON.stringify({
  error: {
    code: 400,
    message: 'INVALID_PASSWORD',
    errors: [{ message: 'INVALID_PASSWORD', domain: 'global', reason: 'invalid' }],
  },
});

// Fail the test and log a finding when a UI element known from site discovery is absent.
async function requireVisible(
  page: import('@playwright/test').Page,
  selector: string,
  pageName: string,
): Promise<void> {
  const visible = await page.locator(selector).isVisible({ timeout: 5_000 }).catch(() => false);
  if (!visible) {
    console.error(`[FINDING][medium] Expected element "${selector}" not found on ${pageName}`);
    expect(visible, `[FINDING][medium] Expected element "${selector}" not found on ${pageName}`).toBe(true);
  }
}

test.describe('Auth flows', { tag: ['@functional'] }, () => {

  // ─── login-wrong-password-generic-error ──────────────────────────────────────

  test('login-wrong-password-generic-error — wrong password shows a generic error, not which credential is wrong', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Opened the login modal and submitted a valid email address with a wrong password. In safe mode the Firebase sign-in endpoint was intercepted and returned an INVALID_PASSWORD error without hitting real servers. The visible error message was then inspected to confirm it is generic ('Invalid email or password' or similar) rather than revealing whether the email exists as a registered account. Separate error messages for 'email not found' vs 'wrong password' allow attackers to enumerate valid accounts.",
    });

    if (LIVE_MODE) test.slow();

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
      await page.route(SIGN_IN_URL, route =>
        route.fulfill({ status: 400, contentType: 'application/json', body: FIREBASE_WRONG_PW_BODY }),
      );
    }

    await page.goto('/');

    await requireVisible(page, '#btn-login', '/');
    await page.locator('#btn-login').click();
    await requireVisible(page, '#login-email', '/ (login modal)');
    await requireVisible(page, '#login-password', '/ (login modal)');

    // In LIVE_MODE use a clearly synthetic address that cannot exist.
    const testEmail = LIVE_MODE
      ? 'sentinel-probe@nonexistent-domain-999.com'
      : (process.env.ADMIN_EMAIL ?? 'test@example.com');

    await page.locator('#login-email').fill(testEmail);
    await page.locator('#login-password').fill('WrongPassword!Sentinel999');
    await page.locator('button[type="submit"]:has-text("Login")').click();

    // Wait for the site's error message to appear inside the auth modal.
    await page.waitForFunction(
      () => {
        const modal = document.querySelector('#auth-modal');
        if (!modal) return false;
        const text = (modal.textContent ?? '').toLowerCase();
        return (
          text.includes('invalid') ||
          text.includes('incorrect') ||
          text.includes('wrong') ||
          text.includes('error') ||
          text.includes('failed') ||
          text.includes('not found')
        );
      },
      { timeout: 10_000 },
    ).catch(() => {});

    const modalText = (await page.locator('#auth-modal').textContent().catch(() => ''))?.toLowerCase() ?? '';

    // Any of these phrases reveal which specific credential is wrong and enable account enumeration.
    const ENUMERATION_SIGNALS = [
      'user not found',
      'email not found',
      'no user',
      'account not found',
      'no account',
      'email does not exist',
      'user does not exist',
      'password is incorrect',
      'password is wrong',
      'wrong password',
    ];

    const leaksEnumeration = ENUMERATION_SIGNALS.some(s => modalText.includes(s));

    if (leaksEnumeration) {
      const match = ENUMERATION_SIGNALS.find(s => modalText.includes(s))!;
      console.error(
        `[FINDING][high] login-wrong-password-generic-error: error message contains "${match}". ` +
          'Separate error messages for wrong email vs wrong password let attackers enumerate valid accounts. ' +
          'Replace with a single generic phrase such as "Invalid email or password".',
      );
    } else if (modalText.trim().length > 0) {
      console.log('[INFO] login-wrong-password-generic-error: error message is generic — no enumeration signal detected ✓');
    } else {
      console.warn(
        '[FINDING][low] login-wrong-password-generic-error: no visible error message appeared after a failed login. ' +
          'The user must be informed that their credentials were incorrect.',
      );
    }

    expect(leaksEnumeration, 'Error message for wrong credentials must not reveal whether the email address exists').toBe(false);
  });

  // ─── logout-clears-session ────────────────────────────────────────────────────

  test('logout-clears-session — clicking logout redirects to the homepage and hides account nav controls', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin using the authentication helper, then clicked the logout button. Verified that the session ended correctly: the page returned to the homepage (or a logged-out state), the 'My Account' navigation link was hidden, and the login button was visible again. A logout that does not properly clear the Firebase session would leave the account accessible until the browser is closed.",
    });

    test.slow();

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    // Try common logout button patterns — the exact ID is unknown.
    const logoutCandidates = page.locator(
      '#btn-logout, #mobile-btn-logout, button[onclick*="signOut"], ' +
        'button:has-text("Sign Out"), button:has-text("Log Out"), button:has-text("Logout"), ' +
        '[id*="logout"]:is(button,a), [id*="sign-out"]:is(button,a)',
    );

    const logoutBtnVisible = await logoutCandidates.first().isVisible({ timeout: 3_000 }).catch(() => false);

    if (logoutBtnVisible) {
      const matchedSelector = await logoutCandidates.first().evaluate(el => el.id || el.textContent?.trim() || 'unknown').catch(() => 'unknown');
      console.log(`[INFO] logout-clears-session: clicking logout button ("${matchedSelector}").`);
      await logoutCandidates.first().click();
    } else {
      // No recognisable logout button found — invoke the global signOut function directly
      // and log a finding so the missing UI element is tracked.
      console.error(
        '[FINDING][medium] logout-clears-session: no logout button found with known selectors on /admin.html. ' +
          'Invoking window.signOutAndShowLogin() directly. Add a clearly-labelled logout button with a stable ID.',
      );
      await page.evaluate(() => (window as any).signOutAndShowLogin?.()).catch(() => {});
    }

    // Firebase signOut() is client-side. The admin page re-shows #admin-auth-overlay
    // rather than navigating away. Wait for any of: redirect, #btn-login, or auth overlay.
    await page.locator('#admin-auth-overlay').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

    const finalUrl           = page.url();
    const wasRedirected      = !finalUrl.includes('admin.html');
    const loginBtnVisible    = await page.locator('#btn-login').isVisible().catch(() => false);
    const authOverlayVisible = await page.locator('#admin-auth-overlay').isVisible().catch(() => false);

    if (!wasRedirected && !loginBtnVisible && !authOverlayVisible) {
      console.error(
        '[FINDING][high] logout-clears-session: after clicking logout the page remained on ' +
          `"${finalUrl}" with no visible auth prompt or login button. The session may not have been terminated.`,
      );
    } else {
      console.log(
        `[INFO] logout-clears-session: redirected="${wasRedirected}", ` +
          `login-btn-visible="${loginBtnVisible}", auth-overlay-visible="${authOverlayVisible}" ✓`,
      );
    }

    const navAccountVisible = await page.locator('#nav-account').isVisible().catch(() => false);
    if (navAccountVisible) {
      console.warn(
        '[FINDING][medium] logout-clears-session: #nav-account is still visible after logout. ' +
          'Authenticated-only nav links must be hidden when the user is logged out.',
      );
    }

    expect(
      wasRedirected || loginBtnVisible || authOverlayVisible,
      'Logout must redirect, show #btn-login, or re-display the admin auth overlay',
    ).toBe(true);
    expect(navAccountVisible, '#nav-account must be hidden after logout').toBe(false);
  });

  // ─── admin-redirect-on-login ──────────────────────────────────────────────────

  test('admin-redirect-on-login — admin credentials trigger an automatic redirect to /admin.html', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in using admin credentials and verified that the site automatically redirected to the admin dashboard (/admin.html) without any manual navigation. The redirect is driven by a Firebase custom claim check — if the claim is missing or the client-side check is broken, admin users would land on the standard homepage instead of the dashboard.",
    });

    test.slow();

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    const finalUrl = page.url();
    expect(finalUrl, 'Admin login must redirect to /admin.html').toContain('admin.html');

    const overlayHidden = !(await page.locator('#admin-auth-overlay').isVisible().catch(() => false));
    if (!overlayHidden) {
      console.error(
        '[FINDING][medium] Expected element "#admin-auth-overlay" to be hidden on /admin.html after admin login. ' +
          'The overlay persisted, indicating the admin claim check may have stalled.',
      );
    }
    expect(overlayHidden, '#admin-auth-overlay must be hidden after successful admin login').toBe(true);

    console.log(`[INFO] admin-redirect-on-login: redirected to "${finalUrl}", auth overlay hidden ✓`);
  });

});
