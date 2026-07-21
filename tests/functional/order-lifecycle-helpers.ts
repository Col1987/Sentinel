import { type Page } from '@playwright/test';

// ── Admin order-modal helpers ─────────────────────────────────────────────────
// Shared by tests/functional/order-lifecycle.spec.ts and tests/regression/order-lifecycle.spec.ts.
// Requires loginAsAdmin() (src/utils/auth.ts) to have been called first.

// Opens the order detail modal by calling viewOrder(id) directly on the admin
// page. Requires loginAsAdmin() to have been called first.
export async function openOrderModal(page: Page, orderId: string): Promise<void> {
  await page.evaluate((id: string) => {
    if ((window as any).viewOrder) (window as any).viewOrder(id);
  }, orderId);
  await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 });
  await page.waitForTimeout(800);
}

export async function closeOrderModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('order-modal')?.classList.remove('active');
  });
  await page.waitForTimeout(500);
}

// Reads the current status badge text from the open order modal.
export async function getModalStatus(page: Page): Promise<string> {
  return ((await page.locator('#order-modal .status-badge').textContent().catch(() => '')) ?? '').trim();
}

// Reads the orderId embedded in the waybill input ID inside the open modal.
export async function getModalOrderId(page: Page): Promise<string | null> {
  const inputId = await page.locator('#order-modal input[id^="waybill-input-"]').getAttribute('id').catch(() => null);
  return inputId ? inputId.replace('waybill-input-', '') : null;
}

// Advances the order to the next status stage. For stages that require an
// inline override confirmation ("Yes, Force Update"), clicks that button too.
// The modal DOM does NOT refresh after updateStatus() — caller must
// closeOrderModal + openOrderModal to verify the persisted state.
export async function clickAdvanceStatus(page: Page, btnClass: string): Promise<void> {
  const mainBtn = page.locator(`#order-modal button.${btnClass}`);
  await mainBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await mainBtn.click();
  await page.waitForTimeout(500);

  // Some transitions (Ready for Collection → In Transit, In Transit → Delivered,
  // Delivered → Completed) show an inline confirmation before writing to Firestore.
  const forceBtn = page.locator('#order-modal button:has-text("Yes, Force Update")');
  if (await forceBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await forceBtn.click();
  }

  // Allow the Firestore write to complete before the caller re-reads state.
  await page.waitForTimeout(2_000);
}

// Closes and reopens the modal to get fresh Firestore data, then asserts the
// persisted status matches expectedStatus. Logs a finding if it doesn't.
export async function verifyStatusPersisted(
  page: Page,
  orderId: string,
  expectedStatus: string,
  testLabel: string,
): Promise<void> {
  await closeOrderModal(page);
  await openOrderModal(page, orderId);
  const actual = await getModalStatus(page);
  if (actual === expectedStatus) {
    console.log(`[INFO] ${testLabel}: status "${expectedStatus}" persisted ✓`);
  } else {
    console.error(
      `[FINDING][high] ${testLabel}: expected persisted status "${expectedStatus}" ` +
        `but modal shows "${actual}" after close+reopen — the status update may not ` +
        'have been saved to Firestore.',
    );
  }
}

// Waits for the admin orders table's real data to finish loading. #orders-body renders a
// single placeholder row immediately after login/refresh, then the real (possibly
// hundreds-strong) order list replaces it asynchronously — confirmed live to take up to
// ~8s. Filtering or scanning before this settles is unreliable two different ways: the
// filter's oninput handler (filterOrders() -> renderOrders(filterCurrent())) operates on
// whatever is already loaded, so applying it before the real data arrives is a silent
// no-op; and scanning row locators while the table is still being constructed races the
// site's own render, causing individual rows to hit their full 5s actionability timeout
// one at a time. See the original diagnosis and proof in
// tests/functional/cart-combinations-live.spec.ts (findOrderByEmail).
export async function waitForOrdersTableToSettle(page: Page, timeoutMs = 15_000): Promise<void> {
  let lastCount = -1;
  let stableChecks = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && stableChecks < 2) {
    const count = await page.locator('#orders-body tr').count();
    stableChecks = (count === lastCount && count > 1) ? stableChecks + 1 : 0;
    lastCount = count;
    await page.waitForTimeout(1_000);
  }
}

