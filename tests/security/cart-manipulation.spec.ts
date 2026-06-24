import { test, expect } from '@playwright/test';

// Cart tests observe client-side state behaviour without creating persisted data.
// Cloud Function calls are intercepted; Firestore reads are allowed through so
// product data loads normally. For unauthenticated users, Firestore write security
// rules should prevent any server-side cart changes.

test.describe('Cart manipulation', { tag: ['@security'] }, () => {

  test.beforeEach(async ({ page }) => {
    // Block Cloud Function calls (checkout, order creation, etc.)
    await page.route('**europe-west1-juelhaus-co-za.cloudfunctions.net**', route => route.abort());
  });

  // ─── cart-initial-state ──────────────────────────────────────────────────────

  test('cart-initial-state — cart is empty and total is R0.00 on page load', async ({ page }) => {
    await page.goto('/');

    // Nav badge must show 0 before any interaction
    const badgeText = await page.locator('#cart-count').textContent();
    expect(badgeText?.trim(), '#cart-count badge should start at 0').toBe('0');

    // Open the cart drawer
    await page.locator('#nav-cart').click();
    await page.locator('#cart-drawer').waitFor({ state: 'visible' });

    // Total must be R0.00 (ZAR currency, zero value)
    const totalText = await page.locator('#cart-total-amount').textContent();
    expect(totalText?.trim(), '#cart-total-amount must show R0.00 for an empty cart').toBe('R0.00');

    // "Proceed to Checkout" must be hidden when the cart is empty —
    // allowing checkout with an empty cart would be both bad UX and a logic error.
    const checkoutVisible = await page.locator('button:has-text("Proceed to Checkout")').isVisible();
    if (checkoutVisible) {
      console.error(
        '[FINDING][high] cart-initial-state: "Proceed to Checkout" is visible with an empty cart. ' +
          'Users could attempt to reach the checkout flow with no items.',
      );
    }
    expect(checkoutVisible, '"Proceed to Checkout" must be hidden for an empty cart').toBe(false);
  });

  // ─── checkout-empty-cart ─────────────────────────────────────────────────────

  test('checkout-empty-cart — goToCheckout() called with empty cart is handled gracefully', async ({ page }) => {
    let checkoutRequestFired = false;
    page.on('request', req => {
      if (/checkout|payment|order/i.test(req.url())) checkoutRequestFired = true;
    });

    await page.goto('/');
    await page.locator('#nav-cart').click();
    await page.locator('#cart-drawer').waitFor({ state: 'visible' });

    // Confirm the button is correctly hidden in the UI (also tested in cart-initial-state)
    const checkoutBtnHidden = !(await page.locator('button:has-text("Proceed to Checkout")').isVisible());
    expect(checkoutBtnHidden, '"Proceed to Checkout" is hidden — correct guard present').toBe(true);

    // Bypass the UI and call the checkout function directly to test the underlying guard.
    // This simulates a user calling goToCheckout() from the browser console.
    const callResult = await page.evaluate(() => {
      try {
        (window as any).goToCheckout?.();
        return 'called';
      } catch (e: any) {
        return `threw: ${e.message}`;
      }
    });

    await page.waitForTimeout(1_000);
    const urlAfter = page.url();

    if (checkoutRequestFired) {
      console.error(
        '[FINDING][high] checkout-empty-cart: a checkout/payment request fired after calling ' +
          'goToCheckout() on an empty cart. The function lacks a server-side empty-cart guard.',
      );
    }

    if (urlAfter.includes('checkout') || urlAfter.includes('payment')) {
      console.error(
        '[FINDING][medium] checkout-empty-cart: calling goToCheckout() with an empty cart ' +
          `navigated to "${urlAfter}". The checkout page must validate cart state independently.`,
      );
    } else {
      console.log(
        `[INFO] checkout-empty-cart: goToCheckout() ${callResult}. URL unchanged (${urlAfter}). ` +
          'No checkout navigation occurred with an empty cart.',
      );
    }

    // No checkout or payment request should have fired for an empty cart.
    expect(checkoutRequestFired, 'No checkout request should fire for an empty cart').toBe(false);
  });

  // ─── cart-badge-reflects-count ───────────────────────────────────────────────

  test('cart-badge-reflects-count — clicking "Add to Cart" increments #nav-cart badge', async ({ page }) => {
    const capturedRequests: string[] = [];
    page.on('request', req => {
      if (req.method() !== 'GET') capturedRequests.push(`[${req.method()}] ${req.url().slice(0, 100)}`);
    });

    await page.goto('/');

    // Allow products to load from Firestore before interacting
    await page.locator('#gifts').scrollIntoViewIfNeeded();
    await page.waitForTimeout(2_000);

    const addBtns = page.locator('#gifts button:has-text("Add to Cart")');
    const btnCount = await addBtns.count();

    if (btnCount === 0) {
      console.error(
        '[FINDING][medium] cart-badge-reflects-count: no "Add to Cart" buttons found in #gifts ' +
          'after page load. Products may not be rendering, or the add-to-cart interaction is ' +
          'not exposed on the homepage — users have no way to add items from the landing page.',
      );
      // Skip the badge assertion — nothing to click.
      return;
    }

    console.log(`[INFO] cart-badge-reflects-count: found ${btnCount} "Add to Cart" button(s) in #gifts.`);

    const badgeBefore = (await page.locator('#cart-count').textContent())?.trim() ?? '0';

    // Click the first Add to Cart button
    await addBtns.first().click();
    await page.waitForTimeout(1_500);

    const badgeAfter = (await page.locator('#cart-count').textContent())?.trim() ?? '0';

    console.log(`[INFO] cart-badge-reflects-count: badge ${badgeBefore} → ${badgeAfter}.`);
    console.log('[INFO] cart-badge-reflects-count: outbound non-GET requests:', capturedRequests);

    if (badgeAfter === badgeBefore) {
      console.error(
        '[FINDING][medium] cart-badge-reflects-count: #nav-cart badge did not update after ' +
          'clicking "Add to Cart". The cart state may not be reflected in the nav without a ' +
          'page reload, or the add-to-cart handler is broken.',
      );
    }

    const badgeCount = parseInt(badgeAfter, 10);
    expect(badgeCount, '#cart-count badge must be greater than 0 after adding an item').toBeGreaterThan(0);
  });

});
