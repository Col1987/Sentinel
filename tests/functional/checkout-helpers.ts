import { type Page } from '@playwright/test';
import { TEST_NAME_PREFIX, testEmail } from '../../src/config/sites';

export const PACK_ID           = 'wooden-whiskey';
export const PACK_LABEL        = 'The Juel';
export const EXPECTED_SUBTOTAL = 'R1,360.00';

export const ADDR = {
  property: 'Sentinel QA Property',
  unit:     '1',
  street:   'QA Avenue',
  suburb:   'Green Point',
  city:     'Cape Town',
  province: 'Western Cape',
  postal:   '8001',
  billing:  '1 QA Avenue, Green Point, Cape Town, 8001',
};
export const GUEST         = `${TEST_NAME_PREFIX} GUEST`;

// Check-in/check-out dates must be computed relative to test-run time, not hardcoded —
// the checkout config step enforces a minimum delivery lead time from "today", so a fixed
// calendar date silently starts failing once real time catches up to it (see CLAUDE.md
// "Known-working patterns": never hardcode calendar dates with a real-world time-based
// validation dependency). CHECKIN_BASE_DATE is computed fresh every time this module loads
// (i.e. every test run) — nothing here is cached or written to a file.
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(d: Date): string {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const CHECKIN_BASE_DATE = addDays(new Date(), 30);

export const CHECKIN       = formatDate(CHECKIN_BASE_DATE);
export const CHECKOUT_DATE = formatDate(addDays(CHECKIN_BASE_DATE, 3));

// For tests needing dates at a different offset from the same dynamic base (e.g.
// multi-property tests needing staggered stays) — always compute relative to
// CHECKIN_BASE_DATE rather than introducing another hardcoded calendar date.
export function dateFromCheckinBase(daysOffset: number): string {
  return formatDate(addDays(CHECKIN_BASE_DATE, daysOffset));
}

// Registers a fresh non-admin Firebase account and returns the email used.
// Admin accounts redirect from / to /admin.html, making addToCart unreachable.
export async function registerForCheckout(page: Page): Promise<string> {
  const email = testEmail(`checkout-${Date.now()}`);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-login').click();
  await page.locator('a:has-text("Register")').click();
  await page.locator('#reg-firstname').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#reg-firstname').fill('SENTINEL');
  await page.locator('#reg-lastname').fill('CHECKOUT');
  await page.locator('#reg-email').fill(email);
  await page.locator('#reg-mobile-num').fill('821234567');
  await page.locator('#reg-password').fill('Test@12345!');
  await page.locator('#reg-confirm-password').fill('Test@12345!');
  await page.locator('#reg-terms').click();
  await page.locator('button:has-text("Create Account")').click();
  // Post-registration the modal may show a verification notice instead of closing.
  await page.locator('#auth-modal').waitFor({ state: 'hidden', timeout: 8_000 }).catch(async () => {
    await page.locator('#auth-modal .modal-close').click({ force: true });
    await page.waitForTimeout(500);
  });
  console.log(`[INFO] registered checkout test account: ${email}`);
  return email;
}

export async function addPackAndGoToCheckout(page: Page): Promise<void> {
  await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID);
  await page.waitForTimeout(600);
  await page.goto('/checkout.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_500);
}

// Date-picker inputs use a custom widget — set via JS to bypass the UI widget.
// Uses querySelectorAll + last element so this works for both single-item and
// multi-item carts, where earlier items' fields remain in the DOM (hidden).
export async function setDateField(page: Page, id: string, value: string): Promise<void> {
  await page.evaluate(
    ({ id, value }: { id: string; value: string }) => {
      const els = document.querySelectorAll<HTMLInputElement>(`#${id}`);
      const el = els[els.length - 1] ?? null;
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { id, value },
  );
}

// Fills Property & Guest Details then loops through all config sub-steps
// (Wi-Fi, branding, house rules, etc.) until the delivery step appears.
// Pass wifiConfig to fill in Wi-Fi credentials; omit to click "Continue Without Wi-Fi".
export async function fillConfigStep(
  page: Page,
  wifiConfig?: { ssid: string; password: string },
): Promise<void> {
  // Use .last() throughout — when two cart items are present, item 1's form elements
  // remain in the DOM (hidden) while item 2's form is shown. .last() always targets
  // the current (most recently added) item's fields regardless of how many items
  // preceded it. Safe for single-item carts (only one element → last === first).
  await page.locator('#cfg-property').last().fill(ADDR.property);
  await page.locator('#cfg-address').last().fill(`${ADDR.unit} ${ADDR.street}, ${ADDR.suburb}, ${ADDR.city}`);
  // The breakdown button toggles the address panel — only click if it's not already open.
  // If the panel still doesn't open after click (can happen for item 2+ in multi-item carts
  // where the toggle may not respond), fall back to setting the addr fields directly via JS,
  // matching the setDateField pattern used for date inputs.
  const streetAlreadyVisible = await page.locator('#cfg-addr-street').last().isVisible({ timeout: 500 }).catch(() => false);
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
  await page.locator('#cfg-guest').last().fill(GUEST);
  await page.locator('#cfg-host-name').last().fill('SENTINEL HOST');
  await page.locator('#cfg-host-phone-num').last().fill('821234567');
  await setDateField(page, 'cfg-checkin',  CHECKIN);
  await setDateField(page, 'cfg-checkout', CHECKOUT_DATE);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await page.locator('button:has-text("Proceed to Payment →")').isVisible({ timeout: 1_000 }).catch(() => false)) {
      console.log('[INFO] fillConfigStep: reached delivery step ✓');
      return;
    }
    const wifiSkip = page.locator('button:has-text("Continue Without Wi-Fi")');
    if (await wifiSkip.isVisible({ timeout: 1_000 }).catch(() => false)) {
      if (wifiConfig) {
        // Fields #cfg-wifi-ssid and #cfg-wifi-pw are already visible at this sub-step.
        await page.locator('#cfg-wifi-ssid').last().fill(wifiConfig.ssid);
        await page.locator('#cfg-wifi-pw').last().fill(wifiConfig.password);
        await page.locator('button:has-text("Continue →")').first().click();
      } else {
        await wifiSkip.click();
      }
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

export async function advanceThroughDeliveryToPayment(page: Page): Promise<void> {
  await page.locator('button:has-text("Proceed to Payment →")').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('button:has-text("Proceed to Payment →")').click();
  const skipBtn = page.locator('button:has-text("Skip upgrades")');
  if (await skipBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await skipBtn.click();
  }
  const saveStep = page.locator('#checkout-step-save');
  if (await saveStep.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await saveStep.locator('button').last().click();
  }
  await page.locator('#checkout-step-payment').waitFor({ state: 'visible', timeout: 10_000 });
}

// Runs the full checkout flow, submits payment, and returns the checkout email
// and the order ID captured from the Cloud Function response.
// On return the browser is on the PayFast sandbox redirect page.
// Pass wifiConfig to include Wi-Fi credentials in the order; omit to skip Wi-Fi.
export async function runCheckoutFlow(
  page: Page,
  options?: { wifiConfig?: { ssid: string; password: string } },
): Promise<{ checkoutEmail: string; orderId: string | null }> {
  const checkoutEmail = await registerForCheckout(page);
  await addPackAndGoToCheckout(page);
  await fillConfigStep(page, options?.wifiConfig);
  await advanceThroughDeliveryToPayment(page);
  await page.locator('#co-billing-addr').fill(ADDR.billing);

  const cfResponsePromise = page.waitForResponse(
    res => res.url().includes('cloudfunctions.net') && res.request().method() === 'POST',
    { timeout: 30_000 },
  ).catch(() => null);

  const navigationPromise = page.waitForNavigation({ timeout: 30_000 }).catch(() => null);
  await page.locator('#pay-now-btn').click();
  const [cfResp] = await Promise.all([cfResponsePromise, navigationPromise]);

  let orderId: string | null = null;
  if (cfResp) {
    const body = await cfResp.json().catch(() => ({})) as Record<string, unknown>;
    const result = body?.result as Record<string, unknown> | undefined;
    orderId = (result?.orderId ?? result?.id ?? body?.orderId ?? null) as string | null;
  }
  if (orderId) console.log(`[INFO] CF orderId=${orderId}`);

  return { checkoutEmail, orderId };
}

// Completes a real PayFast SANDBOX payment from the PayFast redirect page reached after
// runCheckoutFlow(). Discovery (see reports/scratchpad investigation) found PayFast's
// sandbox environment presents a pre-funded test wallet rather than a raw card-entry form:
// an optional login/OTP gate (skip it), then a wallet balance with a "Complete Payment"
// button. Returns the order_id captured from the return-redirect URL (which the site's own
// checkout.js reads via `?payment=success&order_id=...`), or null if the flow didn't reach
// the expected return state within the timeout.
export async function completePayFastSandboxPayment(page: Page): Promise<string | null> {
  const skipBtn = page.locator('button:has-text("Skip")').first();
  if (await skipBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await skipBtn.click();
  }

  const walletBtn = page.locator('#pay-with-wallet');
  await walletBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await Promise.all([
    page.waitForNavigation({ timeout: 30_000 }).catch(() => null),
    walletBtn.click(),
  ]);

  // PayFast's "finish" page auto-redirects back to the merchant after a few seconds.
  // Poll page.url() rather than waitForURL — observed in practice that the redirect can
  // complete without a clean 'navigation' event firing that waitForURL reliably catches,
  // even though the browser has genuinely already arrived at the target URL.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !page.url().includes('juelhaus.co.za')) {
    await page.waitForTimeout(500);
  }
  if (!page.url().includes('juelhaus.co.za')) {
    throw new Error(`completePayFastSandboxPayment: did not return to juelhaus.co.za within 20s — stuck on "${page.url()}"`);
  }

  // page.url() updates as soon as the navigation is committed — well before the page's
  // DOMContentLoaded handler (which reads ?payment=success and renders #checkout-step-done
  // via showPayFastReturn) has actually run. Wait for load to settle before returning.
  await page.waitForLoadState('load').catch(() => {});
  await page.locator('#checkout-step-done').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});

  const url = new URL(page.url());
  return url.searchParams.get('order_id');
}

