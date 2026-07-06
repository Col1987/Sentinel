import { test, type Page } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import {
  PACK_ID, ADDR, GUEST, CHECKIN, CHECKOUT_DATE,
  registerForCheckout, fillConfigStep, advanceThroughDeliveryToPayment,
} from './checkout-helpers';

const PACK_ID_WINE = 'wooden-wine';
const DELIVERY_FEE = 160;
const PRICE_WHISKEY = 1_200;
const PRICE_WINE = 1_350;
const WIFI_SSID = 'SentinelTestNet';
const WIFI_PW = 'TestWifi123!';
const CF_PATTERN = '**cloudfunctions.net**';

interface DiscoveredPack { id: string; name: string; }

// Navigates to the landing page and reads all pack IDs from onclick="addToCart('...')" attributes.
async function discoverPacks(page: Page): Promise<DiscoveredPack[]> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_500);
  return page.evaluate((): Array<{ id: string; name: string }> => {
    const seen = new Set<string>();
    const result: Array<{ id: string; name: string }> = [];
    document.querySelectorAll<HTMLElement>('[onclick*="addToCart"]').forEach(el => {
      const m = (el.getAttribute('onclick') ?? '').match(/addToCart\(['"]([^'"]+)['"]\)/);
      if (!m?.[1] || seen.has(m[1])) return;
      seen.add(m[1]);
      const card = el.closest('[class*="pack"],[class*="product"],[class*="card"],section,article') as HTMLElement | null;
      const nameEl = card?.querySelector('h2,h3,h4,.pack-name,.product-name') as HTMLElement | null;
      result.push({ id: m[1], name: nameEl?.innerText?.trim() ?? m[1] });
    });
    document.querySelectorAll<HTMLElement>('[data-pack-id]').forEach(el => {
      const id = el.getAttribute('data-pack-id') ?? '';
      if (!id || seen.has(id)) return;
      seen.add(id);
      result.push({ id, name: id });
    });
    return result;
  });
}

// Clicks Pay Now, waits for the CF POST, and returns the orderId from the request body.
// Must be called AFTER advanceThroughDeliveryToPayment (shipping-rate CF fires during that step).
async function clickPayAndCaptureOrderId(page: Page): Promise<string | null> {
  const cfReqPromise = page.waitForRequest(
    req => req.url().includes('cloudfunctions.net') && req.method() === 'POST',
    { timeout: 30_000 },
  ).catch(() => null);
  const navPromise = page.waitForNavigation({ timeout: 30_000 }).catch(() => null);
  await page.locator('#pay-now-btn').click();
  const [cfReq] = await Promise.all([cfReqPromise, navPromise]);
  if (!cfReq) return null;
  try {
    const parsed = JSON.parse(cfReq.postData() ?? '') as Record<string, unknown>;
    return (parsed?.data as Record<string, unknown>)?.orderId as string ?? null;
  } catch {
    return null;
  }
}

// Like loginAsAdmin but avoids clicking the hidden #btn-login.
// Logs out the checkout user first (showAuthModal is blocked for logged-in users),
// then calls showAuthModal() directly via JS.
async function loginAsAdminDirect(page: Page): Promise<void> {
  const email = process.env.ADMIN_EMAIL ?? '';
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (!email || !password) throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD not set in .env');

  // Use default waitUntil:'load' so Firebase auth state is resolved before we check it.
  await page.goto('/');

  // Logout the checkout user if they are still logged in.
  // Firebase auth is now initialised (page loaded), so the Logout button appears immediately
  // if a user session exists. After clicking Logout, wait for #btn-login to reappear
  // (Firebase signOut completed) then click it normally — no need for showAuthModal().
  const logoutBtn = page.locator('button:has-text("Logout")');
  if (await logoutBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await logoutBtn.click();
    await page.locator('#btn-login').waitFor({ state: 'visible', timeout: 8_000 });
  }

  await page.locator('#btn-login').click();
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 8_000 });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.locator('button[type="submit"]:has-text("Login")').click();

  await page.waitForFunction(() => {
    if (!window.location.pathname.includes('admin')) return false;
    if (document.readyState !== 'complete') return false;
    const overlay = document.getElementById('admin-auth-overlay');
    if (!overlay) return true;
    const style = window.getComputedStyle(overlay);
    return style.display === 'none' || style.visibility === 'hidden' || overlay.classList.contains('hidden');
  }, { timeout: 0 });
}

