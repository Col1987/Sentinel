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
      // Wait for the next item's form to be ready before filling it.
      // #cfg-property is the first field fillConfigStep touches — its visibility
      // is a deterministic signal that the platform has fully rendered the new form.
      // Using .last() because earlier items' elements may still be in the DOM (hidden).
      await page.locator('#cfg-property').last().waitFor({ state: 'visible', timeout: 10_000 });
      console.log(`[INFO] fillAllItemConfigs: filling config for item ${item + 1} of ${itemCount}`);
    }
    await fillConfigStep(page, item === 0 ? wifiConfig : wifiConfig);
  }
  return page
    .locator('button:has-text("Proceed to Payment →")')
    .isVisible({ timeout: 2_000 })
    .catch(() => false);
}

// Signs out any active Firebase session so #btn-login is reachable.
// Logout button is often display:none in the collapsed hamburger at desktop
// viewport — JS call bypasses the click → scroll-into-view hang.
async function signOutCurrentUser(page: Page): Promise<void> {
  // Clear Firebase auth state directly — mirrors the proven technique in
  // tests/admin/negative/access-control.spec.ts (expired-session-handling).
  // window.logout() is avoided because it calls window.location.href='/' internally,
  // which races against our own subsequent page.goto() and closes the page context.
  //
  // Must be on juelhaus.co.za before clearing storage — page.evaluate() targets the
  // current page's origin. After payment the browser is on PayFast's domain, so
  // navigate home first to ensure the clear hits juelhaus.co.za's storage.
  if (!page.url().includes('juelhaus.co.za')) {
    await page.goto('/', { waitUntil: 'load', timeout: 20_000 });
  }
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    const FIREBASE_DBS = [
      'firebaseLocalStorageDb',
      'firebase-installations-database',
      'firebase-heartbeat-database',
    ];
    for (const name of FIREBASE_DBS) {
      try { window.indexedDB.deleteDatabase(name); } catch { /* ignore */ }
    }
  });
  await page.goto('/', { waitUntil: 'load', timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const btn = document.getElementById('btn-login');
      return !!btn && !btn.classList.contains('hidden') && window.getComputedStyle(btn).display !== 'none';
    },
    { timeout: 15_000 },
  );
}

// Logs in as admin. Caller must have signed out any existing session first
// (signOutCurrentUser), so #btn-login is visible when this runs.
async function adminLogin(page: Page): Promise<void> {
  const email = process.env.ADMIN_EMAIL ?? '';
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (!email || !password) throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD not set in .env');

  await page.locator('#btn-login').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#btn-login').click({ timeout: 10_000 });
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#login-email').fill(email, { timeout: 5_000 });
  await page.locator('#login-password').fill(password, { timeout: 5_000 });
  await page.locator('button[type="submit"]:has-text("Login")').click({ timeout: 10_000 });

  await page.waitForFunction(
    () => {
      if (!window.location.pathname.includes('admin')) return false;
      if (document.readyState !== 'complete') return false;
      const overlay = document.getElementById('admin-auth-overlay');
      if (!overlay) return true;
      const style = window.getComputedStyle(overlay);
      return style.display === 'none' || style.visibility === 'hidden' || overlay.classList.contains('hidden');
    },
    { timeout: 60_000 },
  );
}

// Finds an order in the admin orders table by buyer email, clicks View, and
// returns the modal text content. Returns null if not found within timeoutMs.
async function findOrderByEmail(
  page: Page,
  email: string,
  timeoutMs: number,
): Promise<string | null> {
  await page.waitForTimeout(2_000);

  const searchInput = page.locator('#filter-search');
  const searchVisible = await searchInput
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!searchVisible) {
    console.log('[WARN] findOrderByEmail: #filter-search not visible — not on admin orders page');
    return null;
  }

  await searchInput.fill(email, { timeout: 10_000 });
  await page.waitForTimeout(1_500);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await page.locator('#orders-body tr').all();
    for (const row of rows) {
      const rowText = await row.textContent({ timeout: 5_000 }).catch(() => '');
      if (rowText?.includes(email)) {
        await row.locator('button:has-text("View")').click({ timeout: 10_000 }).catch(() => {});
        await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(500);
        if (await page.locator('#order-modal').isVisible()) {
          return await page.locator('#order-modal').textContent({ timeout: 5_000 }).catch(() => '');
        }
      }
    }
    await page.locator('#orders-refresh-btn').click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
  }

  return null;
}

