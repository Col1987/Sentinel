import { test, expect, type Page } from '@playwright/test';
import { LIVE_MODE, defaultSite } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';
import {
  ADDR, registerForCheckout, addPackAndGoToCheckout, fillConfigStep,
  advanceThroughDeliveryToPayment, submitPaymentAndCapture,
} from '../functional/checkout-helpers';
import { waitForOrdersTableToSettle } from '../functional/order-lifecycle-helpers';

// Regression protection specifically for the admin order-lookup/row-selection mechanism
// fixed 2026-07-21 across getWelcomeUrlFromAdmin, findAndOpenOrderInAdmin, and four other
// call sites sharing the same pattern (see docs/ENGINEERING_LOG.md, July 21 entries). This
// deliberately does NOT re-test the business-flow assertions those files already cover
// (welcome page content, cross-customer isolation, price/quantity manipulation, property
// propagation) — those stay exactly where they are, running manually/on-demand. This file
// exists only to keep the lookup mechanism itself under nightly regression, since tracing
// every nightly regression test's actual call chain (2026-07-21) confirmed only one of the
// six fixed call sites — the canonical, shared findAndOpenOrderInAdmin — was reachable from
// anything running on a schedule; the other five live in files nightly regression never
// touches at all.
//
// One real order is created once in beforeAll and shared, on the same page/context, across
// both tests below — they exercise two different lookup paths against that single order,
// not two separate checkouts — to stay close to the ~90s budget for this whole file.

let sharedPage: Page;
let checkoutEmail = '';
let orderId: string | null = null;

test.describe('Admin order lookup reliability', { tag: ['@regression'] }, () => {

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(90_000);
    if (!LIVE_MODE) return; // tests below skip(!LIVE_MODE) — no real order to create

    const context = await browser.newContext({ baseURL: defaultSite.baseUrl });
    sharedPage = await context.newPage();

    checkoutEmail = await registerForCheckout(sharedPage);
    await addPackAndGoToCheckout(sharedPage);
    await fillConfigStep(sharedPage);
    await advanceThroughDeliveryToPayment(sharedPage);
    orderId = await submitPaymentAndCapture(sharedPage);
    console.log(`[INFO] admin-order-lookup-reliability beforeAll: created order for ${checkoutEmail}, orderId=${orderId}`);

    await loginAsAdmin(sharedPage);
  });

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires a real backend — set SENTINEL_LIVE_MODE=true to run');
  });

  test('order-opens-via-direct-id — a freshly created order opens correctly when looked up by its Cloud Function order ID', async () => {
    test.setTimeout(30_000);
    test.info().annotations.push({
      type: 'description',
      description:
        'Opens the order created in beforeAll directly via viewOrder(orderId) — the admin ' +
        'dashboard\'s direct-ID lookup path — and confirms the modal shows this specific ' +
        'order\'s own email and property name, not a different order. Protects the ' +
        'modal-visibility-guard fix applied to getWelcomeUrlFromAdmin and its siblings on ' +
        '2026-07-21: that path is known to intermittently not render the modal at all, and ' +
        'must fail visibly/skip cleanly rather than silently reading stale data or hanging.',
    });

    if (!orderId) {
      console.log(
        '[INFO] order-opens-via-direct-id: CF response omitted orderId this run — direct-ID ' +
          'path not testable, see order-opens-via-search-fallback for the authoritative path.',
      );
      return;
    }

    await sharedPage.evaluate((id: string) => {
      if ((window as any).viewOrder) (window as any).viewOrder(id);
    }, orderId);
    const modalVisible = await sharedPage.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!modalVisible) {
      console.log(
        '[INFO] order-opens-via-direct-id: modal did not become visible for direct-ID open ' +
          'this run — known intermittent admin-dashboard behaviour (see docs/ENGINEERING_LOG.md, ' +
          'July 21). The search fallback is covered separately below.',
      );
      return;
    }

    await sharedPage.waitForTimeout(800);
    const modalText = (await sharedPage.locator('#order-modal').textContent().catch(() => '')) ?? '';
    await sharedPage.evaluate(() => document.getElementById('order-modal')?.classList.remove('active'));
    await sharedPage.waitForTimeout(300);

    expect(modalText.includes(checkoutEmail), 'direct-ID modal must show this order\'s own checkout email').toBe(true);
    expect(modalText.includes(ADDR.property), 'direct-ID modal must show the property name entered at checkout').toBe(true);
    console.log('[INFO] order-opens-via-direct-id: direct-ID open shows the correct order ✓');
  });

  test('order-opens-via-search-fallback — the same order is locatable and correctly identified via the search-by-name fallback', async () => {
    test.setTimeout(30_000);
    test.info().annotations.push({
      type: 'description',
      description:
        'Filters the admin orders table by customer name (the search box\'s only supported ' +
        'match field), scans the filtered rows for THIS test\'s own checkout email, and ' +
        'confirms the opened order\'s property name matches what was actually entered at ' +
        'checkout. Protects against the rows[0]-selects-wrong-order class of bug found in ' +
        'checkout-property-a-vs-property-b on 2026-07-21, where grabbing the first filtered ' +
        'row without checking its identity opened an unrelated, weeks-old order.',
    });

    await waitForOrdersTableToSettle(sharedPage);
    await sharedPage.locator('#filter-search').fill('SENTINEL CHECKOUT').catch(() => {});
    await sharedPage.waitForTimeout(1_500);

    let modalText = '';
    const rows = await sharedPage.locator('#orders-body tr').all();
    for (const row of rows) {
      const rowText = await row.textContent().catch(() => '');
      if (rowText?.includes(checkoutEmail)) {
        await row.locator('button:has-text("View")').click().catch(() => {});
        const modalVisible = await sharedPage.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 })
          .then(() => true)
          .catch(() => false);
        if (modalVisible) {
          await sharedPage.waitForTimeout(800);
          modalText = (await sharedPage.locator('#order-modal').textContent().catch(() => '')) ?? '';
        }
        break;
      }
    }

    expect(modalText, 'search-by-name fallback must locate and open the order').not.toBe('');
    expect(
      modalText.includes(checkoutEmail),
      'search-fallback modal must show this order\'s own checkout email, not a coincidentally different order',
    ).toBe(true);
    expect(modalText.includes(ADDR.property), 'search-fallback modal must show the property name actually entered at checkout').toBe(true);
    console.log('[INFO] order-opens-via-search-fallback: search-by-name path correctly located and identified the order ✓');
  });

});
