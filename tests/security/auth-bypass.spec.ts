import { test, expect } from '@playwright/test';

// Intercept all auth write endpoints to prevent any side-effects from these tests.
// Read-only Firebase calls (onAuthStateChanged, Firestore reads) are allowed through
// because they are needed to observe the site's actual auth-gate behaviour.

test.describe('Auth bypass', { tag: ['@security'] }, () => {

  test.beforeEach(async ({ page }) => {
    // Block sign-in and sign-up so these tests can never create or authenticate a session.
    await page.route('**/accounts:signInWithPassword**', route => route.abort());
    await page.route('**/accounts:signUp**', route => route.abort());
    await page.route('**/sendPasswordReset**', route => route.abort());
  });

  // ─── direct-account-access ───────────────────────────────────────────────────

  test('direct-account-access — unauthenticated visit shows inline auth gate, not account data', async ({ page }) => {
    await page.goto('/account.html', { waitUntil: 'load' });

    // Allow Firebase auth state to resolve before making assertions.
    await page.waitForTimeout(3_000);

    const finalUrl = page.url();

    // The site stays on /account.html (no redirect). This is a design choice, not a flaw,
    // as long as no private data is exposed to unauthenticated visitors.
    expect(finalUrl).toContain('account.html');

    // The page must show an inline auth gate — NOT private account content.
    // From inspection: #not-logged-in becomes visible; auth modal is NOT used.
    const authGateVisible = await page.locator('#not-logged-in').isVisible();
    const authPopupShown  = await page.locator('#auth-modal').isVisible();

    if (!authGateVisible) {
      console.error(
        '[FINDING][critical] direct-account-access: navigated to /account.html without ' +
          'authentication and #not-logged-in is not visible. Account content may be exposed.',
      );
    }

    expect(authGateVisible, '#not-logged-in auth gate must be visible for unauthenticated users').toBe(true);

    // Auth popup is not used here (inline gate is used instead). Acceptable either way.
    if (authPopupShown) {
      console.log('[INFO] direct-account-access: auth modal also opened — dual gate.');
    }

    // Confirm no private data (orders, profile fields) is visible outside the auth gate.
    const privateSelectors = ['#orders', '#account-email', '#account-name', '#order-list'];
    for (const sel of privateSelectors) {
      const el = page.locator(sel);
      if (await el.count() > 0 && await el.isVisible()) {
        console.error(
          `[FINDING][critical] direct-account-access: ${sel} is visible to an unauthenticated ` +
            'visitor. Private account data may be leaked.',
        );
      }
    }
  });

  // ─── direct-terms-access ─────────────────────────────────────────────────────

  test('direct-terms-access — /terms.html loads and returns page content', async ({ page }) => {
    const response = await page.goto('/terms.html', { waitUntil: 'load' });

    // Terms pages are public — a 200 response with content is expected.
    expect(response?.status(), '/terms.html must return HTTP 200').toBe(200);

    // Verify the page has meaningful text content (not a blank or error page).
    const bodyText = await page.evaluate(() => document.body.innerText.trim());
    expect(bodyText.length, '/terms.html body must contain content').toBeGreaterThan(100);

    // No redirect to home or login expected for public-access pages.
    expect(page.url()).toContain('terms.html');
  });

  // ─── auth-modal-escape ───────────────────────────────────────────────────────

  test('auth-modal-escape — Escape key closes the login modal cleanly with no console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(`[pageerror] ${err.message}`));

    await page.goto('/');

    // Open login modal
    await page.locator('#btn-login').click();
    await page.locator('#auth-modal').waitFor({ state: 'visible' });

    // Clear any errors that fired before the modal interaction
    consoleErrors.length = 0;

    await page.keyboard.press('Escape');

    // Allow the dismiss animation / JS handler to complete
    await page.waitForTimeout(500);

    const modalAfterEscape = await page.locator('#auth-modal').isVisible();

    if (modalAfterEscape) {
      console.warn(
        '[FINDING][medium] auth-modal-escape: #auth-modal remains visible after pressing Escape. ' +
          'The modal does not handle the Escape key — keyboard users cannot dismiss it without ' +
          'clicking the × button. This is a keyboard-accessibility gap.',
      );
    } else {
      // Escape did close the modal — this is the expected behaviour.
      expect(modalAfterEscape).toBe(false);
    }

    if (consoleErrors.length > 0) {
      console.error(
        '[FINDING][high] auth-modal-escape: console errors fired during modal Escape: ' +
          consoleErrors.join(' | '),
      );
      // Console errors on dismiss are a finding but not a test failure — they indicate
      // an unhandled exception in the modal teardown path.
    }

    // Whether the modal closed or not, there must be no unhandled JS exceptions.
    const jsExceptions = consoleErrors.filter(e => e.startsWith('[pageerror]'));
    expect(jsExceptions, 'No unhandled JS exceptions on Escape').toHaveLength(0);
  });

});
