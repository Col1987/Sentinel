import { test, expect } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { registerForCheckout } from './checkout-helpers';

// Must match the password set inside registerForCheckout
const REGISTER_PASSWORD = 'Test@12345!';

// ── Helpers ────────────────────────────────────────────────────────────────────

// Ensures the login modal is open and ready to accept credentials.
// Safe to call when the modal is already open — it becomes a no-op.
async function ensureLoginModalOpen(
  page: import('@playwright/test').Page,
): Promise<void> {
  const modalVisible = await page.locator('#auth-modal').isVisible().catch(() => false);
  if (!modalVisible) {
    await page.locator('#btn-login').click();
    await page.locator('#login-email').waitFor({ state: 'visible', timeout: 5_000 });
  }
}

// Submits the login form and waits for the Firebase signInWithPassword response.
// Returns the lowercased modal text after the response arrives.
async function submitAndWait(page: import('@playwright/test').Page): Promise<string> {
  const responsePromise = page.waitForResponse(
    res => res.url().includes('accounts:signInWithPassword'),
    { timeout: 12_000 },
  ).catch(() => null);

  await page.locator('button[type="submit"]:has-text("Login")').click();
  await responsePromise;
  await page.waitForTimeout(700);

  return ((await page.locator('#auth-modal').textContent().catch(() => '')) ?? '').toLowerCase();
}

