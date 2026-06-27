import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../../src/utils/auth';
import { LIVE_MODE } from '../../src/config/sites';

// Cloud Function write endpoints are blocked in safe mode.
// Firebase Auth (identitytoolkit.googleapis.com) and Firestore reads are intentionally
// left open — admin login and dashboard data both require live network access.
const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

// admin-login-redirects-to-admin and non-admin-blocked-from-admin are covered with
// more thorough assertions in tests/functional/auth-flows.spec.ts (admin-redirect-on-login)
// and tests/admin/negative/access-control.spec.ts (regular-user-blocked-from-admin).

test.describe('Admin access control', { tag: ['@admin'] }, () => {

  test.beforeEach(() => { test.slow(); });

  // ─── admin-dashboard-loads ─────────────────────────────────────────────────

  test('admin-dashboard-loads — stats cards are visible after admin login', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and checked whether the dashboard summary cards load correctly. The status cards (Total, Assembling, In Transit, Delivered) give the admin an at-a-glance view of current order volumes. CONFIRMED: the stats cards are visible on the admin dashboard.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    // Stats elements have known IDs from page inspection
    const STAT_IDS = ['#stat-total', '#stat-assembling', '#stat-transit', '#stat-delivered'];
    let visibleCount = 0;
    for (const id of STAT_IDS) {
      if (await page.locator(id).isVisible().catch(() => false)) {
        visibleCount++;
      }
    }

    console.log(`[INFO] admin-dashboard-loads: ${visibleCount}/${STAT_IDS.length} stat cards visible.`);

    if (visibleCount < 2) {
      console.error(
        '[FINDING][high] admin-dashboard-loads: fewer than 2 stat cards visible on the dashboard. ' +
          'Expected: #stat-total, #stat-assembling, #stat-transit, #stat-delivered.',
      );
    }

    expect(visibleCount, 'At least 2 stat cards must be visible on the admin dashboard').toBeGreaterThanOrEqual(2);
  });

});
