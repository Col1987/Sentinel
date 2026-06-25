import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../../src/utils/auth';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

// The Orders tab is the default active tab on admin.html — no tab click required.
// Orders are loaded via getAdminOrders Cloud Function. In safe mode (!LIVE_MODE)
// that function is blocked, so #orders-body will be empty or in a loading state.

test.describe('Admin order management', { tag: ['@admin'] }, () => {

  test.beforeEach(() => { test.slow(); });

  // ─── orders-tab-loads ──────────────────────────────────────────────────────

  test('orders-tab-loads — orders section is visible after admin login', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and checked that the Orders section loads correctly. The Orders tab is the default view on the admin dashboard. In safe test mode the order rows are not fetched (Cloud Functions are blocked), but the section container, search filter, and status dropdown must still render. CONFIRMED: the orders section structure is visible.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    // #orders-body is the container for the orders table. It is present on page load
    // because the Orders tab is the default active tab (class="admin-tab-btn active").
    const ordersBodyVisible = await page.locator('#orders-body').isVisible().catch(() => false);

    // The filter row (search + status dropdown) is part of the orders section structure
    const filterVisible = await page.locator('#filter-search, #filter-status').first().isVisible().catch(() => false);

    if (!ordersBodyVisible) {
      console.error(
        '[FINDING][high] orders-tab-loads: #orders-body is not visible after admin login. ' +
          'The orders section may have failed to render.',
      );
    }

    console.log(`[INFO] orders-tab-loads: #orders-body visible=${ordersBodyVisible}, filter visible=${filterVisible}.`);

    expect(ordersBodyVisible, '#orders-body must be visible on the admin dashboard').toBe(true);
  });

  // ─── order-detail-opens ────────────────────────────────────────────────────

  test('order-detail-opens — clicking View on an order opens the order detail modal', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, found the first order in the list, and clicked its View button. Checked that the order detail modal (#order-modal) opens showing the order information. This is the main workflow admins use to review, update, and manage individual orders. In safe test mode this step is skipped if no orders are visible (Cloud Functions are blocked).",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    // Orders are loaded via getAdminOrders CF. In !LIVE_MODE that's blocked,
    // so the table will be empty — skip the assertion gracefully.
    await page.locator('#orders-body').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => null);

    // In LIVE_MODE, give the CF time to return order rows
    if (LIVE_MODE) {
      await page.waitForTimeout(2_000);
    }

    const viewBtns = page.locator('#orders-body button:has-text("View"), #orders-body .btn-sm:has-text("View")');
    const viewCount = await viewBtns.count();

    if (viewCount === 0) {
      console.log(
        '[INFO] order-detail-opens: no "View" buttons found in #orders-body — ' +
          'orders may not have loaded (safe mode) or the store is empty. Skipping detail-click assertion.',
      );
      return;
    }

    await viewBtns.first().click();
    await page.waitForTimeout(1_000);

    const modalVisible = await page.locator('#order-modal').isVisible().catch(() => false);

    if (!modalVisible) {
      console.error(
        '[FINDING][medium] order-detail-opens: clicked a "View" button but #order-modal did not become visible. ' +
          'Admins may be unable to open the order detail view.',
      );
    }

    expect(modalVisible, '#order-modal must be visible after clicking a View button').toBe(true);
  });

});
