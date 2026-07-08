import { test, expect } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

// Condensed version of tests/admin/negative/access-control.spec.ts's
// regular-user-blocked-from-admin — the full exploratory version (multiple tab clicks,
// JS-exception monitoring) still runs independently via --project=admin.

test.describe('Admin access control', { tag: ['@regression'] }, () => {

  test.beforeEach(() => { test.slow(); });

  test('admin-auth-gate-and-dom-bypass-resistance — the auth gate blocks unauthenticated visitors, and removing it via DOM manipulation exposes no data', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: 'Navigated to /admin.html without logging in and confirmed the authentication overlay gate is shown. Then removed the overlay using DOM manipulation — the same technique any visitor can perform in browser DevTools — and confirmed no real admin data becomes visible, since Firestore security rules must block unauthenticated reads regardless of what the client renders.',
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await page.goto('/admin.html', { waitUntil: 'load' });

    // ── Auth gate check ────────────────────────────────────────────────────────
    const overlayVisible = await page.locator('#admin-auth-overlay').isVisible().catch(() => false);
    if (!overlayVisible) {
      console.warn('[FINDING][medium] admin-auth-gate-and-dom-bypass-resistance: #admin-auth-overlay not visible for an unauthenticated visitor — the auth gate may be missing or use a different mechanism.');
    } else {
      console.log('[INFO] admin-auth-gate-and-dom-bypass-resistance: auth gate present for unauthenticated visitor ✓');
    }
    expect(overlayVisible, 'The admin auth overlay must be visible to an unauthenticated visitor').toBe(true);

    // ── DOM bypass resistance check ───────────────────────────────────────────
    await page.evaluate(() => {
      const overlay = document.getElementById('admin-auth-overlay');
      if (overlay) overlay.style.display = 'none';
    });
    await page.waitForTimeout(1_000);

    const domText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const DATA_SIGNALS = [
      { pattern: /order #[a-z0-9-]{6,}/i,          label: 'order reference' },
      { pattern: /customer name|shipping address/i, label: 'customer data label' },
      { pattern: /\b\d{1,3}[+]\s*orders?\b/i,      label: 'order count disclosure' },
    ];

    let domDataExposed = false;
    for (const { pattern, label } of DATA_SIGNALS) {
      if (pattern.test(domText)) {
        domDataExposed = true;
        console.error(
          `[FINDING][critical] admin-auth-gate-and-dom-bypass-resistance: removing the auth overlay revealed ${label} in the DOM. ` +
            'Real data must not be accessible via client-side UI bypass.',
        );
      }
    }

    if (!domDataExposed) {
      console.log('[INFO] admin-auth-gate-and-dom-bypass-resistance: DOM bypass did not expose admin data — backend protection is effective ✓');
    }

    expect(domDataExposed, 'Removing the auth overlay must not expose admin data in the DOM').toBe(false);
  });

});