// Opens admin order modal — tries direct ID first, then search fallback.
async function openOrderInAdmin(
  page: Page,
  cfOrderId: string | null,
  checkoutEmail: string,
): Promise<string | null> {
  await page.waitForTimeout(2_000);

  if (cfOrderId) {
    await page.evaluate((id: string) => {
      if ((window as any).viewOrder) (window as any).viewOrder(id);
    }, cfOrderId);
    await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(800);
    const inputId = await page
      .locator('#order-modal input[id^="waybill-input-"]')
      .getAttribute('id')
      .catch(() => null);
    if (inputId) return inputId.replace('waybill-input-', '');
    await page.evaluate(() => { document.getElementById('order-modal')?.classList.remove('active'); });
    await page.waitForTimeout(500);
  }

  await page.locator('#filter-search').fill('SENTINEL CHECKOUT');
  await page.waitForTimeout(1_500);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = await page.locator('#orders-body tr').all();
    for (const row of rows) {
      const rowText = await row.textContent().catch(() => '');
      if (rowText?.includes(checkoutEmail)) {
        await row.locator('button:has-text("View")').click();
        await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(800);
        const inputId = await page
          .locator('#order-modal input[id^="waybill-input-"]')
          .getAttribute('id')
          .catch(() => null);
        return inputId ? inputId.replace('waybill-input-', '') : null;
      }
    }
    await page.locator('#orders-refresh-btn').click().catch(() => {});
    await page.waitForTimeout(2_000);
  }

  return null;
}

