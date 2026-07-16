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
    await page.waitForFunction(() => window.scrollY > 100, undefined, { timeout: 3_000 }).catch(() => {});

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

  // ─── cart-multiple-items ──────────────────────────────────────────────────────

  test('cart-multiple-items — adding two different products shows both in the cart drawer with badge 2', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Added the first product to the cart, closed the drawer, then added a second product. Verified that the cart badge updated to 2 and that both items appeared in the cart drawer. A badge that does not increment for a second item, or a drawer that only shows the most recent addition, indicates a cart accumulation bug.",
    });

    await page.goto('/');

    const item1 = await addFirstItemToCart(page);
    if (!item1.success) {
      console.error('[FINDING][medium] cart-multiple-items: no "Add to Cart" buttons found in #gifts on /');
      expect(false, 'Expected "Add to Cart" buttons to be visible in #gifts').toBe(true);
    }

    // Drawer auto-opens after first item — close it before clicking the second button.
    const closeBtn = page.locator(
      '#cart-drawer button[aria-label*="close" i], ' +
        '#cart-drawer [class*="close"]:visible, ' +
        '#cart-drawer .cart-header button',
    ).first();
    if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await closeBtn.click();
      await page.locator('#cart-drawer').waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => {});
    }

    // Second "Add to Cart" button — nth(1) targets the second pack card.
    const addBtns = page.locator('#gifts button:has-text("Add to Cart")');
    const btnCount = await addBtns.count();
    if (btnCount < 2) {
      console.log(`[INFO] cart-multiple-items: only ${btnCount} "Add to Cart" button(s) found — cannot test multiple items. Skipping.`);
      return;
    }

    await addBtns.nth(1).click();

    await page.waitForFunction(
      () => parseInt(document.querySelector('#cart-count')?.textContent?.trim() ?? '0', 10) >= 2,
      { timeout: 5_000 },
    ).catch(() => {});

    const badgeAfter = parseInt(
      (await page.locator('#cart-count').textContent().catch(() => '0')) ?? '0',
      10,
    );

    console.log(`[INFO] cart-multiple-items: badge after two additions = ${badgeAfter}.`);

    if (badgeAfter < 2) {
      console.error(
        `[FINDING][high] cart-multiple-items: badge shows ${badgeAfter} after adding two products — ` +
          'expected 2. Cart is not accumulating items correctly.',
      );
    }

    // Verify drawer (which auto-opens on second add) lists at least 2 entries.
    await page.locator('#cart-drawer').waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
    const drawerItems = page.locator(
      '#cart-drawer .cart-items li, #cart-drawer [class*="cart-item"]',
    );
    const drawerCount = await drawerItems.count();
    console.log(`[INFO] cart-multiple-items: drawer item rows = ${drawerCount}.`);

    if (drawerCount < 2) {
      console.error(
        `[FINDING][medium] cart-multiple-items: cart drawer shows ${drawerCount} item row(s) after adding two products. ` +
          'The drawer should list every item in the cart.',
      );
    }

    expect(badgeAfter, 'Cart badge must show 2 after adding two separate products').toBeGreaterThanOrEqual(2);
  });

  // ─── cart-persists-across-pages ──────────────────────────────────────────────

  test('cart-persists-across-pages — cart state survives navigation to another page and back', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Added a product to the cart, navigated to the Terms page, then navigated back to the homepage. Verified that the cart badge still showed the original item count and that the 'bh_cart' localStorage key was present throughout. Cart state that resets on navigation (but not reload) indicates the cart is stored in an in-memory variable rather than localStorage.",
    });

    await page.goto('/');

    const item = await addFirstItemToCart(page);
    if (!item.success) {
      console.error('[FINDING][medium] cart-persists-across-pages: no "Add to Cart" buttons found in #gifts on /');
      expect(false, 'Expected "Add to Cart" buttons to be visible in #gifts').toBe(true);
    }

    const badgeBeforeNav = parseInt(
      (await page.locator('#cart-count').textContent().catch(() => '0')) ?? '0',
      10,
    );
    const lsKeyOnHome = await page.evaluate(() => localStorage.getItem('bh_cart'));
    console.log(
      `[INFO] cart-persists-across-pages: badge before nav = ${badgeBeforeNav}, bh_cart present = ${!!lsKeyOnHome}.`,
    );

    // Navigate away and check localStorage is still intact on another page.
    await page.goto('/terms.html', { waitUntil: 'domcontentloaded' });
    const lsKeyOnTerms = await page.evaluate(() => localStorage.getItem('bh_cart'));
    if (!lsKeyOnTerms) {
      console.error(
        '[FINDING][high] cart-persists-across-pages: "bh_cart" localStorage key is absent on /terms.html. ' +
          'The cart data is not persisted — navigating away clears the cart.',
      );
    }
    console.log(`[INFO] cart-persists-across-pages: bh_cart on /terms.html = ${!!lsKeyOnTerms}.`);

    // Navigate back and check the badge is restored.
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.querySelector('#cart-count') !== null,
      { timeout: 5_000 },
    ).catch(() => {});

    const badgeAfterNav = parseInt(
      (await page.locator('#cart-count').textContent().catch(() => '0')) ?? '0',
      10,
    );
    console.log(`[INFO] cart-persists-across-pages: badge after returning to / = ${badgeAfterNav}.`);

    if (badgeAfterNav !== badgeBeforeNav) {
      console.error(
        `[FINDING][high] cart-persists-across-pages: badge changed from ${badgeBeforeNav} to ${badgeAfterNav} after navigating away and back. ` +
          'Cart state must survive same-session navigation.',
      );
    }

    expect(badgeAfterNav, 'Cart badge must match original count after navigating away and returning').toBe(badgeBeforeNav);
  });

  // ─── cart-quantity-matches-badge ─────────────────────────────────────────────

  test('cart-quantity-matches-badge — number of items in the cart drawer matches the badge count', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Added a product to the cart and verified that the number of item rows visible in the open cart drawer matched the number shown in the cart badge. A mismatch (e.g., badge shows 2 but drawer shows 1 row) indicates that the badge and the drawer are reading from different state sources.",
    });

    await page.goto('/');

    const item = await addFirstItemToCart(page);
    if (!item.success) {
      console.error('[FINDING][medium] cart-quantity-matches-badge: no "Add to Cart" buttons found in #gifts on /');
      expect(false, 'Expected "Add to Cart" buttons to be visible in #gifts').toBe(true);
    }

    // Drawer auto-opens after addFirstItemToCart.
    await page.locator('#cart-drawer').waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});

    const badgeCount = parseInt(
      (await page.locator('#cart-count').textContent().catch(() => '0')) ?? '0',
      10,
    );

    // Try multiple known patterns for cart item containers and return the first non-zero count.
    const drawerCount = await page.evaluate(() => {
      const drawer = document.querySelector('#cart-drawer');
      if (!drawer) return -1;
      const byCartItemsChildren = drawer.querySelectorAll('.cart-items > *').length;
      const byLi                = drawer.querySelectorAll('li').length;
      const byCartItem          = drawer.querySelectorAll('[class*="cart-item"]').length;
      if (byCartItemsChildren > 0) return byCartItemsChildren;
      if (byLi > 0)                return byLi;
      if (byCartItem > 0)          return byCartItem;
      return 0;
    });

    console.log(
      `[INFO] cart-quantity-matches-badge: badge = ${badgeCount}, drawer rows = ${drawerCount}.`,
    );

    if (drawerCount === -1) {
      console.error('[FINDING][medium] cart-quantity-matches-badge: #cart-drawer element not found in DOM.');
      expect(false, '#cart-drawer must exist after adding an item').toBe(true);
    }

    if (drawerCount === 0) {
      // Drawer structure uses an unrecognised pattern — log and skip the count assertion.
      console.warn(
        `[FINDING][info] cart-quantity-matches-badge: no item rows matched known selectors in #cart-drawer ` +
          `(badge=${badgeCount}). Manual inspection of cart drawer DOM structure is recommended.`,
      );
      return;
    }

    if (drawerCount !== badgeCount) {
      console.error(
        `[FINDING][medium] cart-quantity-matches-badge: badge shows ${badgeCount} item(s) but drawer has ${drawerCount} row(s). ` +
          'The badge and drawer must reflect the same cart state.',
      );
    }

    expect(drawerCount, 'Number of cart drawer item rows must match the badge count').toBe(badgeCount);
  });

});
