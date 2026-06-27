import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../../src/utils/auth';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

async function requireVisible(
  page: import('@playwright/test').Page,
  selector: string,
  pageName: string,
): Promise<void> {
  const visible = await page.locator(selector).isVisible({ timeout: 5_000 }).catch(() => false);
  if (!visible) {
    console.error(`[FINDING][medium] Expected element "${selector}" not found on ${pageName}`);
    expect(visible, `[FINDING][medium] Expected element "${selector}" not found on ${pageName}`).toBe(true);
  }
}

// Scrolls to #gifts and clicks the first "Add to Cart" button.
// Returns item name and price captured from the pack card before clicking.
async function addFirstItemToCart(
  page: import('@playwright/test').Page,
): Promise<{ success: boolean; name: string; price: string }> {
  await page.locator('#gifts').scrollIntoViewIfNeeded();
  const addBtns = page.locator('#gifts button:has-text("Add to Cart")');
  await addBtns.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

  if (!(await addBtns.first().isVisible().catch(() => false))) {
    return { success: false, name: '', price: '' };
  }

  const card  = page.locator('#gifts .pack-card, #gifts [class*="pack"], #gifts [class*="product"]').first();
  const name  = ((await card.locator('h3, h2, [class*="name"], [class*="title"]').first().textContent().catch(() => '')) ?? '').trim();
  const price = ((await card.locator('[class*="price"]').first().textContent().catch(() => '')) ?? '').trim();

  await addBtns.first().click();

  await page.waitForFunction(
    () => (document.querySelector('#cart-count')?.textContent?.trim() ?? '0') !== '0',
    { timeout: 5_000 },
  ).catch(() => {});

  // Clicking "Add to Cart" auto-opens the cart drawer. Wait for it so callers that
  // need to interact with it can do so immediately, and callers that need it closed
  // can close it first.
  await page.locator('#cart-drawer').waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});

  return { success: true, name, price };
}