export interface OrderDocResult {
  exists: boolean | null;
  data: Record<string, unknown> | null;
  error: string | null;
}

// Reads the raw Firestore order document directly, bypassing the admin UI entirely.
// Diagnostic use confirmed this is the reliable way to verify PayFast's payment
// notification (ITN) actually reached the backend: it writes payfastStatus /
// payfastTransactionId / paidAt onto the order doc almost immediately after payment,
// completely independent of the fulfilment `status` field (Pending/Assembling/...),
// which only ever changes via manual admin action and is unrelated to payment
// confirmation. Requires the current page to be authenticated with sufficient
// Firestore read access to the order (e.g. as admin, or as the order's own owner).
export async function readOrderDocument(page: Page, orderId: string): Promise<OrderDocResult> {
  return page.evaluate(async (id) => {
    try {
      // @ts-expect-error — runs in the browser; resolved at runtime, not by tsc.
      const dbMod = await import('/js/firebase-config.js');
      // @ts-expect-error — runs in the browser; resolved at runtime via CDN, not by tsc.
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
      const snap = await fsMod.getDoc(fsMod.doc(dbMod.db, 'orders', id));
      return { exists: snap.exists(), data: snap.exists() ? snap.data() : null, error: null };
    } catch (e: any) {
      return { exists: null, data: null, error: e?.message ?? String(e) };
    }
  }, orderId);
}

