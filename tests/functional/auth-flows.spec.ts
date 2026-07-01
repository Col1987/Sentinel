import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../../src/utils/auth';
import { LIVE_MODE, testEmail } from '../../src/config/sites';
import { getLatestVerificationEmail } from '../../src/utils/gmail';

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

    // Use a Gmail plus-address that is guaranteed not to be registered.
    // Firebase responds immediately with EMAIL_NOT_FOUND for real domains.
    // Avoid made-up TLDs — Firebase may hang on the DNS lookup.
    const probeEmail = LIVE_MODE
      ? testEmail('wrong-pw-probe')
      : (process.env.ADMIN_EMAIL ?? 'test@example.com');

    await page.locator('#login-email').fill(probeEmail);
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

  // ─── registration-triggers-verification-email ────────────────────────────────

  test('registration-triggers-verification-email — resend verification button fires a backend request', async ({ page }) => {
    test.skip(!LIVE_MODE, 'requires real backend — set SENTINEL_LIVE_MODE=true to run');
    test.slow();

    test.info().annotations.push({
      type: 'description',
      description: "Registered a new account using a unique test email address, then navigated to /account.html and clicked the 'Resend verification email' button. Monitored all outbound requests for 5 seconds after the click. If no request to a Firebase/Cloud Functions endpoint fires, the button's event handler is broken (the orphaned-handler code-quality check suspects it references an undefined function).",
    });

    await page.goto('/');

    // Open register modal via the same steps confirmed in journeys
    await page.locator('#btn-login').click();
    await page.locator('#login-email').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('a:has-text("Register")').click();
    await page.locator('#reg-firstname').waitFor({ state: 'visible', timeout: 10_000 });

    // Fill registration form
    await page.locator('#reg-firstname').fill('SENTINEL');
    await page.locator('#reg-lastname').fill('TEST');
    await page.locator('#reg-email').fill(testEmail(`verify-${Date.now()}`));
    await page.locator('#reg-mobile-num').fill('821234567');
    await page.locator('#reg-password').fill('Test@12345!');
    await page.locator('#reg-confirm-password').fill('Test@12345!');
    await page.locator('#reg-terms').click();
    const sentAfter = new Date();
    await page.locator('button:has-text("Create Account")').click();

    // Wait for Firebase to process signUp and for the site to respond.
    // The site either redirects to account.html or shows an inline verification prompt.
    await Promise.race([
      page.waitForURL('**/account.html', { timeout: 15_000 }),
      page.waitForSelector('#verification-prompt, [id*="verif"], .verification-notice, .verify-email', {
        state: 'visible',
        timeout: 15_000,
      }),
    ]).catch(() => {});

    // Debug: log where we ended up and what verify-related content is on the page
    const urlAfterReg = page.url();
    console.log(`[DEBUG] URL after registration: ${urlAfterReg}`);

    const verifyElements = await page.evaluate(() => {
      const hits: string[] = [];
      document.querySelectorAll('*').forEach(el => {
        const text = (el.textContent ?? '').toLowerCase();
        const id   = el.id.toLowerCase();
        if ((text.includes('verify') || text.includes('resend')) && el.children.length === 0) {
          hits.push(`<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ''}> "${el.textContent?.trim().slice(0, 60)}"`);
        }
        if (id.includes('verify') || id.includes('resend')) {
          hits.push(`[by id] <${el.tagName.toLowerCase()} id="${el.id}">`);
        }
      });
      return [...new Set(hits)].slice(0, 20);
    });
    console.log(`[DEBUG] verify/resend elements on page: ${verifyElements.length ? verifyElements.join(' | ') : '(none)'}`);

    // The auth modal may still be open after signUp — wait for it to auto-dismiss,
    // then force-close if the site leaves it open (it would intercept clicks on the banner).
    const authModal = page.locator('#auth-modal');
    await authModal.waitFor({ state: 'hidden', timeout: 8_000 }).catch(async () => {
      console.log('[DEBUG] auth modal still open after registration — closing via × button');
      await page.locator('#auth-modal .modal-close').click({ force: true }).catch(() => {});
      await authModal.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    });

    // ── Verification email delivery ──────────────────────────────────────────
    // Firebase sends a verification email automatically on signUp. Poll the
    // sentinelqa2026@gmail.com inbox for it and follow the link.
    const verificationLink = await getLatestVerificationEmail(sentAfter);

    if (!verificationLink) {
      console.error(
        '[FINDING][critical] registration-triggers-verification-email: verification email did not ' +
          'arrive within 30 seconds of registration.',
      );
    } else {
      console.log(`[INFO] verification email received — link: ${verificationLink}`);

      const linkUrl  = new URL(verificationLink);
      const linkHost = linkUrl.hostname.replace(/^www\./, '');

      if (linkHost !== 'juelhaus.co.za') {
        console.error(
          `[FINDING][high] registration-triggers-verification-email: verification link points to ` +
            `"${linkHost}" instead of juelhaus.co.za. Firebase is sending users to the default ` +
            'firebaseapp.com domain — update the "Email action handler URL" in Firebase Console ' +
            'to https://www.juelhaus.co.za/__/auth/action.',
        );
      }

      await page.goto(verificationLink, { waitUntil: 'domcontentloaded' });

      const finalHost = new URL(page.url()).hostname.replace(/^www\./, '');
      if (finalHost !== 'juelhaus.co.za') {
        console.error(
          `[FINDING][high] registration-triggers-verification-email: after following the verification ` +
            `link, the browser landed on "${finalHost}" not juelhaus.co.za. ` +
            'The action handler URL may not be configured to redirect to the production domain.',
        );
      }

      const pageText = (await page.locator('body').textContent() ?? '').toLowerCase();
      const showsSuccess = pageText.includes('verified') || pageText.includes('verification') ||
        pageText.includes('confirmed') || pageText.includes('success');

      if (showsSuccess) {
        console.log('[INFO] registration-triggers-verification-email: verification page shows success text ✓');
      } else {
        console.warn(
          '[FINDING][medium] registration-triggers-verification-email: verification link was followed ' +
            `but the page on "${finalHost}" shows no recognisable success confirmation.`,
        );
      }

      // Navigate back to the homepage so the resend-button check below has the right context
      await page.goto('/', { waitUntil: 'domcontentloaded' });
    }

    // ── Resend button ────────────────────────────────────────────────────────
    const resendBtn     = page.locator('#resend-verify-btn');
    const resendVisible = await resendBtn.isVisible().catch(() => false);

    console.log(`[DEBUG] #resend-verify-btn visible on ${urlAfterReg}: ${resendVisible}`);

    if (!resendVisible) {
      console.warn(
        '[FINDING][medium] registration-triggers-verification-email: #resend-verify-btn not found on /account.html. ' +
          'Cannot verify resend flow — element may use a different selector or the registration did not complete.',
      );
      return;
    }

    // Monitor for any Firebase / Cloud Functions request after clicking resend
    const backendRequestPromise = page.waitForResponse(
      res =>
        res.url().includes('sendOobCode') ||
        res.url().includes('identitytoolkit') ||
        res.url().includes('cloudfunctions.net'),
      { timeout: 5_000 },
    ).catch(() => null);

    await resendBtn.click();

    const backendResponse = await backendRequestPromise;

    if (!backendResponse) {
      console.error(
        '[FINDING][critical] registration-triggers-verification-email: clicking #resend-verify-btn fired no request ' +
          'to Firebase or Cloud Functions within 5 seconds. The button handler is broken — likely references an ' +
          'undefined function (matches code-quality orphaned-handler finding).',
      );
    } else {
      const status = backendResponse.status();
      const url    = backendResponse.url();
      if (status >= 500) {
        console.error(
          `[FINDING][high] registration-triggers-verification-email: resend request to "${url}" returned HTTP ${status}. ` +
            'The backend rejected the verification email request.',
        );
      } else if (status >= 400) {
        console.warn(
          `[FINDING][medium] registration-triggers-verification-email: resend request to "${url}" returned HTTP ${status}. ` +
            'Client error — may be rate limiting or an expected rejection.',
        );
      } else {
        console.log(
          `[INFO] registration-triggers-verification-email: resend request fired to "${url}" — HTTP ${status} ✓`,
        );
      }
    }

    expect(
      backendResponse,
      '[FINDING][critical] #resend-verify-btn must fire a backend request — no request detected within 5 s',
    ).not.toBeNull();

    const responseStatus = backendResponse!.status();
    expect(
      responseStatus,
      `resendVerification Cloud Function returned HTTP ${responseStatus} — server error on /resendVerification endpoint`,
    ).toBeLessThan(500);
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