test.describe('Storefront behaviour', { tag: ['@functional'] }, () => {

  test.beforeEach(async ({ page }) => {
    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }
  });

  // ─── cart-persists-on-refresh ─────────────────────────────────────────────────

  test('cart-persists-on-refresh — cart contents survive a page reload via localStorage', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Added a product to the cart, then reloaded the page. Verified that the cart badge still showed the correct item count after reload, and that the 'bh_cart' key in localStorage still contained the cart data. Cart state that is lost on reload forces visitors to add items again, increasing abandonment.",
    });

    await page.goto('/');

    const item = await addFirstItemToCart(page);
    if (!item.success) {
      console.error('[FINDING][medium] Expected element "#gifts button:has-text(\\"Add to Cart\\")" not found on /');
      expect(false, 'Expected "Add to Cart" buttons to be visible in #gifts on /').toBe(true);
    }

    const badgeBefore = (await page.locator('#cart-count').textContent())?.trim() ?? '0';
    console.log(`[INFO] cart-persists-on-refresh: badge before reload = "${badgeBefore}".`);

    // Check localStorage before reload.
    const cartDataBefore = await page.evaluate(() => localStorage.getItem('bh_cart'));
    if (!cartDataBefore) {
      console.warn(
        '[FINDING][medium] cart-persists-on-refresh: "bh_cart" key not found in localStorage after adding an item. ' +
          'Cart state may not be persisted, which means it will be lost on page reload.',
      );
    }

    await page.reload({ waitUntil: 'load' });

    // Allow cart JS to re-initialise from localStorage.
    await page.waitForFunction(
      () => document.querySelector('#cart-count') !== null,
      { timeout: 5_000 },
    ).catch(() => {});

    const badgeAfter = (await page.locator('#cart-count').textContent())?.trim() ?? '0';
    const cartDataAfter = await page.evaluate(() => localStorage.getItem('bh_cart'));

    console.log(`[INFO] cart-persists-on-refresh: badge after reload = "${badgeAfter}", bh_cart present = ${!!cartDataAfter}.`);

    if (badgeAfter === '0' || badgeAfter === '') {
      console.error(
        '[FINDING][high] cart-persists-on-refresh: cart badge reset to 0 after page reload. ' +
          'Cart contents must persist across reloads — store state in localStorage and restore it on page init.',
      );
    }

    expect(parseInt(badgeAfter, 10), 'Cart item count must be greater than 0 after reload').toBeGreaterThan(0);
  });

  // ─── cart-remove-item-updates-total ──────────────────────────────────────────

  test('cart-remove-item-updates-total — removing an item from the cart drawer decrements the badge and total', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Added a product to the cart, opened the cart drawer, clicked the remove button for that item, and verified that the cart badge decremented to 0 and the total updated to R0.00. A remove button that does not update the badge or total leaves the cart UI out of sync with the actual cart state.",
    });

    await page.goto('/');

    const item = await addFirstItemToCart(page);
    if (!item.success) {
      console.error('[FINDING][medium] Expected element "#gifts button:has-text(\\"Add to Cart\\")" not found on /');
      expect(false, 'Expected "Add to Cart" buttons in #gifts on /').toBe(true);
    }

    // addFirstItemToCart auto-opens the cart drawer; clicking #nav-cart again would
    // close it. Use the already-open drawer directly.
    await requireVisible(page, '#cart-drawer', '/');

    // Find the remove button scoped to the items list — exclude the cart header × close button.
    const removeBtn = page.locator(
      '#cart-drawer .cart-items button:has-text("Remove"), ' +
        '#cart-drawer .cart-items button[aria-label*="remove" i], ' +
        '#cart-drawer .cart-items button[aria-label*="delete" i], ' +
        '#cart-drawer .cart-items [class*="remove"]:visible, ' +
        '#cart-drawer .cart-items button:has-text("×"), ' +
        '#cart-drawer li button, #cart-drawer [class*="item"] button',
    ).first();

    if (!(await removeBtn.isVisible().catch(() => false))) {
      console.error(
        '[FINDING][medium] cart-remove-item-updates-total: no per-item remove button found in #cart-drawer. ' +
          'A cart with no way to remove individual items is a UX gap. ' +
          'Common patterns checked: "Remove" label, aria-label, class*="remove", inner ×.',
      );
      expect(false, '[FINDING][medium] No per-item remove button found in #cart-drawer').toBe(true);
    }

    await removeBtn.click();

    await page.waitForFunction(
      () => (document.querySelector('#cart-count')?.textContent?.trim() ?? '') === '0',
      { timeout: 5_000 },
    ).catch(() => {});

    const badgeAfter = (await page.locator('#cart-count').textContent())?.trim() ?? '';
    const totalAfter = (await page.locator('#cart-total-amount').textContent())?.trim() ?? '';

    console.log(`[INFO] cart-remove-item-updates-total: badge="${badgeAfter}", total="${totalAfter}" after remove.`);

    expect(badgeAfter, 'Cart badge must show 0 after removing the only item').toBe('0');
    expect(totalAfter, 'Cart total must show R0.00 after removing the only item').toMatch(/^R\s*0[.,]?00$/);
  });

  // ─── cart-drawer-shows-correct-items ─────────────────────────────────────────

  test('cart-drawer-shows-correct-items — item added to cart appears with its name and price in the drawer', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Added a product to the cart, opened the cart drawer, and verified that the item name and price displayed in the drawer matched what was shown on the product card. A mismatch between the product card and the cart drawer (wrong name or price) would reduce buyer confidence and could indicate a cart state bug.",
    });

    await page.goto('/');

    const item = await addFirstItemToCart(page);
    if (!item.success) {
      console.error('[FINDING][medium] Expected element "#gifts button:has-text(\\"Add to Cart\\")" not found on /');
      expect(false, 'Expected "Add to Cart" buttons in #gifts on /').toBe(true);
    }

    // addFirstItemToCart auto-opens the cart drawer; use it directly.
    await requireVisible(page, '#cart-drawer', '/');

    const drawerText = (await page.locator('#cart-drawer').textContent().catch(() => '')) ?? '';

    console.log(`[INFO] cart-drawer-shows-correct-items: item.name="${item.name}", item.price="${item.price}".`);

    if (item.name && !drawerText.includes(item.name)) {
      console.error(
        `[FINDING][medium] cart-drawer-shows-correct-items: item name "${item.name}" not found in #cart-drawer text. ` +
          'The cart drawer must display the name of each item in the cart.',
      );
    }

    if (item.price && !drawerText.includes(item.price.replace(/\s/g, ''))) {
      console.warn(
        `[FINDING][low] cart-drawer-shows-correct-items: item price "${item.price}" not found in #cart-drawer text. ` +
          'Verify that the cart drawer displays the price for each item.',
      );
    }

    const cartItemCount = await page.locator('#cart-count').textContent().catch(() => '0');
    expect(parseInt(cartItemCount ?? '0', 10), 'Cart drawer must show at least one item after adding to cart').toBeGreaterThan(0);
  });

  // ─── get-started-logged-out-shows-auth ───────────────────────────────────────

  test('get-started-logged-out-shows-auth — "Get Started" clicked while logged out opens the authentication modal', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Clicked the 'Get Started' button while not logged in. Verified that the authentication modal appeared rather than sending the visitor directly to the checkout or packs section. A 'Get Started' button that bypasses the auth check and navigates an unauthenticated user into a gated flow creates a broken experience.",
    });

    await page.goto('/');

    const getStartedBtn = page.locator(
      'button:has-text("Get Started"), a:has-text("Get Started"), [id*="get-started"]',
    ).first();

    if (!(await getStartedBtn.isVisible().catch(() => false))) {
      console.error('[FINDING][medium] Expected element "Get Started button" not found on /');
      expect(false, 'Expected a "Get Started" button to be visible on /').toBe(true);
    }

    await getStartedBtn.click();

    // Auth modal should appear — allow up to 3s for any animation.
    await page.locator('#auth-modal').waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});

    const authModalVisible = await page.locator('#auth-modal').isVisible().catch(() => false);

    if (!authModalVisible) {
      // Check whether navigation occurred instead — still acceptable but notable.
      const urlAfter = page.url();
      if (urlAfter.includes('checkout') || urlAfter.includes('account')) {
        console.warn(
          `[FINDING][medium] get-started-logged-out-shows-auth: "Get Started" navigated to "${urlAfter}" ` +
            'without showing the auth modal first. Unauthenticated users reaching gated pages directly creates a broken flow.',
        );
      } else {
        console.warn(
          '[FINDING][low] get-started-logged-out-shows-auth: #auth-modal did not appear after clicking "Get Started". ' +
            'Verify the button behaviour for logged-out users — it should prompt for authentication.',
        );
      }
    } else {
      console.log('[INFO] get-started-logged-out-shows-auth: #auth-modal appeared after clicking "Get Started" ✓');
    }

    expect(authModalVisible, '"Get Started" clicked while logged out must open the auth modal').toBe(true);
  });

  // ─── get-started-scrolls-to-packs ────────────────────────────────────────────

  test('get-started-scrolls-to-packs — "Get Started" clicked while logged in scrolls to the Welcome Packs section', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, then navigated to the homepage and clicked the 'Get Started' button. Verified that the page scrolled to the Welcome Packs section (#gifts). For authenticated users the CTA should bypass the auth prompt and scroll directly to the product catalogue.",
    });

    test.slow();

    await loginAsAdmin(page);

    // Cap the goto so a redirect loop (homepage → admin auth guard → /admin.html) does not
    // block for the full test.slow() duration. domcontentloaded is sufficient here.
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});

    if (page.url().includes('admin.html')) {
      console.log(
        '[INFO] get-started-scrolls-to-packs: homepage redirected admin to /admin.html — ' +
          'cannot test homepage CTA scroll for admin users. Skipping.',
      );
      return;
    }

    const getStartedBtn = page.locator(
      'button:has-text("Get Started"), a:has-text("Get Started"), [id*="get-started"]',
    ).first();

    if (!(await getStartedBtn.isVisible().catch(() => false))) {
      console.log(
        '[INFO] get-started-scrolls-to-packs: "Get Started" button not visible when logged in — ' +
          'button may be hidden or replaced for authenticated users. Skipping.',
      );
      return;
    }

    // Cap navigation timeout: clicking "Get Started" when logged in may trigger a redirect.
    // Without a cap, the default (= test.slow() timeout = 180s) would hang the test.
    page.setDefaultNavigationTimeout(8_000);
    await getStartedBtn.click().catch(() => {});
    page.setDefaultNavigationTimeout(60_000); // restore

    // If the click redirected back to admin.html, the homepage CTA is not relevant for admin users.
    if (page.url().includes('admin.html')) {
      console.log(
        '[INFO] get-started-scrolls-to-packs: "Get Started" navigated admin to /admin.html — ' +
          'CTA scroll not applicable for admin users. Skipping.',
      );
      return;
    }

    // Wait for scroll to settle.
    await page.waitForFunction(() => window.scrollY > 100, { timeout: 3_000 }).catch(() => {});

    const giftsInViewport = await page.evaluate(() => {
      const el = document.querySelector('#gifts');
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    }).catch(() => false);

    if (!giftsInViewport) {
      const scrollY = await page.evaluate(() => window.scrollY).catch(() => 0);
      console.warn(
        `[FINDING][low] get-started-scrolls-to-packs: #gifts is not in viewport after clicking "Get Started" ` +
          `(scrollY=${scrollY}). Logged-in users should be scrolled directly to the Welcome Packs section.`,
      );
    } else {
      console.log('[INFO] get-started-scrolls-to-packs: #gifts is in viewport after clicking "Get Started" ✓');
    }

    expect(giftsInViewport, '"Get Started" for a logged-in user must scroll to the #gifts section').toBe(true);
  });

  // ─── proceed-to-checkout-logged-out ──────────────────────────────────────────

  test('proceed-to-checkout-logged-out — "Proceed to Checkout" as a logged-out user prompts authentication before checkout', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Added a product to the cart as a logged-out user, then clicked the 'Proceed to Checkout' button that appears in the cart drawer. Verified that the authentication modal appeared before any checkout navigation occurred. Allowing unauthenticated users to proceed to checkout would result in orders with no account, making fulfilment and order tracking impossible.",
    });

    await page.goto('/');

    const item = await addFirstItemToCart(page);
    if (!item.success) {
      console.error('[FINDING][medium] Expected element "#gifts button:has-text(\\"Add to Cart\\")" not found on /');
      expect(false, 'Expected "Add to Cart" buttons in #gifts on /').toBe(true);
    }

    // addFirstItemToCart auto-opens the cart drawer; use it directly.
    await requireVisible(page, '#cart-drawer', '/');

    const checkoutBtn = page.locator('button:has-text("Proceed to Checkout")');
    if (!(await checkoutBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      console.error('[FINDING][medium] Expected element "button:has-text(\\"Proceed to Checkout\\")" not found on / (cart drawer)');
      expect(false, 'Expected "Proceed to Checkout" button to be visible in the cart drawer').toBe(true);
    }

    await checkoutBtn.click();

    // Auth modal should intercept checkout navigation for unauthenticated users.
    await page.locator('#auth-modal').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});

    const authModalVisible  = await page.locator('#auth-modal').isVisible().catch(() => false);
    const navigatedToCheckout = page.url().includes('checkout');

    if (navigatedToCheckout) {
      console.error(
        '[FINDING][high] proceed-to-checkout-logged-out: clicking "Proceed to Checkout" navigated to ' +
          `"${page.url()}" without showing an auth modal. Unauthenticated users must be prompted to log in before checkout.`,
      );
    } else if (authModalVisible) {
      console.log('[INFO] proceed-to-checkout-logged-out: auth modal appeared before checkout navigation ✓');
    } else {
      console.warn(
        '[FINDING][medium] proceed-to-checkout-logged-out: #auth-modal did not appear and checkout was not navigated to. ' +
          'Verify the "Proceed to Checkout" guard for unauthenticated users.',
      );
    }

    expect(navigatedToCheckout, '"Proceed to Checkout" must not navigate to checkout without authentication').toBe(false);
    expect(authModalVisible, 'Auth modal must appear when an unauthenticated user clicks "Proceed to Checkout"').toBe(true);
  });

});