export interface PayFastCallResult {
  success: boolean;
  data?: { actionUrl: string; params: Array<{ name: string; value: string }> };
  code?: string;
  message?: string;
}

// Calls the createPayFastPayment Cloud Function directly — the exact call the site's own
// checkout.js makes (see redirectToPayFast in js/checkout.js: httpsCallable(getFunctions
// (undefined, 'europe-west1'), 'createPayFastPayment')({orderId, origin, firstName,
// lastName})) — bypassing the UI entirely. Used to probe the callable's own server-side
// authorization/state checks directly, independent of what the client UI does or doesn't
// enforce. The current page must already have the default Firebase app initialised (true
// on any normal page after firebase-config.js has run). Errors are caught and returned as
// data rather than thrown, since page.evaluate() would otherwise lose the structured
// `.code` property Firebase callable errors carry.
export async function callCreatePayFastPayment(
  page: Page,
  payload: { orderId: string; origin?: string; firstName?: string; lastName?: string },
): Promise<PayFastCallResult> {
  return page.evaluate(async (p) => {
    try {
      // @ts-expect-error — runs in the browser; module is resolved at runtime via CDN, not by tsc.
      const fnsMod = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js');
      const fns = fnsMod.getFunctions(undefined, 'europe-west1');
      const result = await fnsMod.httpsCallable(fns, 'createPayFastPayment')(p);
      return { success: true, data: result.data };
    } catch (e: any) {
      return { success: false, code: e?.code, message: e?.message };
    }
  }, {
    orderId: payload.orderId,
    origin: payload.origin ?? '',
    firstName: payload.firstName ?? '',
    lastName: payload.lastName ?? '',
  });
}
