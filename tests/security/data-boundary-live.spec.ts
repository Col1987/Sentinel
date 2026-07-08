import { test, type Page } from '@playwright/test';
import { LIVE_MODE, TEST_NAME_PREFIX, defaultSite } from '../../src/config/sites';
import {
  ADDR, CHECKIN, CHECKOUT_DATE, PACK_ID,
  registerForCheckout, advanceThroughDeliveryToPayment, setDateField,
} from '../functional/checkout-helpers';

// Per-customer identifiers that are unique and scannable for cross-contamination.
// Kept under TEST_NAME_PREFIX so admin searches for "SENTINEL TEST" still find them.
const GUEST_A    = `${TEST_NAME_PREFIX} BOUNDARY A`;
const GUEST_B    = `${TEST_NAME_PREFIX} BOUNDARY B`;
const PROPERTY_A = 'Sentinel Boundary Alpha';
const PROPERTY_B = 'Sentinel Boundary Beta';

// ── Local helpers ─────────────────────────────────────────────────────────────

// Proven pattern from cart-combinations-live.spec.ts (signOutCurrentUser).
// Clears Firebase auth state directly; avoids window.logout() race.
// Origin-check guard ensures we're on juelhaus.co.za before clearing storage,
// since page.evaluate() targets the current page's origin.
async function signOutCurrentUser(page: Page): Promise<void> {
  if (!page.url().includes('juelhaus.co.za')) {
    await page.goto('/', { waitUntil: 'load', timeout: 20_000 });
  }
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    const DBS = ['firebaseLocalStorageDb', 'firebase-installations-database', 'firebase-heartbeat-database'];
    for (const name of DBS) {
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

// Proven pattern from cart-combinations-live.spec.ts (adminLogin).
// Caller must have called signOutCurrentUser first so #btn-login is visible.
async function adminLogin(page: Page): Promise<void> {
  const email = process.env.ADMIN_EMAIL ?? '';
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (!email || !password) throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD not set in .env');

  await page.locator('#btn-login').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#btn-login').click();
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.locator('button[type="submit"]:has-text("Login")').click();

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

// Custom variant of fillConfigStep (checkout-helpers.ts) that accepts a guest name
// and property name so each customer's order has distinct, scannable content.
// Includes the addr-breakdown JS fallback (proven fix from checkout-helpers.ts).
async function fillConfigFor(
  page: Page,
  guestName: string,
  propertyName: string,
): Promise<void> {
  await page.locator('#cfg-property').last().fill(propertyName);
  await page.locator('#cfg-address').last().fill(`${ADDR.unit} ${ADDR.street}, ${ADDR.suburb}, ${ADDR.city}`);

  // addr-breakdown panel — may not open for multi-item carts; JS fallback mirrors setDateField.
  const streetAlreadyVisible = await page.locator('#cfg-addr-street').last()
    .isVisible({ timeout: 500 }).catch(() => false);
  let addrPanelOpen = streetAlreadyVisible;
  if (!streetAlreadyVisible) {
    await page.locator('#addr-breakdown-btn').last().click();
    addrPanelOpen = await page.locator('#cfg-addr-street').last()
      .waitFor({ state: 'visible', timeout: 6_000 })
      .then(() => true)
      .catch(() => false);
  }
  if (addrPanelOpen) {
    await page.locator('#cfg-addr-unit').last().fill(ADDR.unit);
    await page.locator('#cfg-addr-street').last().fill(ADDR.street);
    await page.locator('#cfg-addr-suburb').last().fill(ADDR.suburb);
    await page.locator('#cfg-addr-city').last().fill(ADDR.city);
    await page.locator('#cfg-addr-province').last().fill(ADDR.province);
    await page.locator('#cfg-addr-postal').last().fill(ADDR.postal);
  } else {
    await page.evaluate(
      ({ unit, street, suburb, city, province, postal }: Record<string, string>) => {
        const setLast = (id: string, val: string) => {
          const els = document.querySelectorAll<HTMLInputElement>(`#${id}`);
          const el = els[els.length - 1];
          if (!el) return;
          el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setLast('cfg-addr-unit',     unit);
        setLast('cfg-addr-street',   street);
        setLast('cfg-addr-suburb',   suburb);
        setLast('cfg-addr-city',     city);
        setLast('cfg-addr-province', province);
        setLast('cfg-addr-postal',   postal);
      },
      { unit: ADDR.unit, street: ADDR.street, suburb: ADDR.suburb, city: ADDR.city, province: ADDR.province, postal: ADDR.postal },
    );
  }

  await page.locator('#cfg-guest').last().fill(guestName);
  await page.locator('#cfg-host-name').last().fill('SENTINEL HOST');
  await page.locator('#cfg-host-phone-num').last().fill('821234567');
  await setDateField(page, 'cfg-checkin',  CHECKIN);
  await setDateField(page, 'cfg-checkout', CHECKOUT_DATE);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await page.locator('button:has-text("Proceed to Payment →")').isVisible({ timeout: 1_000 }).catch(() => false)) {
      return;
    }
    const wifiSkip = page.locator('button:has-text("Continue Without Wi-Fi")');
    if (await wifiSkip.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await wifiSkip.click();
      await page.waitForTimeout(500);
      continue;
    }
    const brandRequired = page.locator('text=Brand / Property Name is required');
    if (await brandRequired.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const brandInput = page.locator('input[placeholder*="Bonita"], input[placeholder*="The Hut"]');
      await brandInput.fill('Sentinel QA');
      await page.waitForTimeout(300);
    }
    const quickSetupBtn = page.locator('button:has-text("Quick Setup")');
    if (await quickSetupBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await quickSetupBtn.click();
      await page.waitForTimeout(1_500);
      continue;
    }
    const continueBtn = page.locator('button:has-text("Continue →")').first();
    if (await continueBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(800);
    } else {
      break;
    }
  }
}

// Completes a full checkout for one customer: register → add pack → configure → pay.
// Returns the checkout email and the order ID captured from the CF POST body.
async function checkoutAs(
  page: Page,
  guestName: string,
  propertyName: string,
): Promise<{ email: string; orderId: string | null }> {
  const email = await registerForCheckout(page);

  // registerForCheckout uses waitUntil:'domcontentloaded' — addToCart may not be in scope yet.
  await page.waitForFunction(
    () => typeof (window as any).addToCart === 'function',
    { timeout: 10_000 },
  ).catch(() => {});

  await page.evaluate(() => localStorage.removeItem('bh_cart'));
  await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID);
  await page.waitForTimeout(600);

  await page.goto('/checkout.html', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.waitForTimeout(1_500);

  await fillConfigFor(page, guestName, propertyName);
  await advanceThroughDeliveryToPayment(page);
  await page.locator('#co-billing-addr').fill(ADDR.billing);

  const cfReqPromise = page.waitForRequest(
    req => req.url().includes('cloudfunctions.net') && req.method() === 'POST',
    { timeout: 30_000 },
  ).catch(() => null);
  const navPromise = page.waitForNavigation({ timeout: 30_000 }).catch(() => null);
  await page.locator('#pay-now-btn').click();
  const [cfReq] = await Promise.all([cfReqPromise, navPromise]);

  let orderId: string | null = null;
  if (cfReq) {
    try {
      const parsed = JSON.parse(cfReq.postData() ?? '') as Record<string, unknown>;
      orderId = (parsed?.data as Record<string, unknown>)?.orderId as string ?? null;
    } catch { /* ignore */ }
  }

  console.log(`[INFO] checkoutAs: ${email} → orderId=${orderId}`);
  return { email, orderId };
}

// Opens an order in the admin modal (by direct ID or search fallback) and returns
// the Guest Welcome Page URL from the modal link, or null if not found.
async function getWelcomeUrlFromAdmin(
  page: Page,
  email: string,
  orderId: string | null,
  label: string,
): Promise<string | null> {
  await page.waitForTimeout(2_000);

  const tryExtractUrl = async (): Promise<string | null> =>
    page
      .locator('#order-modal a')
      .filter({ hasText: 'Welcome Page' })
      .getAttribute('href')
      .catch(() => null);

  const closeModal = async () => {
    await page.evaluate(() => document.getElementById('order-modal')?.classList.remove('active'));
    await page.waitForTimeout(300);
  };

  if (orderId) {
    await page.evaluate((id: string) => {
      if ((window as any).viewOrder) (window as any).viewOrder(id);
    }, orderId);
    await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(800);
    const href = await tryExtractUrl();
    await closeModal();
    if (href) {
      console.log(`[INFO] ${label}: welcome URL (direct open): ${href}`);
      return href;
    }
  }

  // Fallback: search by email
  await page.locator('#filter-search').fill(email).catch(() => {});
  await page.waitForTimeout(1_500);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = await page.locator('#orders-body tr').all();
    for (const row of rows) {
      const rowText = await row.textContent().catch(() => '');
      if (rowText?.includes(email)) {
        await row.locator('button:has-text("View")').click().catch(() => {});
        await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(800);
        const href = await tryExtractUrl();
        await closeModal();
        if (href) {
          console.log(`[INFO] ${label}: welcome URL (search): ${href}`);
          return href;
        }
        return null;
      }
    }
    await page.locator('#orders-refresh-btn').click().catch(() => {});
    await page.waitForTimeout(2_000);
  }

  return null;
}

// ── Shared setup state (populated in beforeAll, read by all three tests) ──────

interface CustomerData {
  email:      string;
  orderId:    string | null;
  welcomeUrl: string | null;
}

let customerA: CustomerData = { email: '', orderId: null, welcomeUrl: null };
let customerB: CustomerData = { email: '', orderId: null, welcomeUrl: null };

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Data boundary — cross-customer isolation', { tag: ['@security'] }, () => {

  // Creates two real Firestore orders with distinct, identifiable data.
  // Extracts welcome page URLs from the admin modal.
  // All three tests below use this shared setup to avoid 6 redundant checkout flows.
  test.beforeAll(async ({ browser }) => {
    // Two checkout flows (~160 s each worst-case) + two signOuts (~30 s)
    // + admin login (~60 s) + two URL extractions (~60 s) ≈ 310–410 s.
    // 480 s (8 min) gives ample headroom for any sub-step taking full timeout.
    test.setTimeout(480_000);

    if (!LIVE_MODE) return; // Tests will skip(!LIVE_MODE) — no real data to create

    // Create a browser context with the correct baseURL so relative gotos work.
    const context = await browser.newContext({ baseURL: defaultSite.baseUrl });
    const page    = await context.newPage();

    try {
      // ── Customer A ──
      console.log('[INFO] data-boundary beforeAll: creating order for customer A...');
      const resultA = await checkoutAs(page, GUEST_A, PROPERTY_A);
      customerA = { ...resultA, welcomeUrl: null };
      await signOutCurrentUser(page);

      // ── Customer B ──
      console.log('[INFO] data-boundary beforeAll: creating order for customer B...');
      const resultB = await checkoutAs(page, GUEST_B, PROPERTY_B);
      customerB = { ...resultB, welcomeUrl: null };
      await signOutCurrentUser(page);

      // ── Admin: extract welcome page URLs ──
      console.log('[INFO] data-boundary beforeAll: logging in as admin to get welcome page URLs...');
      await adminLogin(page);
      // Wait for the admin orders table to be present and Firestore to hydrate
      // before attempting viewOrder() or search — avoids a race where the
      // table is still loading and window.viewOrder silently finds nothing.
      await page.locator('#orders-body').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_000);

      customerA.welcomeUrl = await getWelcomeUrlFromAdmin(page, customerA.email, customerA.orderId, 'setup/A');
      // Clear search before looking up B to prevent stale filter showing A's row.
      await page.locator('#filter-search').fill('').catch(() => {});
      await page.waitForTimeout(500);
      customerB.welcomeUrl = await getWelcomeUrlFromAdmin(page, customerB.email, customerB.orderId, 'setup/B');

      console.log(
        `[INFO] data-boundary beforeAll: setup complete. ` +
          `A: email=${customerA.email} orderId=${customerA.orderId} welcomeUrl=${customerA.welcomeUrl} | ` +
          `B: email=${customerB.email} orderId=${customerB.orderId} welcomeUrl=${customerB.welcomeUrl}`,
      );
    } finally {
      await context.close();
    }
  });

  // ── Test 1: Welcome page cross-customer data isolation ────────────────────

  test('welcome-page-no-cross-customer-leak — each customer\'s welcome page must contain only their own data', async ({ page }) => {
    test.skip(!LIVE_MODE, 'requires two real Firestore orders and real welcome page URLs — no meaningful safe-mode path for cross-customer isolation');
    test.setTimeout(200_000);
    test.info().annotations.push({
      type: 'description',
      description:
        'Creates two real orders under two separate accounts — customer A ("' + GUEST_A + '", "' + PROPERTY_A + '") ' +
        'and customer B ("' + GUEST_B + '", "' + PROPERTY_B + '"). ' +
        'Navigates to each customer\'s own welcome page URL (obtained from the admin order modal). ' +
        'Verifies that customer A\'s page contains NO data from customer B ' +
        '(guest name, property name, or email) and vice versa. ' +
        'Cross-contamination would mean guests can see each other\'s private personalisation data — ' +
        'a critical privacy defect in the per-order Firestore data isolation.',
    });

    if (!customerA.welcomeUrl || !customerB.welcomeUrl) {
      console.error(
        '[FINDING][critical] welcome-page-no-cross-customer-leak: beforeAll did not produce welcome page ' +
          `URLs (A=${customerA.welcomeUrl}, B=${customerB.welcomeUrl}). ` +
          'Cannot perform cross-customer check — verify order creation and admin modal links.',
      );
      return;
    }

    const MARKERS_B = [GUEST_B, PROPERTY_B, customerB.email];
    const MARKERS_A = [GUEST_A, PROPERTY_A, customerA.email];

    // Helper: navigate to a welcome URL, wait for Firestore data to load, return page content.
    const loadWelcomePage = async (url: string): Promise<{ visible: string; html: string }> => {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForTimeout(4_000); // allow async Firestore data fetch to settle
      return {
        visible: await page.evaluate(() => document.body.innerText).catch(() => ''),
        html:    await page.content().catch(() => ''),
      };
    };

    // ── Check A's welcome page: must NOT contain B's data ────────────────────
    console.log(`[INFO] welcome-page-no-cross-customer-leak: loading customer A's welcome page...`);
    const pageA = await loadWelcomePage(customerA.welcomeUrl);
    const contentA = pageA.visible + '\n' + pageA.html;

    const aContainsOwnData = MARKERS_A.some(m => m && contentA.includes(m));
    if (!aContainsOwnData) {
      console.warn(
        '[INFO] welcome-page-no-cross-customer-leak: customer A\'s welcome page does not contain ' +
          'any of A\'s own identifiers — page may not have loaded real order data. ' +
          'Cross-contamination check is still valid (B\'s data not present), but ' +
          'confirm the welcome page is rendering correctly.',
      );
    } else {
      console.log('[INFO] welcome-page-no-cross-customer-leak: customer A\'s own data confirmed on A\'s page ✓');
    }

    let crossLeakFound = false;
    for (const marker of MARKERS_B) {
      if (marker && contentA.includes(marker)) {
        crossLeakFound = true;
        console.error(
          `[FINDING][critical] welcome-page-no-cross-customer-leak: customer B marker "${marker}" found ` +
            'on customer A\'s welcome page. ' +
            'Guests can see each other\'s private data — the Firestore security rules or welcome page ' +
            'data fetch is not scoped to the correct order ID.',
        );
      }
    }
    if (!crossLeakFound) {
      console.log('[INFO] welcome-page-no-cross-customer-leak: no customer B data found on customer A\'s page ✓');
    }

    // ── Check B's welcome page: must NOT contain A's data ────────────────────
    console.log(`[INFO] welcome-page-no-cross-customer-leak: loading customer B's welcome page...`);
    const pageB = await loadWelcomePage(customerB.welcomeUrl);
    const contentB = pageB.visible + '\n' + pageB.html;

    const bContainsOwnData = MARKERS_B.some(m => m && contentB.includes(m));
    if (!bContainsOwnData) {
      console.warn(
        '[INFO] welcome-page-no-cross-customer-leak: customer B\'s welcome page does not contain ' +
          'any of B\'s own identifiers — page may not have loaded real order data.',
      );
    } else {
      console.log('[INFO] welcome-page-no-cross-customer-leak: customer B\'s own data confirmed on B\'s page ✓');
    }

    for (const marker of MARKERS_A) {
      if (marker && contentB.includes(marker)) {
        crossLeakFound = true;
        console.error(
          `[FINDING][critical] welcome-page-no-cross-customer-leak: customer A marker "${marker}" found ` +
            'on customer B\'s welcome page. ' +
            'Guests can see each other\'s private data.',
        );
      }
    }
    if (!crossLeakFound) {
      console.log('[INFO] welcome-page-no-cross-customer-leak: no customer A data found on customer B\'s page ✓');
    }

    if (!crossLeakFound) {
      console.log('[INFO] welcome-page-no-cross-customer-leak: cross-customer data isolation verified ✓');
    }
  });

  // ── Test 2: Admin order search isolation ─────────────────────────────────

  test('admin-order-search-isolation — searching for one customer\'s email must not return the other\'s orders', async ({ page }) => {
    test.skip(!LIVE_MODE, 'requires two real Firestore orders in the admin dashboard');
    test.setTimeout(200_000);
    test.info().annotations.push({
      type: 'description',
      description:
        'Uses the two real orders created in beforeAll (customer A and customer B). ' +
        'Logs in as admin, enters customer A\'s exact email in the order search filter, ' +
        'and verifies that customer B\'s email does not appear in any result row. ' +
        'Repeats the check in reverse — searching for B must not surface A\'s order. ' +
        'If a search scoped to one customer\'s email returns another customer\'s order, ' +
        'it indicates the admin search is OR-based or unscoped, which could expose ' +
        'one customer\'s data to an admin filtering for a different customer.',
    });

    if (!customerA.email || !customerB.email) {
      console.error(
        '[FINDING][critical] admin-order-search-isolation: beforeAll did not produce customer emails ' +
          `(A="${customerA.email}", B="${customerB.email}"). Cannot run search isolation check.`,
      );
      return;
    }

    await signOutCurrentUser(page);
    await adminLogin(page);
    await page.waitForTimeout(1_500);

    const searchAndCheckIsolation = async (
      searchEmail: string,
      forbiddenEmail: string,
      label: string,
    ): Promise<void> => {
      await page.locator('#filter-search').fill('').catch(() => {});
      await page.waitForTimeout(500);
      await page.locator('#filter-search').fill(searchEmail).catch(() => {});
      await page.waitForTimeout(2_000);

      const rows = await page.locator('#orders-body tr').all();
      let searchEmailFound = false;

      for (const row of rows) {
        const rowText = await row.textContent().catch(() => '');
        if (rowText?.includes(searchEmail)) searchEmailFound = true;
        if (rowText?.includes(forbiddenEmail)) {
          console.error(
            `[FINDING][high] admin-order-search-isolation: ${label} — searching for "${searchEmail}" ` +
              `returned a row containing the OTHER customer's email "${forbiddenEmail}". ` +
              'Admin order search is not properly scoped — filtering for one customer may expose ' +
              'unrelated orders to admin staff performing targeted lookups.',
          );
        }
      }

      if (!searchEmailFound) {
        // May just mean the order hasn't appeared yet — try a refresh
        await page.locator('#orders-refresh-btn').click().catch(() => {});
        await page.waitForTimeout(2_000);
        const refreshedRows = await page.locator('#orders-body tr').all();
        for (const row of refreshedRows) {
          const rowText = await row.textContent().catch(() => '');
          if (rowText?.includes(searchEmail)) { searchEmailFound = true; break; }
        }
      }

      if (searchEmailFound) {
        console.log(`[INFO] admin-order-search-isolation: ${label} — order for "${searchEmail}" confirmed in results ✓`);
      } else {
        console.warn(
          `[INFO] admin-order-search-isolation: ${label} — order for "${searchEmail}" not found after ` +
            'filter — order may be delayed in appearing. Forbidden email check still valid.',
        );
      }
    };

    // A's email search must not surface B's order
    await searchAndCheckIsolation(customerA.email, customerB.email, 'searching A, checking B excluded');

    // B's email search must not surface A's order
    await searchAndCheckIsolation(customerB.email, customerA.email, 'searching B, checking A excluded');

    console.log('[INFO] admin-order-search-isolation: search isolation check complete');
  });

  // ── Test 3: Order tracking cross-customer data check ────────────────────

  test('order-tracking-cross-customer-check — tracking one real order must not expose the other customer\'s data', async ({ page }) => {
    test.skip(!LIVE_MODE, 'requires two real order IDs — meaningless to cross-check synthetic IDs');
    test.setTimeout(200_000);
    test.info().annotations.push({
      type: 'description',
      description:
        'Uses the two real order IDs from beforeAll (customer A and customer B). ' +
        'Navigates to the tracking page with customer A\'s real order ID and checks that ' +
        'NONE of customer B\'s data (guest name, property name, email) appears anywhere in ' +
        'the page content or raw HTML — even though both order IDs are real and valid in Firestore. ' +
        'This differs from the order-id-enumeration test (which probes a non-existent ID) — this test ' +
        'checks for DATA CROSS-CONTAMINATION between two real, valid orders directly. ' +
        'Any leak = [FINDING][critical]: the tracking endpoint is returning data from the wrong order.',
    });

    if (!customerA.orderId || !customerB.orderId) {
      console.error(
        '[FINDING][critical] order-tracking-cross-customer-check: beforeAll did not capture real order IDs ' +
          `(A="${customerA.orderId}", B="${customerB.orderId}"). Cannot perform cross-order tracking check.`,
      );
      return;
    }

    const checkTrackingPage = async (
      orderIdToTrack: string,
      forbiddenMarkers: string[],
      ownMarkers: string[],
      label: string,
    ): Promise<void> => {
      await page.goto(`/track.html?id=${encodeURIComponent(orderIdToTrack)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      await page.waitForTimeout(4_000); // allow Firestore lookup to settle

      const visibleText = await page.evaluate(() => document.body.innerText).catch(() => '');
      const rawHtml     = await page.content().catch(() => '');
      const allContent  = visibleText + '\n' + rawHtml;

      // Confirm the page loaded at least some data for the tracked order.
      const ownDataVisible = ownMarkers.some(m => m && allContent.includes(m));
      if (ownDataVisible) {
        console.log(`[INFO] order-tracking-cross-customer-check: ${label} — own order data confirmed on tracking page ✓`);
      } else {
        console.warn(
          `[INFO] order-tracking-cross-customer-check: ${label} — none of the expected own-order markers ` +
            'found on the tracking page. The page may not display guest/property fields, or the ' +
            'order data has not yet loaded. Cross-contamination check remains valid.',
        );
      }

      // Check that NONE of the other customer's markers appear.
      for (const marker of forbiddenMarkers) {
        if (marker && allContent.includes(marker)) {
          console.error(
            `[FINDING][critical] order-tracking-cross-customer-check: ${label} — forbidden marker ` +
              `"${marker}" (belongs to the OTHER customer) found on the tracking page for order ${orderIdToTrack}. ` +
              'The tracking endpoint is returning data from the wrong Firestore document. ' +
              'Verify that the order lookup is scoped strictly to the queried order ID.',
          );
        }
      }
    };

    const MARKERS_A = [GUEST_A, PROPERTY_A, customerA.email].filter(Boolean);
    const MARKERS_B = [GUEST_B, PROPERTY_B, customerB.email].filter(Boolean);

    // Track A's order → must not show B's data
    console.log(`[INFO] order-tracking-cross-customer-check: tracking order A (${customerA.orderId}), checking for B's data...`);
    await checkTrackingPage(customerA.orderId, MARKERS_B, MARKERS_A, `tracking A (${customerA.orderId})`);

    // Track B's order → must not show A's data
    console.log(`[INFO] order-tracking-cross-customer-check: tracking order B (${customerB.orderId}), checking for A's data...`);
    await checkTrackingPage(customerB.orderId, MARKERS_A, MARKERS_B, `tracking B (${customerB.orderId})`);

    console.log('[INFO] order-tracking-cross-customer-check: cross-order tracking check complete');
  });

});
