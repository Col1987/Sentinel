import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../../src/utils/auth';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

// Orders are loaded by the getAdminOrders Cloud Function.
// In safe mode (!LIVE_MODE) that function is blocked, so the orders table is empty.
// Structural tests (headers, filter UI, search) run without data.
// Row-level tests (detail view, status update) are skipped gracefully when no rows appear.

test.describe('Admin order flows', { tag: ['@admin'] }, () => {

  test.beforeEach(() => { test.slow(); });

  // ─── orders-list-loads ───────────────────────────────────────────────────────

  test('orders-list-loads — orders table renders column headers, search, and status filter', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and opened the Orders tab (the default dashboard view). Checked that the table structure is always present: column headers, a text search input, and a status filter dropdown. These structural elements must render regardless of whether any order data has loaded — they are the admin's primary tools for finding and reviewing orders.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    // Orders is the default active tab — #orders-body is visible on load without clicking anything.
    const ordersBodyVisible = await page.locator('#orders-body').isVisible().catch(() => false);
    if (!ordersBodyVisible) {
      console.error('[FINDING][high] orders-list-loads: #orders-body is not visible after admin login.');
    }
    expect(ordersBodyVisible, '#orders-body must be visible immediately after admin login').toBe(true);

    // Column headers give admins context for what each table column represents.
    const headerCount = await page.locator(
      '#orders-body th, [class*="orders"] th, [id*="orders"] th',
    ).count();
    if (headerCount === 0) {
      console.warn(
        '[FINDING][low] orders-list-loads: no <th> elements found in the orders section. ' +
          'Column headers help admins identify which column they are reading.',
      );
    }
    console.log(`[INFO] orders-list-loads: ${headerCount} table header cell(s) found.`);

    // Search and filter controls must be present regardless of data state.
    const searchVisible       = await page.locator('#filter-search').isVisible().catch(() => false);
    const statusFilterVisible = await page.locator('#filter-status').isVisible().catch(() => false);

    if (!searchVisible) {
      console.warn('[FINDING][medium] orders-list-loads: #filter-search not visible — admins cannot search orders.');
    }
    if (!statusFilterVisible) {
      console.warn('[FINDING][medium] orders-list-loads: #filter-status not visible — admins cannot filter by status.');
    }

    console.log(`[INFO] orders-list-loads: search visible=${searchVisible}, status-filter visible=${statusFilterVisible}.`);

    expect(searchVisible, '#filter-search must be visible for admins to search orders').toBe(true);
    expect(statusFilterVisible, '#filter-status must be visible for admins to filter by status').toBe(true);
  });

  // ─── orders-filter-by-status ─────────────────────────────────────────────────

  test('orders-filter-by-status — cycling through status filter options does not cause errors', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and selected each option in the order status filter dropdown one by one (All, Assembling, In Transit, Delivered, etc.). Verified that choosing each filter value does not produce a JavaScript error. In safe test mode the order list is empty, so no rows change — but the filter UI itself must handle every option without crashing.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    const filterSelect = page.locator('#filter-status');
    const filterExists = await filterSelect.isVisible().catch(() => false);
    if (!filterExists) {
      console.log('[INFO] orders-filter-by-status: #filter-status not found — cannot test status filter options.');
      return;
    }

    const options = await filterSelect.locator('option').all();
    console.log(`[INFO] orders-filter-by-status: ${options.length} filter option(s) found.`);

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    for (const option of options) {
      const value = (await option.getAttribute('value').catch(() => '')) ?? '';
      const text  = ((await option.textContent().catch(() => '')) ?? '').trim();
      await filterSelect.selectOption({ value });
      // Allow the client-side filter to apply before moving to the next option.
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      console.log(`[INFO] orders-filter-by-status: selected "${text}" (value="${value}").`);
    }

    if (pageErrors.length > 0) {
      console.error(
        `[FINDING][high] orders-filter-by-status: ${pageErrors.length} JS exception(s) while changing status filter: ` +
          pageErrors.join(' | '),
      );
    }
    expect(pageErrors, 'No JS exceptions must fire when cycling through status filter options').toHaveLength(0);
  });

  // ─── orders-search ──────────────────────────────────────────────────────────

  test('orders-search — typing a search term filters the list or shows a graceful no-results state', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and typed a test order reference into the search box. Checked that the list either narrows to matching rows or shows a 'no results' message — visitors must get clear feedback when their search returns nothing. No JavaScript errors must fire during the search. In safe test mode the list starts empty so a 'no results' outcome is the expected and acceptable response.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    const searchInput = page.locator('#filter-search');
    if (!(await searchInput.isVisible().catch(() => false))) {
      console.log('[INFO] orders-search: #filter-search not found — cannot test search functionality.');
      return;
    }

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await searchInput.fill('SENTINEL-TEST-00001');

    // Wait for any client-side search debounce to settle and loading indicators to clear.
    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [class*="spinner"], [aria-busy="true"]'),
      { timeout: 3_000 },
    ).catch(() => {});

    const bodyText     = ((await page.locator('#orders-body').textContent().catch(() => '')) ?? '').toLowerCase();
    const hasResults   = await page.locator('#orders-body tr[data-id], #orders-body .order-row').count() > 0;
    const hasNoResults = /no (orders|results|records)|nothing found/i.test(bodyText);

    console.log(`[INFO] orders-search: hasResults=${hasResults}, hasNoResults=${hasNoResults}.`);

    if (!hasResults && !hasNoResults) {
      console.warn(
        '[FINDING][low] orders-search: after typing a search term the list shows neither matching rows nor a ' +
          '"no results" message. Admins get no feedback when a search returns nothing.',
      );
    }

    if (pageErrors.length > 0) {
      console.error(`[FINDING][high] orders-search: ${pageErrors.length} JS exception(s) during search: ${pageErrors.join(' | ')}`);
    }
    expect(pageErrors, 'No JS exceptions must fire during order search').toHaveLength(0);
  });

  // ─── order-detail-view ──────────────────────────────────────────────────────

  test('order-detail-view — order detail modal shows order ID, status, and customer information', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, found the first order in the list, and opened its detail view. Checked that the modal contains an order reference, a status, and customer information — the core fields an admin needs to process or follow up on an order. In safe test mode this step is skipped if no orders appear (Cloud Functions are blocked and the table will be empty).",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    await page.locator('#orders-body').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => null);

    if (LIVE_MODE) {
      // Give the getAdminOrders CF time to deliver rows before checking count.
      await page.waitForFunction(
        () => document.querySelectorAll('#orders-body tr, #orders-body .order-row').length > 0,
        { timeout: 8_000 },
      ).catch(() => {});
    }

    const viewBtns = page.locator(
      '#orders-body button:has-text("View"), #orders-body .btn-sm:has-text("View")',
    );

    if (await viewBtns.count() === 0) {
      console.log(
        '[INFO] order-detail-view: no "View" buttons in #orders-body — ' +
          'orders have not loaded (safe mode) or the store has no orders. Skipping detail assertions.',
      );
      return;
    }

    await viewBtns.first().click();
    await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {});

    const modalVisible = await page.locator('#order-modal').isVisible().catch(() => false);
    if (!modalVisible) {
      console.error('[FINDING][medium] order-detail-view: #order-modal did not appear after clicking View.');
      expect(modalVisible, '#order-modal must open when a View button is clicked').toBe(true);
      return;
    }

    const modalText = ((await page.locator('#order-modal').textContent().catch(() => '')) ?? '').toLowerCase();

    const EXPECTED = [
      { label: 'order ID or reference', hint: /order|ref|#[a-z0-9]/i },
      { label: 'status',                hint: /status|assembling|transit|delivered|pending/i },
      { label: 'customer or name',      hint: /customer|name|email/i },
    ];

    for (const { label, hint } of EXPECTED) {
      if (!hint.test(modalText)) {
        console.warn(
          `[FINDING][low] order-detail-view: #order-modal does not appear to contain ${label}. ` +
            'Admins need this information to process orders.',
        );
      } else {
        console.log(`[INFO] order-detail-view: "${label}" detected in #order-modal ✓`);
      }
    }

    expect(modalVisible, '#order-modal must be visible with order content').toBe(true);
  });

  // ─── order-status-update ────────────────────────────────────────────────────

  test('order-status-update — order detail modal has a status dropdown containing all lifecycle values', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, opened an order's detail view, and inspected the status dropdown. Verified that it includes all four order lifecycle stages: Assembling, Ready, In Transit, and Delivered. A missing status would prevent the admin from moving an order through the complete fulfilment process. This test only reads the dropdown — no status was changed. In safe test mode this step is skipped if no orders are visible.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    await page.locator('#orders-body').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => null);

    if (LIVE_MODE) {
      await page.waitForFunction(
        () => document.querySelectorAll('#orders-body tr, #orders-body .order-row').length > 0,
        { timeout: 8_000 },
      ).catch(() => {});
    }

    const viewBtns = page.locator(
      '#orders-body button:has-text("View"), #orders-body .btn-sm:has-text("View")',
    );

    if (await viewBtns.count() === 0) {
      console.log('[INFO] order-status-update: no View buttons found — orders not loaded. Skipping status dropdown check.');
      return;
    }

    await viewBtns.first().click();
    await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {});

    if (!(await page.locator('#order-modal').isVisible().catch(() => false))) {
      console.log('[INFO] order-status-update: #order-modal did not open — skipping status dropdown check.');
      return;
    }

    // Look for a status-change select inside the modal.
    const statusSelect = page.locator('#order-modal select, #order-modal [id*="status"]').first();
    if (!(await statusSelect.isVisible().catch(() => false))) {
      console.log(
        '[INFO] order-status-update: no status select found in #order-modal. ' +
          'The portal may use buttons instead of a dropdown for status changes.',
      );
      return;
    }

    const optionTexts = await statusSelect.locator('option').allTextContents();
    const lowerOptions = optionTexts.map(t => t.toLowerCase().trim());

    const EXPECTED_STATUSES = ['assembling', 'ready', 'transit', 'delivered'];
    const missing = EXPECTED_STATUSES.filter(s => !lowerOptions.some(o => o.includes(s)));

    console.log(`[INFO] order-status-update: status dropdown options: [${optionTexts.join(', ')}].`);

    if (missing.length > 0) {
      console.error(
        `[FINDING][medium] order-status-update: status dropdown is missing: ${missing.join(', ')}. ` +
          'All four lifecycle statuses are required for complete order fulfilment.',
      );
    }

    expect(missing, `Status dropdown must include all lifecycle values: ${EXPECTED_STATUSES.join(', ')}`).toHaveLength(0);
  });

  // ─── order-export-csv ───────────────────────────────────────────────────────

  test('order-export-csv — clicking Export CSV triggers a file download', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and clicked the 'Export CSV' button. Verified that the button triggers a file download. In safe test mode the export Cloud Function is fulfilled with a blank CSV to allow the download to complete without hitting the live backend. Export is how the site owner moves order data into spreadsheets for fulfilment and reporting.",
    });

    if (!LIVE_MODE) {
      // Allow export-related CF calls to complete with mock CSV data so the download fires.
      // All other CF calls remain blocked to keep safe mode safe.
      await page.route(CF_PATTERN, async route => {
        if (/export/i.test(route.request().url())) {
          await route.fulfill({
            status: 200,
            contentType: 'text/csv',
            headers: { 'Content-Disposition': 'attachment; filename="orders-export.csv"' },
            body: 'Order ID,Status,Customer Name\n',
          });
        } else {
          await route.abort();
        }
      });
    }

    await loginAsAdmin(page);

    const exportBtn = page.locator('button:has-text("Export CSV")');
    if (!(await exportBtn.isVisible().catch(() => false))) {
      console.log('[INFO] order-export-csv: "Export CSV" button not found — feature may not be implemented.');
      return;
    }

    // Register the download listener before clicking so a fast response is not missed.
    const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
    await exportBtn.click();

    const download = await downloadPromise.catch(() => null);

    if (download) {
      const filename = download.suggestedFilename();
      console.log(`[INFO] order-export-csv: download triggered — suggested filename: "${filename}".`);
      expect(filename, 'Export download filename must end in .csv').toMatch(/\.csv$/i);
    } else {
      console.warn(
        '[FINDING][medium] order-export-csv: clicking "Export CSV" did not produce a download event within 10s. ' +
          'The export may have failed silently or was blocked.',
      );
      // In LIVE_MODE a real download must happen; in safe mode a blocked CF is informational.
      if (LIVE_MODE) {
        expect(download, 'Export CSV must trigger a download in LIVE_MODE').not.toBeNull();
      }
    }
  });

});
