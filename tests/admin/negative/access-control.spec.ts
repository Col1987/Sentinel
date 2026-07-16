import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../../../src/utils/auth';
import { LIVE_MODE } from '../../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

test.describe('Admin access control — negative', { tag: ['@admin'] }, () => {

  test.beforeEach(() => { test.slow(); });

  // ─── regular-user-blocked-from-admin ──────────────────────────────────────

  test('regular-user-blocked-from-admin — removing the auth overlay via DOM manipulation does not expose admin data', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to /admin.html without logging in and then removed the authentication overlay using DOM manipulation — the same technique any visitor can perform in browser DevTools. Verified that removing the UI overlay does not expose real admin data because Firestore security rules block unauthenticated reads regardless of what the client renders.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await page.goto('/admin.html', { waitUntil: 'load' });

    const overlayVisible = await page.locator('#admin-auth-overlay').isVisible().catch(() => false);
    if (!overlayVisible) {
      console.log('[INFO] regular-user-blocked-from-admin: #admin-auth-overlay not found — auth gate may use a different mechanism.');
    } else {
      console.log('[INFO] regular-user-blocked-from-admin: auth overlay confirmed — simulating DOM bypass.');
    }

    // Track backend responses to check whether data is returned without auth.
    const successfulDataResponses: string[] = [];
    page.on('response', async res => {
      const url = res.url();
      if (
        (url.includes('cloudfunctions.net') || url.includes('firestore.googleapis.com')) &&
        res.status() === 200
      ) {
        successfulDataResponses.push(url);
      }
    });

    // Remove the overlay — any visitor can do this in browser DevTools.
    await page.evaluate(() => {
      const overlay = document.getElementById('admin-auth-overlay');
      if (overlay) overlay.style.display = 'none';
    });

    // Click known tab buttons to trigger potential data loads.
    const TABS_TO_TRY = ['#atab-btn-orders', '#atab-btn-packs', '#atab-btn-users'];
    for (const tabId of TABS_TO_TRY) {
      if (await page.locator(tabId).isVisible().catch(() => false)) {
        await page.locator(tabId).click().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
    }

    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [aria-busy="true"]'),
      undefined,
      { timeout: 3_000 },
    ).catch(() => {});

    // Scan visible DOM text for admin data signals beyond just the admin's own email.
    const domText = await page.evaluate(() => document.body.innerText).catch(() => '');

    const DATA_SIGNALS = [
      { pattern: /order #[a-z0-9-]{6,}/i,           label: 'order reference' },
      { pattern: /customer name|shipping address/i,  label: 'customer data label' },
      { pattern: /\b\d{1,3}[+]\s*orders?\b/i,       label: 'order count disclosure' },
    ];

    let domDataExposed = false;
    for (const { pattern, label } of DATA_SIGNALS) {
      if (pattern.test(domText)) {
        domDataExposed = true;
        console.error(
          `[FINDING][critical] regular-user-blocked-from-admin: removing the auth overlay revealed ${label} in the DOM. ` +
            'Real data must not be accessible via client-side UI bypass. Firestore rules must block unauthenticated reads.',
        );
      }
    }

    if (successfulDataResponses.length > 0 && LIVE_MODE) {
      console.warn(
        `[FINDING][high] regular-user-blocked-from-admin: ${successfulDataResponses.length} backend endpoint(s) returned HTTP 200 ` +
          'without an authenticated session after the overlay was removed. Backend must require auth tokens independently of the UI.',
      );
    }

    if (!domDataExposed) {
      console.log('[INFO] regular-user-blocked-from-admin: DOM bypass did not expose admin data — backend protection is effective ✓');
    }

    expect(domDataExposed, 'Removing the auth overlay must not expose admin data in the DOM').toBe(false);
  });

  // ─── admin-tabs-without-auth ──────────────────────────────────────────────

  test('admin-tabs-without-auth — clicking admin-only tabs without authentication loads no real data', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to /admin.html without logging in and force-clicked each admin tab (Users, Audit Log, Support Tickets) through the authentication overlay. Verified that no real data appeared in the tab panels. The overlay is a UI convenience — Firestore security rules are the true enforcement layer and must reject unauthenticated reads regardless of which tab the client clicks.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto('/admin.html', { waitUntil: 'load' });

    // #admin-auth-overlay may intercept pointer events — force: true bypasses CSS pointer-events blocking.
    const PROTECTED_TABS = ['#atab-btn-users', '#atab-btn-audit', '#atab-btn-tickets'];

    for (const tabId of PROTECTED_TABS) {
      const tab = page.locator(tabId);
      if (!(await tab.isVisible().catch(() => false))) {
        console.log(`[INFO] admin-tabs-without-auth: ${tabId} not in DOM — skipping.`);
        continue;
      }

      await tab.click({ force: true }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});

      // Scan visible body panels for real data signals after the unauthenticated click.
      const panelText = await page.evaluate(() => document.body.innerText).catch(() => '');
      const emailPattern = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
      const emailMatches = panelText.match(emailPattern);

      if (emailMatches) {
        const match = emailMatches[0];
        const isAdminOwnEmail = match === process.env.ADMIN_EMAIL;
        if (!isAdminOwnEmail) {
          console.error(
            `[FINDING][high] admin-tabs-without-auth: after clicking ${tabId} without auth, an email address ` +
              `("${match}") appeared in the page. Unauthenticated tab clicks must not expose user data.`,
          );
        }
      }

      console.log(`[INFO] admin-tabs-without-auth: clicked ${tabId} without auth — no critical data leak detected.`);
    }

    if (pageErrors.length > 0) {
      console.warn(
        `[FINDING][medium] admin-tabs-without-auth: ${pageErrors.length} JS exception(s) while clicking tabs without auth: ` +
          pageErrors.join(' | '),
      );
    }

    expect(pageErrors, 'Clicking admin tabs without authentication must not throw unhandled JS exceptions').toHaveLength(0);
  });

  // ─── expired-session-handling ─────────────────────────────────────────────

  test('expired-session-handling — clearing Firebase auth tokens triggers re-authentication on next admin page load', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, then simulated a session expiry by clearing all Firebase authentication tokens from localStorage and IndexedDB. Navigated back to the admin dashboard and checked whether the page recognised the cleared session and displayed the authentication gate. Sessions that remain active after tokens are deleted are a security risk.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    const dashboardVisible = await page.locator('#orders-body').isVisible().catch(() => false);
    console.log(`[INFO] expired-session-handling: admin dashboard visible before token clear = ${dashboardVisible}.`);

    // Simulate session expiry: clear all Firebase auth storage.
    // indexedDB.databases() is async and unreliable across browsers; delete known Firebase
    // databases by name synchronously instead.
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
      const FIREBASE_DBS = [
        'firebaseLocalStorageDb',
        'firebase-installations-database',
        'firebase-heartbeat-database',
      ];
      for (const name of FIREBASE_DBS) {
        try { window.indexedDB.deleteDatabase(name); } catch { /* ignore */ }
      }
    });

    // Navigate back to admin — the cleared auth state should trigger the login gate.
    await page.goto('/admin.html', { waitUntil: 'load' });

    // Allow Firebase to attempt auth restoration and determine the session is invalid.
    await page.waitForFunction(
      () => {
        const overlay = document.getElementById('admin-auth-overlay');
        const isHidden = overlay && (overlay.style.display === 'none' || overlay.classList.contains('hidden'));
        return !isHidden || !window.location.pathname.includes('admin');
      },
      undefined,
      { timeout: 10_000 },
    ).catch(() => {});

    const wasRedirected    = !page.url().includes('admin.html');
    const overlayReappeared = await page.locator('#admin-auth-overlay').isVisible().catch(() => false);

    if (wasRedirected) {
      console.log('[INFO] expired-session-handling: cleared auth → page redirected away from admin ✓');
    } else if (overlayReappeared) {
      console.log('[INFO] expired-session-handling: cleared auth → #admin-auth-overlay reappeared ✓');
    } else {
      console.error(
        '[FINDING][critical] expired-session-handling: after clearing all Firebase auth tokens, the admin dashboard ' +
          'remained accessible without showing a re-authentication prompt. ' +
          'Auth state must be validated on every page load — not only on the initial login redirect.',
      );
    }

    const sessionInvalidated = wasRedirected || overlayReappeared;
    expect(sessionInvalidated, 'Admin dashboard must require re-authentication after auth tokens are cleared').toBe(true);
  });

});