// Finds the test order in the admin orders list and opens its detail modal.
// Returns the orderId read from the modal DOM so subsequent helpers can use it.
//
// searchName defaults to 'SENTINEL CHECKOUT' — the name registerForCheckout() fills by
// default, and what every other caller of this shared helper registers under. Only pass
// an override when the caller registered its account under a different name (e.g.
// data-boundary-live.spec.ts's ACCOUNT_A/ACCOUNT_B, needed for admin-order-search-isolation
// to be able to distinguish two test customers by name).
export async function findAndOpenOrderInAdmin(
  page: Page,
  checkoutEmail: string,
  cfOrderId: string | null,
  searchName = 'SENTINEL CHECKOUT',
): Promise<string | null> {
  await page.waitForTimeout(2_000); // allow the admin page itself to finish loading

  // Prefer opening directly by ID when the CF gave us one
  if (cfOrderId) {
    try {
      await openOrderModal(page, cfOrderId);
      const modalOrderId = await getModalOrderId(page);
      if (modalOrderId) return modalOrderId;
      await closeOrderModal(page);
    } catch {
      // The direct-ID lookup can fail even when the underlying Firestore doc already
      // exists and is fully correct — observed case: the admin dashboard's own order
      // list (whatever viewOrder() reads from) hadn't synced the just-created order yet,
      // right after a fresh admin login. Fall through to the search-and-retry loop below
      // instead of letting this abort the whole lookup.
    }
  }

  // Filter down to Sentinel-created rows BEFORE scanning, instead of scanning the full
  // unfiltered table — requires the table's real (async-loaded) data to have settled
  // first, or the filter is a silent no-op (see waitForOrdersTableToSettle above).
  const searchInput = page.locator('#filter-search');
  await waitForOrdersTableToSettle(page);
  await searchInput.fill(searchName);
  await page.waitForTimeout(1_500);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rows = await page.locator('#orders-body tr').all();
    for (const row of rows) {
      const rowText = await row.textContent().catch(() => '');
      if (rowText?.includes(checkoutEmail)) {
        try {
          await row.locator('button:has-text("View")').click();
          await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 });
          await page.waitForTimeout(800);
          return getModalOrderId(page);
        } catch {
          // Same admin-dashboard listener/sync latency as the direct-ID branch above — the
          // row matched, but clicking View didn't open the modal in time. Fall through to
          // the refresh-and-retry below instead of aborting the whole lookup.
        }
      }
    }
    // refreshOrders() reloads the table asynchronously the same way the initial load
    // does — wait for it to settle again and re-apply the filter, or this retry pass
    // scans the full unfiltered table just like the original bug.
    await page.locator('#orders-refresh-btn').click();
    await waitForOrdersTableToSettle(page);
    await searchInput.fill(searchName).catch(() => {});
    await page.waitForTimeout(1_500);
  }

  return null;
}

// ── Status stage definitions ──────────────────────────────────────────────────

// Each entry maps the CSS class of the next-action button to the status label
// that Firestore should persist after the click. Stages 3–5 require the
// "Yes, Force Update" override confirmation (handled inside clickAdvanceStatus).
export const STATUS_STAGES: Array<{ btnClass: string; label: string }> = [
  { btnClass: 'btn-assemble',  label: 'Assembling' },
  { btnClass: 'btn-ready',     label: 'Ready for Collection' },
  { btnClass: 'btn-transit',   label: 'In Transit' },
  { btnClass: 'btn-delivered', label: 'Delivered' },
  { btnClass: 'btn-completed', label: 'Completed' },
];