// Returns true if the modal text contains a Firebase lockout phrase.
function isLockoutMessage(text: string): boolean {
  return (
    text.includes('too many') ||
    text.includes('blocked') ||
    text.includes('unusual activity') ||
    text.includes('temporarily disabled') ||
    text.includes('try again later') ||
    text.includes('access to this account')
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('Auth session security (LIVE_MODE only)', { tag: ['@functional'] }, () => {

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires real backend — set SENTINEL_LIVE_MODE=true to run');
  });

  // ── 1. Login lockout ──────────────────────────────────────────────────────

  test('login-lockout-after-failed-attempts — repeated wrong passwords should trigger brute-force protection', async ({ page, browser }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Registers a fresh test account, then opens a clean browser session and attempts to log ' +
        'in with the wrong password five times in a row. On the sixth attempt the correct password ' +
        'is used. If login still succeeds normally, brute-force protection is absent — an attacker ' +
        'can attempt unlimited password guesses against any account. If a lockout or rate-limit ' +
        'message appears, the protection is confirmed and the message text is recorded.',
    });

    // Register a fresh account so we have a known email + password pair.
    const email = await registerForCheckout(page);
    console.log(`[INFO] login-lockout-after-failed-attempts: registered test account ${email}`);

    // Open a clean context — no pre-existing auth state (simulates an attacker's browser).
    const lockoutCtx = await browser.newContext();
    const lockoutPage = await lockoutCtx.newPage();

    try {
      await lockoutPage.goto('/');
      await lockoutPage.locator('#btn-login').click();
      await lockoutPage.locator('#login-email').waitFor({ state: 'visible', timeout: 5_000 });

      // ── Five wrong-password attempts ──────────────────────────────────────
      for (let attempt = 1; attempt <= 5; attempt++) {
        await ensureLoginModalOpen(lockoutPage);
        await lockoutPage.locator('#login-email').fill(email);
        await lockoutPage.locator('#login-password').fill(`WrongPasswordSentinel${attempt}!`);

        const modalText = await submitAndWait(lockoutPage);

        if (isLockoutMessage(modalText)) {
          console.log(
            `[INFO] login-lockout-after-failed-attempts: lockout message appeared after ` +
              `attempt ${attempt}: "${modalText.slice(0, 200).trim()}" ✓`,
          );
          return; // protection confirmed — no need to continue
        }

        // Guard: a wrong password should never succeed — log critical if it does.
        const loginBtnGone = !await lockoutPage.locator('#btn-login').isVisible().catch(() => true);
        if (loginBtnGone) {
          console.error(
            `[FINDING][critical] login-lockout-after-failed-attempts: login SUCCEEDED on attempt ` +
              `${attempt} with an incorrect password. Authentication is fundamentally broken.`,
          );
          return;
        }

        console.log(`[INFO] login-lockout-after-failed-attempts: attempt ${attempt}/5 failed as expected`);
      }

      // ── Sixth attempt — correct password ──────────────────────────────────
      console.log('[INFO] login-lockout-after-failed-attempts: trying CORRECT password on attempt 6...');

      await ensureLoginModalOpen(lockoutPage);
      await lockoutPage.locator('#login-email').fill(email);
      await lockoutPage.locator('#login-password').fill(REGISTER_PASSWORD);

      const finalModalText = await submitAndWait(lockoutPage);
      await lockoutPage.waitForTimeout(1_500);

      const finalUrl       = lockoutPage.url();
      const lockedOut      = isLockoutMessage(finalModalText);
      const loginBtnVis    = await lockoutPage.locator('#btn-login').isVisible().catch(() => true);
      const loggedIn       = !loginBtnVis || finalUrl.includes('account');

      if (lockedOut) {
        console.log(
          '[INFO] login-lockout-after-failed-attempts: account locked after 5 wrong attempts — ' +
            `correct password on attempt 6 was rejected. Message: "${finalModalText.slice(0, 200).trim()}" ✓`,
        );
      } else if (loggedIn) {
        console.error(
          '[FINDING][high] login-lockout-after-failed-attempts: the account was NOT locked after 5 ' +
            'consecutive wrong-password attempts. The correct password on attempt 6 logged in ' +
            'successfully with no rate-limit or lockout applied. An attacker can make unlimited ' +
            'password guesses against any registered account.',
        );
        expect.soft(false, 'No brute-force lockout detected after 5 wrong-password attempts').toBe(true);
      } else {
        console.warn(
          `[FINDING][medium] login-lockout-after-failed-attempts: after 5 wrong + 1 correct attempt, ` +
            `the modal shows: "${finalModalText.slice(0, 200).trim()}". ` +
            'Could not confirm lockout or successful login — verify manually.',
        );
      }
    } finally {
      await lockoutCtx.close();
    }
  });

  // ── 2. Remember-me session persistence ───────────────────────────────────

  test('remember-me-persists-session — session stored in cookies/localStorage survives a new browser context', async ({ page, browser }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        '"Remember me" is checked during login. The browser context\'s cookies and localStorage are ' +
        'captured via storageState() and replayed in a new context, simulating closing and reopening ' +
        'the browser. If Firebase Auth stores its session token in localStorage or cookies, the new ' +
        'context will authenticate automatically. If IndexedDB is used instead — the Firebase v9 SDK ' +
        'default, which storageState() does not capture — the new context will be unauthenticated ' +
        'and this is logged as [INFO] with an explanation of the storage mechanism rather than as a defect.',
    });

    const adminEmail    = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      test.skip(true, 'ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env');
      return;
    }

    // Log in with "Remember me" checked
    await page.goto('/');
    await page.locator('#btn-login').click();
    await page.locator('#login-email').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#login-email').fill(adminEmail);
    await page.locator('#login-password').fill(adminPassword);

    const rememberMe = page.locator('#login-remember');
    if (await rememberMe.isVisible().catch(() => false)) {
      if (!await rememberMe.isChecked().catch(() => false)) {
        await rememberMe.check();
      }
      console.log('[INFO] remember-me-persists-session: "Remember me" checkbox checked ✓');
    } else {
      console.warn(
        '[FINDING][low] remember-me-persists-session: #login-remember checkbox not found — ' +
          'cannot verify "Remember me" feature. Proceeding with default persistence.',
      );
    }

    await page.locator('button[type="submit"]:has-text("Login")').click();
    await page.waitForFunction(() => document.readyState === 'complete', undefined, { timeout: 20_000 });
    await page.waitForTimeout(2_000);
    console.log(`[INFO] remember-me-persists-session: logged in — URL="${page.url()}"`);

    // Capture cookies + localStorage (does NOT capture IndexedDB)
    const storageState = await page.context().storageState();
    const lsEntries    = storageState.origins.flatMap(o => o.localStorage);
    const firebaseKeys = lsEntries.filter(e =>
      e.name.toLowerCase().includes('firebase') ||
      e.name.toLowerCase().includes('auth'),
    );

    console.log(
      `[INFO] remember-me-persists-session: storageState — ${storageState.cookies.length} cookie(s), ` +
        `${lsEntries.length} localStorage entry(ies), ${firebaseKeys.length} Firebase auth key(s).`,
    );

    if (firebaseKeys.length === 0) {
      console.log(
        '[INFO] remember-me-persists-session: no Firebase auth token found in localStorage — ' +
          'Firebase Auth v9 stores credentials in IndexedDB by default, which storageState() ' +
          'does not capture. The new context will likely be unauthenticated.',
      );
    } else {
      for (const e of firebaseKeys) {
        console.log(`[INFO] remember-me-persists-session: localStorage["${e.name}"] present ✓`);
      }
    }

    // Replay storage state in a new context and check auth
    const newCtx  = await browser.newContext({ storageState });
    const newPage = await newCtx.newPage();

    try {
      await newPage.goto('/');
      await newPage.waitForTimeout(4_000); // allow Firebase auth state to resolve

      const currentUrl    = newPage.url();
      const loginBtnVis   = await newPage.locator('#btn-login').isVisible().catch(() => false);
      const accountNavVis = await newPage.locator('#nav-account').isVisible().catch(() => false);
      const onAdminPage   = currentUrl.includes('admin.html');
      const sessionActive = onAdminPage || accountNavVis || !loginBtnVis;

      if (sessionActive) {
        console.log(
          '[INFO] remember-me-persists-session: session PERSISTED — new context is authenticated ' +
            `(adminPage=${onAdminPage}, #nav-account=${accountNavVis}) ✓`,
        );
      } else {
        console.log(
          '[INFO] remember-me-persists-session: session did NOT persist in the new context ' +
            `(#btn-login visible, URL="${currentUrl}"). ` +
            'Firebase Auth token is stored in IndexedDB or sessionStorage, which storageState() ' +
            'does not capture. Whether "Remember me" extends the actual token lifetime would ' +
            'require inspection of the Firebase setPersistence() call in the site\'s source.',
        );
      }
    } finally {
      await newCtx.close();
    }
  });

  // ── 3. No-remember-me session behavior ───────────────────────────────────

  test('no-remember-me-session-behavior — documents whether session persists when "Remember me" is not checked', async ({ page, browser }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Logs in with the "Remember me" checkbox left unchecked (the default state). Captures ' +
        'storage state and creates a new browser context, simulating closing and reopening the browser. ' +
        'Documents whether the session persists — both outcomes are acceptable but the actual ' +
        'behaviour should be on record for the client. Logs whether the "no Remember me" path ' +
        'produces any observable difference in localStorage vs the "Remember me" path.',
    });

    const adminEmail    = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      test.skip(true, 'ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env');
      return;
    }

    // Log in WITHOUT "Remember me" (leave unchecked — that is the default)
    await page.goto('/');
    await page.locator('#btn-login').click();
    await page.locator('#login-email').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#login-email').fill(adminEmail);
    await page.locator('#login-password').fill(adminPassword);

    const rememberMe = page.locator('#login-remember');
    if (await rememberMe.isChecked().catch(() => false)) {
      await rememberMe.uncheck();
    }
    console.log('[INFO] no-remember-me-session-behavior: "Remember me" left unchecked ✓');

    await page.locator('button[type="submit"]:has-text("Login")').click();
    await page.waitForFunction(() => document.readyState === 'complete', undefined, { timeout: 20_000 });
    await page.waitForTimeout(2_000);

    const storageState = await page.context().storageState();
    const lsEntries    = storageState.origins.flatMap(o => o.localStorage);

    console.log(
      `[INFO] no-remember-me-session-behavior: captured — ` +
        `${storageState.cookies.length} cookie(s), ${lsEntries.length} localStorage entry(ies).`,
    );

    const newCtx  = await browser.newContext({ storageState });
    const newPage = await newCtx.newPage();

    try {
      await newPage.goto('/');
      await newPage.waitForTimeout(4_000);

      const loginBtnVis   = await newPage.locator('#btn-login').isVisible().catch(() => false);
      const accountNavVis = await newPage.locator('#nav-account').isVisible().catch(() => false);
      const onAdminPage   = newPage.url().includes('admin.html');
      const sessionActive = onAdminPage || accountNavVis || !loginBtnVis;

      if (sessionActive) {
        console.log(
          '[INFO] no-remember-me-session-behavior: session PERSISTED even without "Remember me" — ' +
            `(adminPage=${onAdminPage}, #nav-account=${accountNavVis}). ` +
            'Firebase is likely using LOCAL persistence regardless of the checkbox, or the checkbox ' +
            'has no effect on the Firebase setPersistence() call in the site source.',
        );
      } else {
        console.log(
          '[INFO] no-remember-me-session-behavior: session did NOT persist without "Remember me" — ' +
            `(#btn-login visible, URL="${newPage.url()}"). ` +
            'Consistent with Firebase SESSION or NONE persistence mode for unauthenticated context. ✓',
        );
      }
    } finally {
      await newCtx.close();
    }
  });

  // ── 4. Session timeout indicators ────────────────────────────────────────

  test('session-timeout-check — documents any client-visible session expiry indicators or storage-based timeout values', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Logs in as admin and inspects the page for client-visible session timeout indicators: ' +
        'countdown timers, expiry notices, or expiry timestamps in localStorage/sessionStorage. ' +
        'A real timeout cannot be waited out during a test run, so this test purely documents ' +
        'what the client can observe. If nothing is found, [INFO] records this — a timeout may ' +
        'still be enforced server-side or via Firebase ID token expiry (typically 1 hour), which ' +
        'the SDK refreshes silently while the tab remains open.',
    });

    const adminEmail    = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      test.skip(true, 'ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env');
      return;
    }

    await page.goto('/');
    await page.locator('#btn-login').click();
    await page.locator('#login-email').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#login-email').fill(adminEmail);
    await page.locator('#login-password').fill(adminPassword);
    await page.locator('button[type="submit"]:has-text("Login")').click();
    await page.waitForFunction(() => document.readyState === 'complete', undefined, { timeout: 20_000 });
    await page.waitForTimeout(2_000);

    console.log(`[INFO] session-timeout-check: logged in — URL="${page.url()}"`);

    // ── 1. Visible timeout / expiry elements on the page ─────────────────
    const timeoutLocator = page.locator(
      '[id*="timeout"], [id*="expiry"], [id*="expire"], ' +
      '[id*="session-timer"], [class*="timeout"], [class*="session-timer"], [class*="expiry"]',
    );
    const visibleTimeout = await timeoutLocator.first().isVisible().catch(() => false);

    if (visibleTimeout) {
      const text = ((await timeoutLocator.first().textContent().catch(() => '')) ?? '').trim();
      console.log(`[INFO] session-timeout-check: client-visible timeout indicator found: "${text.slice(0, 120)}" ✓`);
    } else {
      console.log('[INFO] session-timeout-check: no client-visible session timeout indicator found on the current page.');
    }

    // ── 2. localStorage / sessionStorage expiry-related entries ──────────
    const storageReport = await page.evaluate(() => {
      const TERMS = ['expir', 'timeout', 'ttl', 'session', 'token', 'auth'];

      const ls: Array<[string, string]>  = [];
      const ss: Array<[string, string]>  = [];
      const allLsKeys: string[] = [];
      const allSsKeys: string[] = [];

      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        allLsKeys.push(k);
        if (TERMS.some(t => k.toLowerCase().includes(t))) {
          ls.push([k, (localStorage.getItem(k) ?? '').slice(0, 200)]);
        }
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i)!;
        allSsKeys.push(k);
        if (TERMS.some(t => k.toLowerCase().includes(t))) {
          ss.push([k, (sessionStorage.getItem(k) ?? '').slice(0, 200)]);
        }
      }

      return { ls, ss, allLsKeys, allSsKeys };
    });

    console.log(
      `[INFO] session-timeout-check: localStorage has ${storageReport.allLsKeys.length} key(s), ` +
        `sessionStorage has ${storageReport.allSsKeys.length} key(s).`,
    );

    if (storageReport.ls.length > 0) {
      for (const [k, v] of storageReport.ls) {
        console.log(`[INFO] session-timeout-check: localStorage["${k}"] = "${v}"`);
      }
    } else {
      console.log('[INFO] session-timeout-check: no expiry/session/token keys found in localStorage.');
    }

    if (storageReport.ss.length > 0) {
      for (const [k, v] of storageReport.ss) {
        console.log(`[INFO] session-timeout-check: sessionStorage["${k}"] = "${v}"`);
      }
    } else {
      console.log('[INFO] session-timeout-check: no expiry/session/token keys found in sessionStorage.');
    }

    // ── 3. Contextual note on Firebase token lifecycle ────────────────────
    console.log(
      '[INFO] session-timeout-check: Firebase Auth ID tokens expire after 1 hour by default. ' +
        'The Firebase SDK silently refreshes the token while the browser tab is open. ' +
        'A server-side inactivity timeout (independent of the token) would require custom ' +
        'Cloud Functions logic — no such mechanism is observable from the client side alone.',
    );

    // No hard assertions — this test is entirely informational
  });

});