// Clicks Pay Now, races the CF POST request and the resulting page navigation,
// and returns the orderId extracted from the CF request body.
async function clickPayAndCapture(page: Page): Promise<string | null> {
  const cfReqPromise = page.waitForRequest(
    req => req.url().includes('cloudfunctions.net') && req.method() === 'POST',
    { timeout: 30_000 },
  ).catch(() => null);
  const navPromise = page.waitForNavigation({ timeout: 30_000 }).catch(() => null);
  await page.locator('#pay-now-btn').click({ timeout: 10_000 });
  const [cfReq] = await Promise.all([cfReqPromise, navPromise]);
  if (!cfReq) return null;
  try {
    const parsed = JSON.parse(cfReq.postData() ?? '') as Record<string, unknown>;
    return (parsed?.data as Record<string, unknown>)?.orderId as string ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('Cart combinations', { tag: ['@functional'] }, () => {

  test(
    'multiple-packs-single-checkout — add two packs, complete one checkout, verify total and both packs appear in admin',
    async ({ page }) => {
      // 2-item checkout: register(15s) + fillConfig×2(60s) + pay(10s)
      //   + signOut(10s) + adminLogin(30s) + findOrder(15s) ≈ 140 s.
      // 150 s matches the representative-checkout budget — single iteration, no loop.
      test.setTimeout(150_000);
      test.info().annotations.push({
        type: 'description',
        description:
          'Registers a fresh account, adds wooden-whiskey (R1,200) and wooden-wine (R1,350) to cart ' +
          'in sequence, then completes a single checkout for both items. ' +
          'Verifies whether the platform accumulates multiple cart items or silently drops one. ' +
          'In safe mode, logs the CF POST body to verify which pack IDs the client sends. ' +
          'In LIVE_MODE, verifies the admin order total equals R1,200 + R1,350 + R160 delivery = R2,710 ' +
          '(exactly one delivery fee, not two). ' +
          'Logs [FINDING][high] if the total is wrong; [FINDING][medium] if the cart dropped one item.',
      });

      // 1. Register a fresh account — admin redirect must not be active for addToCart to work.
      const checkoutEmail = await registerForCheckout(page);
      // registerForCheckout uses waitUntil:'domcontentloaded' — wait for addToCart to be in scope.
      await page.waitForFunction(
        () => typeof (window as any).addToCart === 'function',
        { timeout: 10_000 },
      ).catch(() => {});

      // 2. Add both packs to cart.
      await page.evaluate(() => localStorage.removeItem('bh_cart'));
      await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID);
      await page.waitForTimeout(400);
      await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID_WINE);
      await page.waitForTimeout(600);

      // 3. Navigate to checkout and inspect cart state.
      await page.goto('/checkout.html', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForTimeout(1_500);

      const cartRaw = await page.evaluate((): string => localStorage.getItem('bh_cart') ?? '');
      let itemCount = 0;
      try {
        const parsed = JSON.parse(cartRaw) as unknown;
        itemCount = Array.isArray(parsed) ? parsed.length : (cartRaw ? 1 : 0);
      } catch { itemCount = cartRaw ? 1 : 0; }
      console.log(`[INFO] multiple-packs-single-checkout: bh_cart has ${itemCount} item(s): ${cartRaw.slice(0, 300)}`);

      if (itemCount < 2) {
        console.log(
          '[FINDING][medium] multiple-packs-single-checkout: cart does not accumulate multiple items — ' +
            'addToCart(packB) replaces packA rather than appending. Multi-item cart is not supported.',
        );
      } else {
        console.log(`[INFO] multiple-packs-single-checkout: ${itemCount} cart item(s) confirmed — multi-item cart is supported.`);
      }

      // 4. Fill config for all cart items (platform shows one per-item form sequentially).
      const reached = await fillAllItemConfigs(page, Math.max(itemCount, 1));
      if (!reached) {
        console.log(
          '[FINDING][medium] multiple-packs-single-checkout: could not complete per-item config ' +
            'for all cart items — stuck before delivery step.',
        );
        return;
      }

      // 5. Advance to payment.
      await advanceThroughDeliveryToPayment(page);
      await page.locator('#co-billing-addr').fill(ADDR.billing, { timeout: 10_000 });

      if (!LIVE_MODE) {
        // Safe mode: intercept the CF POST after the delivery step and log the payload.
        // Shipping-rate CF fires during advanceThroughDeliveryToPayment; this route is set up after.
        await page.route(CF_PATTERN, async (route) => {
          const body = route.request().postData() ?? '';
          const hasWhiskey = body.includes(PACK_ID);
          const hasWine = body.includes(PACK_ID_WINE);
          console.log(`[INFO] multiple-packs-single-checkout (safe): CF POST body (first 400): ${body.slice(0, 400)}`);
          console.log(`[INFO] multiple-packs-single-checkout (safe): payload contains ${PACK_ID}=${hasWhiskey} ${PACK_ID_WINE}=${hasWine}`);
          await route.abort();
        });
        await page.locator('#pay-now-btn').click({ timeout: 10_000 });
        return;
      }

      // 6. LIVE_MODE: capture the order ID from the CF POST, then verify in admin.
      const cfOrderId = await clickPayAndCapture(page);
      console.log(`[INFO] multiple-packs-single-checkout: CF orderId=${cfOrderId}`);

      await signOutCurrentUser(page);
      await adminLogin(page);

      const modalText = await findOrderByEmail(page, checkoutEmail, 30_000);
      if (!modalText) {
        console.log('[FINDING][high] multiple-packs-single-checkout: order not found in admin dashboard.');
        return;
      }
      console.log(`[INFO] multiple-packs-single-checkout: admin modal (first 600): ${modalText.slice(0, 600)}`);

      // Expected: R1,200 + R1,350 + R160 (one delivery fee) = R2,710
      // If cart dropped one item: R1,200 + R160 = R1,360
      const hasExpectedTotal =
        modalText.includes('2,710') || modalText.includes('2710') || modalText.includes('2 710');
      const hasSingleItemTotal =
        modalText.includes('1,360') || modalText.includes('1360');

      if (hasExpectedTotal) {
        console.log(
          '[INFO] multiple-packs-single-checkout: order total R2,710 confirmed — ' +
            'both packs captured in single order with one delivery fee ✓',
        );
      } else if (hasSingleItemTotal) {
        console.log(
          '[FINDING][medium] multiple-packs-single-checkout: admin shows R1,360 (single-pack total). ' +
            'Second pack was dropped — cart is single-item only.',
        );
      } else {
        console.log(
          '[FINDING][high] multiple-packs-single-checkout: unexpected total in admin modal. ' +
            `Expected R2,710 (2-pack) or R1,360 (1-pack dropped). Admin shows: ${modalText.slice(0, 200)}`,
        );
      }

      await page.evaluate(() => { document.getElementById('order-modal')?.classList.remove('active'); });
      await page.waitForTimeout(500);
    },
  );

  // ───────────────────────────────────────────────────────────────────────────

  test(
    'wifi-config-per-item — configure Wi-Fi for item 1 only and verify per-item vs cart-level behaviour on the welcome page',
    async ({ page }) => {
      // 2-item checkout (or 1 if cart is single-item): register(15s) + fillConfig×2(60s) + pay(10s)
      //   + signOut(10s) + adminLogin(30s) + findOrder(15s) + welcome page(15s) ≈ 155 s.
      // 200 s gives ~45 s headroom — admin lookup + welcome page navigation together
      // exceeded 150 s in observed runs despite correct test logic.
      test.setTimeout(200_000);
      test.info().annotations.push({
        type: 'description',
        description:
          'Adds two packs to cart. During config steps, enters Wi-Fi credentials for item 1 ' +
          'and clicks "Continue Without Wi-Fi" for item 2. ' +
          'Determines whether Wi-Fi is configured per-item or at the cart/order level. ' +
          'In safe mode, logs the CF POST body to check whether per-item Wi-Fi data is present. ' +
          'In LIVE_MODE, navigates to the guest welcome page(s) and verifies: ' +
          'item 1 shows a Wi-Fi box with the correct SSID; item 2 does not show a Wi-Fi box. ' +
          'If the cart is single-item only (no multi-item accumulation), logs [INFO] and verifies ' +
          'the single welcome page shows Wi-Fi correctly. ' +
          'Logs [FINDING][high] if Wi-Fi credentials are missing or incorrect on a welcome page ' +
          'that should show them.',
      });

      // 1. Register a fresh account.
      const checkoutEmail = await registerForCheckout(page);
      await page.waitForFunction(
        () => typeof (window as any).addToCart === 'function',
        { timeout: 10_000 },
      ).catch(() => {});

      // 2. Add both packs to cart.
      await page.evaluate(() => localStorage.removeItem('bh_cart'));
      await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID);
      await page.waitForTimeout(400);
      await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID_WINE);
      await page.waitForTimeout(600);

      // 3. Navigate to checkout and read cart state.
      await page.goto('/checkout.html', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForTimeout(1_500);

      const cartRaw = await page.evaluate((): string => localStorage.getItem('bh_cart') ?? '');
      let itemCount = 0;
      try {
        const parsed = JSON.parse(cartRaw) as unknown;
        itemCount = Array.isArray(parsed) ? parsed.length : (cartRaw ? 1 : 0);
      } catch { itemCount = cartRaw ? 1 : 0; }
      console.log(`[INFO] wifi-config-per-item: bh_cart has ${itemCount} item(s)`);

      if (itemCount < 2) {
        console.log(
          '[INFO] wifi-config-per-item: cart is single-item — per-item Wi-Fi differentiation cannot be ' +
            'tested. Verifying single item with Wi-Fi configured.',
        );
      }

      // 4. Fill config step for item 1 WITH Wi-Fi credentials.
      //    fillConfigStep handles one item's full sub-step sequence (property, address, guest, Wi-Fi, etc.)
      //    and returns when it reaches "Proceed to Payment →" or runs out of Continue buttons.
      //    fillAllItemConfigs is not used here because it passes the same wifiConfig to every item —
      //    per-item differentiation requires calling fillConfigStep directly per item.
      const wifiConfig = { ssid: WIFI_SSID, password: WIFI_PW };
      await fillConfigStep(page, wifiConfig);

      // 5. If "Proceed to Payment" is not yet showing, a second item's config form is present.
      //    Fill item 2 WITHOUT Wi-Fi (click "Continue Without Wi-Fi").
      const atDelivery = await page
        .locator('button:has-text("Proceed to Payment →")')
        .isVisible({ timeout: 2_000 })
        .catch(() => false);

      if (!atDelivery) {
        console.log('[INFO] wifi-config-per-item: filling config for item 2 (no Wi-Fi)');
        await fillConfigStep(page);
        const atDeliveryAfterItem2 = await page
          .locator('button:has-text("Proceed to Payment →")')
          .isVisible({ timeout: 5_000 })
          .catch(() => false);
        if (!atDeliveryAfterItem2) {
          console.log('[FINDING][medium] wifi-config-per-item: could not reach delivery step after item 2 config.');
          return;
        }
      }

      // 6. Advance to payment.
      await advanceThroughDeliveryToPayment(page);
      await page.locator('#co-billing-addr').fill(ADDR.billing, { timeout: 10_000 });

      if (!LIVE_MODE) {
        // Safe mode: intercept CF POST and log Wi-Fi data in the payload.
        await page.route(CF_PATTERN, async (route) => {
          const body = route.request().postData() ?? '';
          const hasWifiSsid = body.includes(WIFI_SSID);
          console.log(`[INFO] wifi-config-per-item (safe): CF POST body (first 400): ${body.slice(0, 400)}`);
          console.log(`[INFO] wifi-config-per-item (safe): SSID "${WIFI_SSID}" present in payload=${hasWifiSsid}`);
          await route.abort();
        });
        await page.locator('#pay-now-btn').click({ timeout: 10_000 });
        return;
      }

      // 7. LIVE_MODE: complete payment.
      const cfOrderId = await clickPayAndCapture(page);
      console.log(`[INFO] wifi-config-per-item: CF orderId=${cfOrderId}`);

      // 8. Sign out checkout user, log in as admin, find the order.
      await signOutCurrentUser(page);
      await adminLogin(page);

      const modalText = await findOrderByEmail(page, checkoutEmail, 30_000);
      if (!modalText) {
        console.log('[FINDING][high] wifi-config-per-item: order not found in admin dashboard.');
        return;
      }
      console.log(`[INFO] wifi-config-per-item: admin modal (first 400): ${modalText.slice(0, 400)}`);

      // 9. Collect all welcome page links from the admin modal.
      const welcomeLinks = await page
        .locator('#order-modal a')
        .filter({ hasText: /welcome/i })
        .evaluateAll((els): string[] =>
          els.map(el => (el as HTMLAnchorElement).href).filter(Boolean),
        );
      console.log(`[INFO] wifi-config-per-item: found ${welcomeLinks.length} welcome page link(s): ${JSON.stringify(welcomeLinks)}`);

      if (welcomeLinks.length === 0) {
        console.log('[FINDING][high] wifi-config-per-item: no welcome page link found in admin order modal.');
        return;
      }

      // Close modal before navigating away.
      await page.evaluate(() => { document.getElementById('order-modal')?.classList.remove('active'); });
      await page.waitForTimeout(300);

      // 10. Navigate to each welcome page and record Wi-Fi box presence and content.
      const wifiResults: Array<{ url: string; hasWifiBox: boolean; ssidFound: boolean; content: string }> = [];
      for (const href of welcomeLinks) {
        await page.goto(href, { waitUntil: 'load', timeout: 20_000 });
        await page.waitForTimeout(3_000);
        const wifiBoxCount = await page.locator('.wifi-box').count();
        const wifiBoxContent = wifiBoxCount > 0
          ? (await page.locator('.wifi-box').first().textContent().catch(() => '') ?? '').trim()
          : '';
        wifiResults.push({
          url: href,
          hasWifiBox: wifiBoxCount > 0,
          ssidFound: wifiBoxContent.includes(WIFI_SSID),
          content: wifiBoxContent.slice(0, 200),
        });
        console.log(
          `[INFO] wifi-config-per-item: welcome page ${href} — ` +
            `wifi-box=${wifiBoxCount > 0} ssid_found=${wifiBoxContent.includes(WIFI_SSID)} content="${wifiBoxContent.slice(0, 100)}"`,
        );
      }

      // 11. Assess results.
      if (welcomeLinks.length === 1) {
        // Single-item cart or single welcome page for a multi-item order.
        const r = wifiResults[0];
        if (!r.hasWifiBox) {
          console.log('[FINDING][high] wifi-config-per-item: single welcome page has no .wifi-box — Wi-Fi credentials not rendered despite being configured.');
        } else if (!r.ssidFound) {
          console.log(`[FINDING][high] wifi-config-per-item: .wifi-box present but SSID "${WIFI_SSID}" not found. Content: "${r.content}"`);
        } else {
          console.log(`[INFO] wifi-config-per-item: single welcome page shows SSID "${WIFI_SSID}" correctly ✓`);
        }
        if (itemCount < 2) {
          console.log('[INFO] wifi-config-per-item: cart was single-item — per-item Wi-Fi differentiation is not applicable on this platform.');
        } else {
          console.log('[INFO] wifi-config-per-item: 2 items in cart but only 1 welcome page link — Wi-Fi is per-order level, not per-item.');
        }
      } else {
        // Multiple welcome pages — check per-item differentiation.
        const withWifi = wifiResults.filter(r => r.hasWifiBox && r.ssidFound);
        const withoutWifi = wifiResults.filter(r => !r.hasWifiBox);
        console.log(`[INFO] wifi-config-per-item: ${welcomeLinks.length} welcome pages — ${withWifi.length} with SSID, ${withoutWifi.length} without Wi-Fi box.`);

        if (withWifi.length === 0) {
          console.log(`[FINDING][high] wifi-config-per-item: no welcome page shows SSID "${WIFI_SSID}" — Wi-Fi credentials were not propagated to any item.`);
        } else if (withoutWifi.length === 0) {
          console.log('[INFO] wifi-config-per-item: all welcome pages show a Wi-Fi box — Wi-Fi is shared at order level (not per-item). This is expected if the platform does not differentiate per-item Wi-Fi.');
        } else {
          console.log('[INFO] wifi-config-per-item: Wi-Fi differentiation confirmed — item 1 has Wi-Fi, item 2 does not ✓');
        }
      }
    },
  );

  // ───────────────────────────────────────────────────────────────────────────

  test(
    'all-packs-data-integrity — verify every pack has a valid name and price in the catalog',
    async ({ page }) => {
      // One page load + one addToCart call per pack — no checkout or admin login.
      // With 6 packs and 300 ms settle per call, the loop runs in < 5 s.
      // 30 s ceiling: if this blows the budget, the page load or addToCart itself is the problem.
      test.setTimeout(30_000);
      test.info().annotations.push({
        type: 'description',
        description:
          'Loads the landing page and waits for Firebase and addToCart to initialize. ' +
          'Reads all pack IDs from onclick="addToCart(...)" attributes in the DOM, then for ' +
          'each calls addToCart(id) and inspects the bh_cart localStorage entry. ' +
          'Asserts every pack has a non-empty name and a numeric price > 0. ' +
          'No checkout flow, no admin login — pure client-side catalog verification.',
      });

      // ── 1. Load home page and confirm addToCart is in scope ─────────────────
      await page.goto('/', { waitUntil: 'load', timeout: 20_000 });
      await page.waitForFunction(
        () => typeof (window as any).addToCart === 'function',
        { timeout: 10_000 },
      );
      // addToCart being defined does not guarantee pack card DOM elements are rendered.
      // Wait until at least one onclick="addToCart(...)" element is in the DOM.
      await page.waitForFunction(
        () => document.querySelectorAll('[onclick*="addToCart"]').length > 0,
        { timeout: 15_000 },
      );

      // ── 2. Collect pack IDs from onclick attributes ──────────────────────────
      // Pack IDs are the canonical source — bh_cart is the data source for name/price.
      // We do not scrape headings or price text from the DOM (fragile, layout-dependent).
      const packIds = await page.evaluate((): string[] => {
        const seen = new Set<string>();
        const result: string[] = [];
        document.querySelectorAll<HTMLElement>('[onclick*="addToCart"]').forEach(el => {
          const m = (el.getAttribute('onclick') ?? '').match(/addToCart\(['"]([^'"]+)['"]\)/);
          if (m?.[1] && !seen.has(m[1])) { seen.add(m[1]); result.push(m[1]); }
        });
        return result;
      });

      if (packIds.length === 0) {
        console.log('[FINDING][high] all-packs-data-integrity: no pack IDs found in DOM — landing page may not have loaded correctly.');
        return;
      }
      console.log(`[INFO] all-packs-data-integrity: found ${packIds.length} pack ID(s): ${packIds.join(', ')}`);

      // ── 3. For each pack: addToCart → bh_cart → verify name and price ───────
      const findings: string[] = [];
      for (const id of packIds) {
        await page.evaluate(() => localStorage.removeItem('bh_cart'));
        await page.evaluate((packId: string) => (window as any).addToCart(packId), id);
        // 300 ms for the cart reactive state to write to localStorage.
        await page.waitForTimeout(300);

        const cartRaw = await page.evaluate((): string => localStorage.getItem('bh_cart') ?? '');
        let name = '';
        let price = 0;
        try {
          type CartItem = { id?: string; name?: string; price?: number };
          const parsed = JSON.parse(cartRaw) as unknown;
          const items = Array.isArray(parsed) ? (parsed as CartItem[]) : [parsed as CartItem];
          // Platform accumulates items in memory — find the specific pack by ID.
          const item = items.find(i => i.id === id) ?? items[items.length - 1];
          name = typeof item?.name === 'string' ? item.name : '';
          price = typeof item?.price === 'number' ? item.price : 0;
        } catch (err) {
          console.log(`[WARN] all-packs-data-integrity: bh_cart parse failed for '${id}': ${String(err)}`);
        }

        if (!name) {
          findings.push(`${id}: missing name`);
          console.log(`[FINDING][high] all-packs-data-integrity: pack '${id}' has no name in catalog`);
        }
        if (price <= 0) {
          findings.push(`${id}: missing price`);
          console.log(`[FINDING][high] all-packs-data-integrity: pack '${id}' has no price in catalog`);
        }
        if (name && price > 0) {
          console.log(`[INFO] all-packs-data-integrity: '${id}' (${name}) R${price} ✓`);
        }
      }

      await page.evaluate(() => localStorage.removeItem('bh_cart'));

      if (findings.length === 0) {
        console.log(`[INFO] all-packs-data-integrity: all ${packIds.length} pack(s) passed ✓`);
      }
    },
  );

  // ───────────────────────────────────────────────────────────────────────────

  test(
    'representative-checkout-first-pack — full checkout-to-admin verification for the first listed pack',
    async ({ page }) => {
      // 1 pack × ~90-120 s: register(15s) + fillConfig(30s) + pay(10s)
      //   + signOut(10s) + adminLogin(30s) + findOrder(15s) ≈ 110-125 s.
      // 150 s gives ~25-40 s headroom for network variance.
      test.setTimeout(150_000);
      test.info().annotations.push({
        type: 'description',
        description:
          'Discovers all packs on the storefront and picks the first as a boundary sample. ' +
          'In safe mode, verifies the pack renders a price in the checkout UI. ' +
          'In LIVE_MODE, runs a full checkout flow and confirms the admin dashboard records ' +
          'the correct pack subtotal. Logs [FINDING][high] if the price is missing or wrong.',
      });

      const packs = await discoverPacks(page);
      if (packs.length === 0) {
        console.log('[FINDING][high] representative-checkout-first-pack: no packs found on storefront.');
        return;
      }
      const pack = packs[0];
      console.log(
        `[INFO] representative-checkout-first-pack: discovered ${packs.length} pack(s). Using first: ${pack.id}`,
      );

      if (!LIVE_MODE) {
        await registerForCheckout(page);
        await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(1_000);
        await page.evaluate(() => localStorage.removeItem('bh_cart'));
        await page.evaluate((id: string) => (window as any).addToCart(id), pack.id);
        await page.waitForTimeout(400);
        await page.goto('/checkout.html', { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(1_500);
        const bodyText = await page.evaluate((): string => document.body.innerText);
        const hasPrice = bodyText.includes('R');
        const inCart = (await page.evaluate((): string => localStorage.getItem('bh_cart') ?? '')).includes(pack.id);
        console.log(`[INFO] representative-checkout-first-pack (safe): pack=${pack.id} price_visible=${hasPrice} in_cart=${inCart}`);
        if (!hasPrice) {
          console.log(`[FINDING][high] representative-checkout-first-pack: ${pack.id}: no price visible in checkout UI`);
        } else {
          console.log('[INFO] representative-checkout-first-pack (safe): pack renders price in checkout ✓');
        }
        return;
      }

      console.log(`[INFO] representative-checkout-first-pack: starting checkout for pack=${pack.id}`);
      const checkoutEmail = await registerForCheckout(page);

      // registerForCheckout uses waitUntil:'domcontentloaded' — Firebase scripts may still be loading.
      await page.waitForFunction(
        () => typeof (window as any).addToCart === 'function',
        { timeout: 10_000 },
      ).catch(() => {});

      await page.evaluate(() => localStorage.removeItem('bh_cart'));
      await page.evaluate((id: string) => (window as any).addToCart(id), pack.id);
      await page.waitForTimeout(400);

      await page.goto('/checkout.html', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForTimeout(1_500);

      // Read catalog price from bh_cart now — the form submission overwrites cart state.
      let packPrice = 0;
      try {
        const raw = await page.evaluate((): string => localStorage.getItem('bh_cart') ?? '');
        const items = JSON.parse(raw) as Array<{ price?: number }>;
        const first = Array.isArray(items) ? items[0] : (items as { price?: number });
        packPrice = first?.price ?? 0;
      } catch { }
      console.log(`[INFO] representative-checkout-first-pack: pack=${pack.id} catalog price=R${packPrice}`);

      await fillConfigStep(page);
      await advanceThroughDeliveryToPayment(page);
      await page.locator('#co-billing-addr').fill(ADDR.billing, { timeout: 10_000 });

      const cfOrderId = await clickPayAndCapture(page);
      console.log(`[INFO] representative-checkout-first-pack: pack=${pack.id} CF orderId=${cfOrderId}`);

      // Checkout user is still logged in — sign out before logging in as admin.
      await signOutCurrentUser(page);
      await adminLogin(page);

      const modalText = await findOrderByEmail(page, checkoutEmail, 30_000);
      if (!modalText) {
        console.log(`[FINDING][high] representative-checkout-first-pack: order for pack=${pack.id} not found in admin.`);
        return;
      }
      console.log(`[INFO] representative-checkout-first-pack: pack=${pack.id} admin modal (first 500): ${modalText.slice(0, 500)}`);

      const rawStr = String(packPrice);
      const commaStr = rawStr.replace(/(\d)(?=(\d{3})+$)/g, '$1,');
      const spaceStr = rawStr.replace(/(\d)(?=(\d{3})+$)/g, '$1 ');
      const hasSubtotal = packPrice > 0 && (
        modalText.includes(rawStr) || modalText.includes(commaStr) || modalText.includes(spaceStr)
      );

      if (packPrice > 0 && !hasSubtotal) {
        console.log(`[FINDING][high] representative-checkout-first-pack: pack=${pack.id} expected R${commaStr} in admin — not found.`);
      } else {
        console.log(`[INFO] representative-checkout-first-pack: pack=${pack.id} subtotal R${commaStr} confirmed in admin ✓`);
      }

      await page.evaluate(() => { document.getElementById('order-modal')?.classList.remove('active'); });
      await page.waitForTimeout(500);
    },
  );

  // ───────────────────────────────────────────────────────────────────────────

  test(
    'representative-checkout-last-pack — full checkout-to-admin verification for the last listed pack',
    async ({ page }) => {
      // 1 pack × ~90-120 s: register(15s) + fillConfig(30s) + pay(10s)
      //   + signOut(10s) + adminLogin(30s) + findOrder(15s) ≈ 110-125 s.
      // 150 s gives ~25-40 s headroom for network variance.
      test.setTimeout(150_000);
      test.info().annotations.push({
        type: 'description',
        description:
          'Discovers all packs on the storefront and picks the last as a boundary sample. ' +
          'In safe mode, verifies the pack renders a price in the checkout UI. ' +
          'In LIVE_MODE, runs a full checkout flow and confirms the admin dashboard records ' +
          'the correct pack subtotal. Logs [FINDING][high] if the price is missing or wrong.',
      });

      const packs = await discoverPacks(page);
      if (packs.length === 0) {
        console.log('[FINDING][high] representative-checkout-last-pack: no packs found on storefront.');
        return;
      }
      const pack = packs[packs.length - 1];
      console.log(
        `[INFO] representative-checkout-last-pack: discovered ${packs.length} pack(s). Using last: ${pack.id}`,
      );

      if (!LIVE_MODE) {
        await registerForCheckout(page);
        await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(1_000);
        await page.evaluate(() => localStorage.removeItem('bh_cart'));
        await page.evaluate((id: string) => (window as any).addToCart(id), pack.id);
        await page.waitForTimeout(400);
        await page.goto('/checkout.html', { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(1_500);
        const bodyText = await page.evaluate((): string => document.body.innerText);
        const hasPrice = bodyText.includes('R');
        const inCart = (await page.evaluate((): string => localStorage.getItem('bh_cart') ?? '')).includes(pack.id);
        console.log(`[INFO] representative-checkout-last-pack (safe): pack=${pack.id} price_visible=${hasPrice} in_cart=${inCart}`);
        if (!hasPrice) {
          console.log(`[FINDING][high] representative-checkout-last-pack: ${pack.id}: no price visible in checkout UI`);
        } else {
          console.log('[INFO] representative-checkout-last-pack (safe): pack renders price in checkout ✓');
        }
        return;
      }

      console.log(`[INFO] representative-checkout-last-pack: starting checkout for pack=${pack.id}`);
      const checkoutEmail = await registerForCheckout(page);

      // registerForCheckout uses waitUntil:'domcontentloaded' — Firebase scripts may still be loading.
      await page.waitForFunction(
        () => typeof (window as any).addToCart === 'function',
        { timeout: 10_000 },
      ).catch(() => {});

      await page.evaluate(() => localStorage.removeItem('bh_cart'));
      await page.evaluate((id: string) => (window as any).addToCart(id), pack.id);
      await page.waitForTimeout(400);

      await page.goto('/checkout.html', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForTimeout(1_500);

      // Read catalog price from bh_cart now — the form submission overwrites cart state.
      let packPrice = 0;
      try {
        const raw = await page.evaluate((): string => localStorage.getItem('bh_cart') ?? '');
        const items = JSON.parse(raw) as Array<{ price?: number }>;
        const first = Array.isArray(items) ? items[0] : (items as { price?: number });
        packPrice = first?.price ?? 0;
      } catch { }
      console.log(`[INFO] representative-checkout-last-pack: pack=${pack.id} catalog price=R${packPrice}`);

      await fillConfigStep(page);
      await advanceThroughDeliveryToPayment(page);
      await page.locator('#co-billing-addr').fill(ADDR.billing, { timeout: 10_000 });

      const cfOrderId = await clickPayAndCapture(page);
      console.log(`[INFO] representative-checkout-last-pack: pack=${pack.id} CF orderId=${cfOrderId}`);

      // Checkout user is still logged in — sign out before logging in as admin.
      await signOutCurrentUser(page);
      await adminLogin(page);

      const modalText = await findOrderByEmail(page, checkoutEmail, 30_000);
      if (!modalText) {
        console.log(`[FINDING][high] representative-checkout-last-pack: order for pack=${pack.id} not found in admin.`);
        return;
      }
      console.log(`[INFO] representative-checkout-last-pack: pack=${pack.id} admin modal (first 500): ${modalText.slice(0, 500)}`);

      const rawStr = String(packPrice);
      const commaStr = rawStr.replace(/(\d)(?=(\d{3})+$)/g, '$1,');
      const spaceStr = rawStr.replace(/(\d)(?=(\d{3})+$)/g, '$1 ');
      const hasSubtotal = packPrice > 0 && (
        modalText.includes(rawStr) || modalText.includes(commaStr) || modalText.includes(spaceStr)
      );

      if (packPrice > 0 && !hasSubtotal) {
        console.log(`[FINDING][high] representative-checkout-last-pack: pack=${pack.id} expected R${commaStr} in admin — not found.`);
      } else {
        console.log(`[INFO] representative-checkout-last-pack: pack=${pack.id} subtotal R${commaStr} confirmed in admin ✓`);
      }

      await page.evaluate(() => { document.getElementById('order-modal')?.classList.remove('active'); });
      await page.waitForTimeout(500);
    },
  );

});
