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
export const CHECKIN       = '2026-07-15';
export const CHECKOUT_DATE = '2026-07-18';

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