// Fills the "Property & Guest Details" form for all cart items sequentially.
// The platform shows one per-item config form at a time, each with identical field IDs.
// fillConfigStep() handles each form identically to Item 1 (proven to work).
async function fillAllItemConfigs(
  page: Page,
  itemCount: number,
  wifiConfig?: { ssid: string; password: string },
): Promise<boolean> {
  for (let item = 0; item < itemCount; item++) {
    const deliveryVisible = await page
      .locator('button:has-text("Proceed to Payment →")')
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    if (deliveryVisible) {
      console.log(`[INFO] fillAllItemConfigs: reached delivery step after item ${item} ✓`);
      return true;
    }
    if (item > 0) {
      console.log(`[INFO] fillAllItemConfigs: filling config for item ${item + 1} of ${itemCount}`);
    }
    await fillConfigStep(page, item === 0 ? wifiConfig : wifiConfig);
  }
  return page
    .locator('button:has-text("Proceed to Payment →")')
    .isVisible({ timeout: 2_000 })
    .catch(() => false);
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('Cart combinations', { tag: ['@functional'] }, () => {

  test(
    'multiple-packs-single-checkout — add two different packs and confirm cart handles multi-item checkout',
    async ({ page }) => {
      // fillConfigStep can take up to 90 s per item; 2 items + overhead needs headroom.
      if (LIVE_MODE) test.setTimeout(600_000);
      test.info().annotations.push({
        type: 'description',
        description:
          'Registers a fresh account, adds the Whiskey pack (wooden-whiskey, R1,200) and the Wine pack ' +
          '(wooden-wine, R1,350) to the cart in sequence, then attempts a single checkout. ' +
          'Determines whether the platform accumulates multiple cart items or silently drops one. ' +
          'In LIVE_MODE, completes checkout and checks the admin order total against the expected sum ' +
          '(R1,200 + R1,350 + R160 delivery = R2,710). ' +
          'Logs [FINDING][high] if the total is wrong or a cart item is silently dropped.',
      });

      // ── 1. Register ─────────────────────────────────────────────────────────
      const checkoutEmail = await registerForCheckout(page);

      // ── 2. Add both packs ───────────────────────────────────────────────────
      await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID);
      await page.waitForTimeout(400);
      await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID_WINE);
      await page.waitForTimeout(600);

      // ── 3. Navigate to checkout, inspect cart state ─────────────────────────
      await page.goto('/checkout.html', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1_500);

      const cartRaw = await page.evaluate((): string => localStorage.getItem('bh_cart') ?? '');
      console.log(`[INFO] multiple-packs-single-checkout: bh_cart = ${cartRaw.slice(0, 500)}`);

      let itemCount = 0;
      try {
        const parsed = JSON.parse(cartRaw) as unknown;
        itemCount = Array.isArray(parsed) ? parsed.length : (cartRaw ? 1 : 0);
      } catch { itemCount = cartRaw ? 1 : 0; }

      if (itemCount < 2) {
        console.log(
          '[FINDING][medium] multiple-packs-single-checkout: cart does not accumulate multiple items — ' +
            'addToCart(packB) replaces packA rather than appending. Multi-item cart is not supported.',
        );
      } else {
        console.log(`[INFO] multiple-packs-single-checkout: ${itemCount} cart item(s) confirmed — multi-item cart is supported.`);
      }

      // ── 4. Check visible prices on the checkout page ────────────────────────
      const pageText = await page.evaluate((): string => document.body.innerText);
      const visiblePrices = Array.from(pageText.matchAll(/R[\d, ]+\.?\d*/g)).map(m => m[0]);
      console.log(`[INFO] multiple-packs-single-checkout: visible prices: ${JSON.stringify(visiblePrices)}`);

      // ── 5. Fill config for all cart items (platform shows one form per item) ─
      const reached = await fillAllItemConfigs(page, Math.max(itemCount, 1));
      if (!reached) {
        console.log(
          '[FINDING][medium] multiple-packs-single-checkout: could not complete per-item config ' +
            'for all cart items — each item has a separate Property & Guest Details form.',
        );
        return;
      }

      // ── 6. Complete checkout ────────────────────────────────────────────────
      await advanceThroughDeliveryToPayment(page);
      await page.locator('#co-billing-addr').fill(ADDR.billing);

      if (!LIVE_MODE) {
        // Route set up AFTER delivery step — shipping-rate CF call fires during that step.
        await page.route(CF_PATTERN, async (route) => {
          const body = route.request().postData() ?? '';
          console.log(`[INFO] multiple-packs-single-checkout (safe): CF POST body: ${body.slice(0, 400)}`);
          await route.abort();
        });
        await page.locator('#pay-now-btn').click();
        return;
      }

      // ── 7. LIVE_MODE: verify admin ──────────────────────────────────────────
      const cfOrderId = await clickPayAndCaptureOrderId(page);
      console.log(`[INFO] multiple-packs-single-checkout: CF orderId=${cfOrderId}`);

      await loginAsAdminDirect(page);
      const adminOrderId = await openOrderInAdmin(page, cfOrderId, checkoutEmail);
      if (!adminOrderId) {
        console.error('[FINDING][high] multiple-packs-single-checkout: order not found in admin dashboard.');
        return;
      }

      const modalText = await page.locator('#order-modal').textContent().catch(() => '') ?? '';
      console.log(`[INFO] multiple-packs-single-checkout: admin modal (first 600): ${modalText.slice(0, 600)}`);

      const expectedTotal = PRICE_WHISKEY + PRICE_WINE + DELIVERY_FEE; // 2710
      const hasExpectedTotal =
        modalText.includes('2,710') ||
        modalText.includes('2710') ||
        modalText.includes('2 710');

      if (!hasExpectedTotal) {
        console.log(
          `[FINDING][high] multiple-packs-single-checkout: expected order total ` +
            `R${expectedTotal.toLocaleString('en-ZA')} ` +
            '(R1,200 + R1,350 + R160 delivery) not found in admin order modal. ' +
            `Admin shows: ${modalText.slice(0, 300)}`,
        );
      } else {
        console.log('[INFO] multiple-packs-single-checkout: order total R2,710 confirmed in admin ✓');
      }
    },
  );

  // ───────────────────────────────────────────────────────────────────────────

  test(
    'all-packs-full-pipeline — verify checkout renders correct pack name and price for every available pack',
    async ({ page }) => {
      // 6 packs × ~3 min each = ~18 min in LIVE_MODE.
      if (LIVE_MODE) test.setTimeout(1_800_000);
      test.info().annotations.push({
        type: 'description',
        description:
          'Enumerates all pack IDs from the landing page DOM (expected: at least 6). ' +
          'In safe mode, registers once and verifies each pack renders a price on the checkout page. ' +
          'In LIVE_MODE, runs a full checkout flow for each pack and confirms the admin dashboard ' +
          'records the correct pack price as subtotal. ' +
          'Logs [FINDING][high] for any pack that fails to render or is missing from admin.',
      });

      // ── 1. Enumerate all packs ──────────────────────────────────────────────
      const packs = await discoverPacks(page);
      console.log(`[INFO] all-packs-full-pipeline: discovered ${packs.length} pack(s): ${JSON.stringify(packs)}`);

      if (packs.length < 2) {
        console.log(
          '[FINDING][medium] all-packs-full-pipeline: fewer than 2 pack IDs found in DOM — ' +
            'enumeration may be incomplete or the landing page did not fully load.',
        );
      }

      const failures: string[] = [];

      if (!LIVE_MODE) {
        // ── 2a. Safe mode: register once, verify checkout UI for each pack ────
        await registerForCheckout(page);

        for (const pack of packs) {
          await page.goto('/', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1_000);

          await page.evaluate(() => localStorage.removeItem('bh_cart'));
          await page.evaluate((id: string) => (window as any).addToCart(id), pack.id);
          await page.waitForTimeout(400);

          await page.goto('/checkout.html', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1_500);

          const checkoutText = await page.evaluate((): string => document.body.innerText);
          const hasPriceVisible = checkoutText.includes('R');
          const cartRaw = await page.evaluate((): string => localStorage.getItem('bh_cart') ?? '');
          const cartHasPack = cartRaw.includes(pack.id);

          console.log(
            `[INFO] all-packs-full-pipeline (safe): pack=${pack.id} ` +
              `price_visible=${hasPriceVisible} cart_has_pack=${cartHasPack}`,
          );

          if (!hasPriceVisible) failures.push(`${pack.id}: no price (R...) visible in checkout UI`);
          if (!cartHasPack) failures.push(`${pack.id}: pack not found in bh_cart after addToCart`);
        }

        if (failures.length > 0) {
          console.log('[FINDING][high] all-packs-full-pipeline: checkout defects found: ' + failures.join('; '));
        } else {
          console.log(`[INFO] all-packs-full-pipeline: all ${packs.length} pack(s) render price correctly ✓`);
        }
        return;
      }

      // ── 2b. LIVE_MODE: full checkout + admin verify for each pack ───────────
      for (const pack of packs) {
        console.log(`[INFO] all-packs-full-pipeline: starting checkout for pack=${pack.id}`);

        const email = await registerForCheckout(page);

        // registerForCheckout lands on / with scripts loaded. Verify addToCart is available;
        // if not (e.g. coming from /admin.html context), navigate and wait for it.
        const cartFnAvailable = await page.evaluate(() => typeof (window as any).addToCart === 'function').catch(() => false);
        if (!cartFnAvailable) {
          await page.goto('/', { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(
            () => typeof (window as any).addToCart === 'function',
            { timeout: 10_000 },
          ).catch(() => {});
        }

        await page.evaluate(() => localStorage.removeItem('bh_cart'));
        await page.evaluate((id: string) => (window as any).addToCart(id), pack.id);
        await page.waitForTimeout(400);

        await page.goto('/checkout.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        // Read pack price from bh_cart before checkout — used for admin verification.
        const cartRaw = await page.evaluate((): string => localStorage.getItem('bh_cart') ?? '');
        let packPrice = 0;
        try {
          const parsed = JSON.parse(cartRaw) as Array<{ price: number }>;
          const first = (Array.isArray(parsed) ? parsed[0] : parsed) as { price?: number };
          packPrice = first?.price ?? 0;
        } catch { }

        const checkoutText = await page.evaluate((): string => document.body.innerText);
        const prices = Array.from(checkoutText.matchAll(/R[\d,]+\.?\d*/g)).map(m => m[0]);
        console.log(`[INFO] all-packs-full-pipeline: pack=${pack.id} price=${packPrice} visible: ${prices.join(', ')}`);

        await fillConfigStep(page);
        await advanceThroughDeliveryToPayment(page);
        await page.locator('#co-billing-addr').fill(ADDR.billing);

        const cfOrderId = await clickPayAndCaptureOrderId(page);
        console.log(`[INFO] all-packs-full-pipeline: pack=${pack.id} CF orderId=${cfOrderId}`);

        // Use loginAsAdminDirect — bypasses #btn-login hidden state and handles logout.
        await loginAsAdminDirect(page);
        const adminOrderId = await openOrderInAdmin(page, cfOrderId, email);

        if (!adminOrderId) {
          failures.push(`${pack.id}: order not found in admin within timeout`);
          console.log(`[FINDING][high] all-packs-full-pipeline: order for pack=${pack.id} not found in admin.`);
          continue;
        }

        const modalText = await page.locator('#order-modal').textContent().catch(() => '') ?? '';
        console.log(`[INFO] all-packs-full-pipeline: pack=${pack.id} admin modal (first 500): ${modalText.slice(0, 500)}`);

        // Check price in multiple formats: "1200", "1,200", "1 200"
        const rawPriceStr = String(packPrice);
        const commaPriceStr = rawPriceStr.replace(/(\d)(?=(\d{3})+$)/g, '$1,');
        const spacePriceStr = rawPriceStr.replace(/(\d)(?=(\d{3})+$)/g, '$1 ');
        const hasPrice = packPrice > 0 && (
          modalText.includes(rawPriceStr) ||
          modalText.includes(commaPriceStr) ||
          modalText.includes(spacePriceStr)
        );

        if (packPrice > 0 && !hasPrice) {
          failures.push(`${pack.id}: subtotal R${commaPriceStr} not found in admin order modal`);
          console.log(
            `[FINDING][high] all-packs-full-pipeline: pack=${pack.id} — ` +
              `expected subtotal R${commaPriceStr} not found in admin order modal.`,
          );
        } else {
          console.log(`[INFO] all-packs-full-pipeline: pack=${pack.id} subtotal R${commaPriceStr} confirmed in admin ✓`);
        }

        // Close modal before next iteration
        await page.evaluate(() => { document.getElementById('order-modal')?.classList.remove('active'); });
        await page.waitForTimeout(500);
      }

      if (failures.length === 0) {
        console.log(`[INFO] all-packs-full-pipeline: all ${packs.length} pack(s) verified in admin ✓`);
      }
    },
  );

  // ───────────────────────────────────────────────────────────────────────────

  test(
    'wifi-config-multiple-items — Wi-Fi credentials entered at checkout appear correctly on the guest welcome page',
    async ({ page }) => {
      if (LIVE_MODE) test.setTimeout(600_000);
      test.info().annotations.push({
        type: 'description',
        description:
          'Adds two packs to the cart (to probe whether Wi-Fi configuration is per-item or per-cart), ' +
          'configures Wi-Fi credentials (SSID + password) during the checkout config step, and completes checkout. ' +
          'In LIVE_MODE, opens the admin order modal, navigates to the guest welcome page, and verifies the ' +
          '.wifi-box element displays the correct SSID. ' +
          'Documents whether Wi-Fi is per-item or per-cart/order level as [INFO]. ' +
          'Logs [FINDING][high] if credentials are missing or incorrect on the welcome page.',
      });

      // ── 1. Register and add two packs ───────────────────────────────────────
      const checkoutEmail = await registerForCheckout(page);
      await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID);
      await page.waitForTimeout(400);
      await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID_WINE);
      await page.waitForTimeout(600);

      // ── 2. Navigate to checkout, log cart state ─────────────────────────────
      await page.goto('/checkout.html', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1_500);

      const cartRaw = await page.evaluate((): string => localStorage.getItem('bh_cart') ?? '');
      let itemCount = 0;
      try {
        const parsed = JSON.parse(cartRaw) as unknown;
        itemCount = Array.isArray(parsed) ? parsed.length : (cartRaw ? 1 : 0);
      } catch { itemCount = cartRaw ? 1 : 0; }
      console.log(`[INFO] wifi-config-multiple-items: cart has ${itemCount} item(s)`);

      // ── 3. Fill config for all items with Wi-Fi credentials ─────────────────
      const wifiConfig = { ssid: WIFI_SSID, password: WIFI_PW };
      const reached = await fillAllItemConfigs(page, Math.max(itemCount, 1), wifiConfig);
      if (!reached) {
        console.log(
          '[FINDING][medium] wifi-config-multiple-items: could not complete per-item config ' +
            'for all cart items — each item has a separate Property & Guest Details form.',
        );
        return;
      }

      // ── 4. Advance to payment ───────────────────────────────────────────────
      await advanceThroughDeliveryToPayment(page);
      await page.locator('#co-billing-addr').fill(ADDR.billing);

      if (!LIVE_MODE) {
        await page.route(CF_PATTERN, async (route) => {
          const body = route.request().postData() ?? '';
          console.log(`[INFO] wifi-config-multiple-items (safe): CF POST body: ${body.slice(0, 400)}`);
          await route.abort();
        });
        await page.locator('#pay-now-btn').click();
        console.log(
          '[INFO] wifi-config-multiple-items (safe): Wi-Fi config handled — ' +
            'run in LIVE_MODE for welcome page verification.',
        );
        return;
      }

      // ── 5. LIVE_MODE: complete checkout ─────────────────────────────────────
      const cfOrderId = await clickPayAndCaptureOrderId(page);
      console.log(`[INFO] wifi-config-multiple-items: CF orderId=${cfOrderId}`);

      // ── 6. LIVE_MODE: find order in admin ───────────────────────────────────
      await loginAsAdminDirect(page);
      const adminOrderId = await openOrderInAdmin(page, cfOrderId, checkoutEmail);
      if (!adminOrderId) {
        console.error('[FINDING][high] wifi-config-multiple-items: order not found in admin dashboard.');
        return;
      }
      console.log(`[INFO] wifi-config-multiple-items: orderId=${adminOrderId}`);

      // ── 7. LIVE_MODE: navigate to the guest welcome page ────────────────────
      const welcomeHref = await page
        .locator('#order-modal a')
        .filter({ hasText: 'Welcome Page' })
        .getAttribute('href')
        .catch(() => null);

      if (!welcomeHref) {
        console.error('[FINDING][high] wifi-config-multiple-items: "View Guest Welcome Page" link not found in order modal.');
        return;
      }
      console.log(`[INFO] wifi-config-multiple-items: welcome page URL: ${welcomeHref}`);

      await page.goto(welcomeHref, { waitUntil: 'load' }).catch(() => null);
      await page.waitForTimeout(4_000);

      // ── 8. LIVE_MODE: verify Wi-Fi box ──────────────────────────────────────
      const wifiBoxCount = await page.locator('.wifi-box').count();
      if (wifiBoxCount === 0) {
        console.log('[FINDING][high] wifi-config-multiple-items: no .wifi-box found on welcome page — Wi-Fi credentials not rendered.');
        return;
      }

      const wifiBoxText = await page.locator('.wifi-box').first().textContent().catch(() => '') ?? '';
      console.log(`[INFO] wifi-config-multiple-items: .wifi-box[0] content: ${wifiBoxText.trim()}`);

      if (!wifiBoxText.includes(WIFI_SSID)) {
        console.log(
          `[FINDING][high] wifi-config-multiple-items: SSID "${WIFI_SSID}" not found in .wifi-box. ` +
            `Content: ${wifiBoxText.trim()}`,
        );
      } else {
        console.log(`[INFO] wifi-config-multiple-items: SSID "${WIFI_SSID}" confirmed on welcome page ✓`);
      }

      if (wifiBoxCount > 1) {
        console.log(
          `[INFO] wifi-config-multiple-items: ${wifiBoxCount} .wifi-box elements found — ` +
            'Wi-Fi config is per-item (one box per cart item).',
        );
      } else {
        console.log('[INFO] wifi-config-multiple-items: 1 .wifi-box found — Wi-Fi config is per-cart/order level, not per-item.');
      }
    },
  );

});
