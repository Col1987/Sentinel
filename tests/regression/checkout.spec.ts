import { test, expect } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { PACK_LABEL, runCheckoutFlow } from '../functional/checkout-helpers';

// One representative checkout — reuses runCheckoutFlow (single pack: PACK_ID = 'wooden-whiskey',
// see checkout-helpers.ts) rather than the full all-packs/multi-item cart matrix covered in
// tests/functional/cart-combinations-live.spec.ts. Per test-cost-awareness, this suite only
// needs proof the checkout pipeline works end-to-end, not exhaustive per-pack coverage.

test.describe('Representative checkout', { tag: ['@regression'] }, () => {

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires real backend — set SENTINEL_LIVE_MODE=true to run');
  });

  test('representative-checkout-completes — a single-pack sandbox checkout reaches a confirmation or PayFast redirect', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description: `Registered a fresh account, added the '${PACK_LABEL}' welcome pack to the cart, completed checkout with test property and delivery data, and submitted payment. Confirms the checkout pipeline end-to-end without repeating the full pack/cart-combination matrix — that coverage lives in the functional suite.`,
    });

    const { checkoutEmail, orderId } = await runCheckoutFlow(page);
    console.log(`[INFO] representative-checkout-completes: checkout complete for ${checkoutEmail}, orderId=${orderId}`);

    const finalUrl = page.url();
    const reachedPayfast   = finalUrl.includes('payfast.co.za');
    const reachedDoneStep  = await page.locator('#checkout-step-done').isVisible().catch(() => false);

    if (!reachedPayfast && !reachedDoneStep) {
      console.error(
        `[FINDING][high] representative-checkout-completes: after pay click, landed on "${finalUrl}" ` +
          'with no PayFast redirect and no #checkout-step-done visible — the checkout pipeline may be broken.',
      );
    } else {
      console.log(`[INFO] representative-checkout-completes: reached ${reachedPayfast ? 'PayFast redirect' : 'confirmation step'} ✓`);
    }

    expect(reachedPayfast || reachedDoneStep, 'Checkout must reach a PayFast redirect or an in-page confirmation step').toBe(true);
  });

});
