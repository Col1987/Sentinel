import { test, expect } from '@playwright/test';
import { LIVE_MODE, TEST_NAME_PREFIX, testEmail } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';

// ── Constants confirmed from site discovery ───────────────────────────────────

const PACK_ID           = 'wooden-whiskey';
const PACK_LABEL        = 'The Juel';       // shown as "Item 1 of 1: The Juel" on checkout
const EXPECTED_SUBTOTAL = 'R1,360.00';      // confirmed from pay button text (base + delivery)

// Realistic South African address values; postal code matches Cape Town
const ADDR = {
  property: 'Sentinel QA Property',
  unit:     '1',
  street:   'QA Avenue',
  suburb:   'Green Point',
  city:     'Cape Town',
  province: 'Western Cape',
  postal:   '8001',
  billing:  '1 QA Avenue, Green Point, Cape Town, 8001',
};
const GUEST    = `${TEST_NAME_PREFIX} GUEST`;
const CHECKIN  = '2026-07-15';
const CHECKOUT_DATE = '2026-07-18';

// ── Step helpers ─────────────────────────────────────────────────────────────

// Registers a fresh non-admin Firebase account so the test lands on / with a
// normal user session. Using loginAsAdmin is not viable here because the admin
// custom claim causes an automatic redirect to /admin.html on every navigation
// to /, making addToCart (homepage-only) unreachable.
async function registerForCheckout(page: import('@playwright/test').Page): Promise<string> {
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

  // After registration the modal may show a verification-email notice rather than
  // closing automatically. Wait briefly; if still open, force-close via the X button.
  await page.locator('#auth-modal').waitFor({ state: 'hidden', timeout: 8_000 }).catch(async () => {
    await page.locator('#auth-modal .modal-close').click({ force: true });
    await page.waitForTimeout(500);
  });
  console.log(`[INFO] registered checkout test account: ${email}`);
  return email;
}

async function addPackAndGoToCheckout(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID);
  await page.waitForTimeout(600);
  await page.goto('/checkout.html', { waitUntil: 'domcontentloaded' });
  // Allow checkout JS to read cart state and render first step
  await page.waitForTimeout(1_500);
}

// Date-picker inputs use a custom widget — set via JS to bypass the UI widget
async function setDateField(
  page: import('@playwright/test').Page,
  id: string,
  value: string,
): Promise<void> {
  await page.evaluate(
    ({ id, value }: { id: string; value: string }) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { id, value },
  );
}

// Fills the Property & Guest Details step (step 1) then advances through ALL
// config sub-steps (Wi-Fi, branding, house rules, etc.) until the delivery step
// becomes active.
async function fillConfigStep(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#cfg-property').fill(ADDR.property);

  // validateStep1() reads #cfg-address directly — fill it as well as the breakdown.
  await page.locator('#cfg-address').fill(`${ADDR.unit} ${ADDR.street}, ${ADDR.suburb}, ${ADDR.city}`);

  // Expand manual address breakdown so the sub-fields persist to the order record
  await page.locator('#addr-breakdown-btn').click();
  await page.locator('#cfg-addr-street').waitFor({ state: 'visible', timeout: 6_000 });
  await page.locator('#cfg-addr-unit').fill(ADDR.unit);
  await page.locator('#cfg-addr-street').fill(ADDR.street);
  await page.locator('#cfg-addr-suburb').fill(ADDR.suburb);
  await page.locator('#cfg-addr-city').fill(ADDR.city);
  await page.locator('#cfg-addr-province').fill(ADDR.province);
  await page.locator('#cfg-addr-postal').fill(ADDR.postal);

  await page.locator('#cfg-guest').fill(GUEST);

  // Host Contact (WhatsApp) — both fields are required by validateStep1()
  await page.locator('#cfg-host-name').fill('SENTINEL HOST');
  await page.locator('#cfg-host-phone-num').fill('821234567');

  await setDateField(page, 'cfg-checkin',  CHECKIN);
  await setDateField(page, 'cfg-checkout', CHECKOUT_DATE);

  // ── Loop through all config sub-steps until the delivery step appears ───────
  // The checkout has multiple sub-steps per cart item: property details →
  // Wi-Fi → branding → (optional: house rules, restaurants, activities) →
  // delivery. Each requires "Continue →" and some require specific inputs.
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    // Done when delivery step is visible
    if (await page.locator('button:has-text("Proceed to Payment →")').isVisible({ timeout: 1_000 }).catch(() => false)) {
      console.log('[INFO] fillConfigStep: reached delivery step ✓');
      return;
    }

    // Wi-Fi sub-step: must explicitly skip or add credentials
    const wifiSkip = page.locator('button:has-text("Continue Without Wi-Fi")');
    if (await wifiSkip.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await wifiSkip.click();
      await page.waitForTimeout(500);
      continue;
    }

    // Branding sub-step: brand name is required; fill it if the error is shown
    const brandRequired = page.locator('text=Brand / Property Name is required');
    if (await brandRequired.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const brandInput = page.locator('input[placeholder*="Bonita"], input[placeholder*="The Hut"]');
      await brandInput.fill('Sentinel QA');
      await page.waitForTimeout(300);
    }

    // Welcome Card Content sub-step: choose Quick Setup (auto-fills house rules
    // and nearby restaurants from the property address — no manual entry needed)
    const quickSetupBtn = page.locator('button:has-text("Quick Setup")');
    if (await quickSetupBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await quickSetupBtn.click();
      await page.waitForTimeout(1_500); // allow auto-fill
      continue;
    }

    // Click the primary "Continue →" to advance
    const continueBtn = page.locator('button:has-text("Continue →")').first();
    if (await continueBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(800);
    } else {
      // No Continue button found — may have reached a non-standard step; stop looping
      break;
    }
  }
}

// Proceeds through the delivery step, upgrade-modal, and optional save-config step.
// Assumes fillConfigStep() already placed us at the delivery step.
async function advanceThroughDeliveryToPayment(page: import('@playwright/test').Page): Promise<void> {
  // Delivery step should already be active after fillConfigStep loop
  await page.locator('button:has-text("Proceed to Payment →")').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('button:has-text("Proceed to Payment →")').click();

  // Upgrade personalisation modal (startUpgradePersonalisation) — skip if shown
  const skipBtn = page.locator('button:has-text("Skip upgrades")');
  if (await skipBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await skipBtn.click();
  }

  // Optional "Save Property Configuration?" step — skip via its last button
  const saveStep = page.locator('#checkout-step-save');
  if (await saveStep.isVisible({ timeout: 3_000 }).catch(() => false)) {
    // Last button in the step is the "skip/no" option regardless of exact label
    await saveStep.locator('button').last().click();
  }

  // Wait for the payment step to become active
  await page.locator('#checkout-step-payment').waitFor({ state: 'visible', timeout: 10_000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Checkout flows (LIVE_MODE only)', { tag: ['@functional'] }, () => {

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires real backend — set SENTINEL_LIVE_MODE=true to run');
  });

  // ── 1. Full order creation ───────────────────────────────────────────────────

  test('checkout-creates-real-order — sandbox checkout produces a confirmation or PayFast redirect', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description: `Logged in, added the '${PACK_LABEL}' welcome pack to the cart, completed all checkout steps with test property and delivery data, and submitted payment. The site is in sandbox/TEST MODE so no real payment or delivery is made. Captured the Cloud Function order-creation response and the final page state to confirm the end-to-end pipeline is operational.`,
    });

    await registerForCheckout(page);
    await addPackAndGoToCheckout(page);
    await fillConfigStep(page);
    await advanceThroughDeliveryToPayment(page);

    // Billing address: type directly — autocomplete is convenient but not required
    await page.locator('#co-billing-addr').fill(ADDR.billing);

    // Verify expected subtotal appears on pay button before committing
    const btnText = (await page.locator('#pay-now-btn').textContent() ?? '').trim();
    if (!btnText.includes(EXPECTED_SUBTOTAL)) {
      console.warn(
        `[FINDING][medium] checkout-creates-real-order: pay button shows "${btnText}" ` +
          `but expected subtotal "${EXPECTED_SUBTOTAL}" — pack pricing may have changed.`,
      );
    } else {
      console.log(`[INFO] checkout-creates-real-order: subtotal ${EXPECTED_SUBTOTAL} confirmed on pay button ✓`);
    }

    // Monitor for the order-creation Cloud Function POST (fires before PayFast redirect)
    const cfResponsePromise = page.waitForResponse(
      res => res.url().includes('cloudfunctions.net') && res.request().method() === 'POST',
      { timeout: 30_000 },
    ).catch(() => null);

    const navigationPromise = page.waitForNavigation({ timeout: 30_000 }).catch(() => null);

    await page.locator('#pay-now-btn').click();

    const [cfResp] = await Promise.all([cfResponsePromise, navigationPromise]);

    // ── Cloud Function response ──────────────────────────────────────────────
    if (cfResp) {
      const cfStatus = cfResp.status();
      const cfUrl    = cfResp.url();
      let   orderId: string | null = null;

      try {
        const body = await cfResp.json().catch(() => ({})) as Record<string, any>;
        orderId = body?.result?.orderId ?? body?.result?.id ?? body?.orderId ?? null;
      } catch { /* non-JSON response */ }

      if (cfStatus >= 500) {
        console.error(
          `[FINDING][high] checkout-creates-real-order: Cloud Function "${cfUrl}" ` +
            `returned HTTP ${cfStatus} — order creation failed server-side.`,
        );
      } else if (cfStatus >= 400) {
        console.warn(
          `[FINDING][medium] checkout-creates-real-order: Cloud Function "${cfUrl}" ` +
            `returned HTTP ${cfStatus} — check auth or request payload.`,
        );
      } else {
        console.log(`[INFO] checkout-creates-real-order: order CF returned HTTP ${cfStatus} ✓`);
      }

      if (orderId) {
        console.log(`[LIVE ORDER CREATED] orderId=${orderId}`);
      } else {
        console.log('[INFO] checkout-creates-real-order: no orderId in CF response body — check account page for order');
      }
    } else {
      console.warn(
        '[FINDING][low] checkout-creates-real-order: no Cloud Function POST detected within 30 s ' +
          'after clicking pay — completeOrder() may not have reached the backend.',
      );
    }

    // ── Final page state ─────────────────────────────────────────────────────
    const finalUrl = page.url();

    if (finalUrl.includes('payfast.co.za')) {
      console.log(`[LIVE ORDER CREATED] confirmation=PayFast redirect — "${finalUrl}" ✓`);
    } else if (await page.locator('#checkout-step-done').isVisible().catch(() => false)) {
      console.log('[LIVE ORDER CREATED] confirmation=Order Confirmed!');
    } else {
      console.warn(
        `[FINDING][medium] checkout-creates-real-order: after pay click, landed on "${finalUrl}" ` +
          'with no PayFast redirect and no #checkout-step-done visible.',
      );
    }
  });

  // ── 2. Confirmation display ──────────────────────────────────────────────────

  test('checkout-order-confirmation-display — confirmation screen matches entered pack, price, and address', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description: `Completed a full sandbox checkout for the '${PACK_LABEL}' pack and verified that the resulting confirmation screen — whether the on-site Order Confirmed step or the PayFast sandbox page — shows the correct pack name, expected subtotal of ${EXPECTED_SUBTOTAL}, and the delivery city entered during checkout. Any mismatch is flagged as a high-severity finding.`,
    });

    await registerForCheckout(page);
    await addPackAndGoToCheckout(page);
    await fillConfigStep(page);
    await advanceThroughDeliveryToPayment(page);
    await page.locator('#co-billing-addr').fill(ADDR.billing);

    await Promise.all([
      page.waitForNavigation({ timeout: 30_000 }).catch(() => null),
      page.locator('#pay-now-btn').click(),
    ]);

    const finalUrl = page.url();

    if (finalUrl.includes('payfast.co.za')) {
      // PayFast sandbox page — check that the order description and amount are present
      const pfText = (await page.locator('body').textContent() ?? '').toLowerCase();
      const hasName   = pfText.includes(PACK_LABEL.toLowerCase()) || pfText.includes('juel');
      const hasAmount = pfText.includes('1,360') || pfText.includes('1360') || pfText.includes('1360.00');

      if (!hasName) {
        console.error(
          `[FINDING][high] checkout-order-confirmation-display: PayFast page does not mention ` +
            `"${PACK_LABEL}" — the item_name passed to PayFast may be missing or wrong.`,
        );
      } else {
        console.log('[INFO] checkout-order-confirmation-display: pack name visible on PayFast page ✓');
      }
      if (!hasAmount) {
        console.warn(
          '[FINDING][medium] checkout-order-confirmation-display: expected total (R1,360.00) not ' +
            'confirmed on PayFast page — verify the amount passed to PayFast manually.',
        );
      } else {
        console.log('[INFO] checkout-order-confirmation-display: order total visible on PayFast page ✓');
      }
      return;
    }

    // On-site done step
    const doneVisible = await page.locator('#checkout-step-done').isVisible().catch(() => false);
    if (!doneVisible) {
      console.warn(
        `[FINDING][medium] checkout-order-confirmation-display: no PayFast redirect and ` +
          `#checkout-step-done not visible — landed on "${finalUrl}".`,
      );
      return;
    }

    const doneText = (await page.locator('#checkout-step-done').textContent() ?? '').toLowerCase();
    if (!doneText.includes('confirmed') && !doneText.includes('thank you')) {
      console.error(
        '[FINDING][high] checkout-order-confirmation-display: #checkout-step-done visible but ' +
          'contains no "confirmed" or "thank you" text.',
      );
    }

    // Check account page for order details (done step has no order ID or pack name)
    await page.goto('/account.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_000);
    const accountText = (await page.locator('body').textContent() ?? '').toLowerCase();

    const findings: string[] = [];

    if (!accountText.includes(PACK_LABEL.toLowerCase()) && !accountText.includes('juel')) {
      findings.push(`pack name "${PACK_LABEL}" not found on /account.html`);
    }
    if (!accountText.includes(ADDR.city.toLowerCase())) {
      findings.push(`delivery city "${ADDR.city}" not found on /account.html`);
    }
    if (!accountText.includes('1,360') && !accountText.includes('1360')) {
      findings.push(`subtotal "${EXPECTED_SUBTOTAL}" not found on /account.html`);
    }

    for (const finding of findings) {
      console.error(`[FINDING][high] checkout-order-confirmation-display: ${finding} — order details may not have been saved correctly.`);
    }

    if (findings.length === 0) {
      console.log('[INFO] checkout-order-confirmation-display: pack name, city, and subtotal all visible on account page ✓');
    }

    expect(findings, 'Order confirmation details must match what was entered at checkout').toHaveLength(0);
  });

  // ── 3. Empty required fields ─────────────────────────────────────────────────


  test('checkout-empty-required-fields — validation prevents progression and backend rejects bare requests', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description: 'Attempted to advance through checkout without filling required fields at each step. First verified that clicking Continue on an empty config step stays on step 1 (client-side validation). Then bypassed the UI to reach the payment step with no property or delivery data configured, and monitored whether the Cloud Function rejects the order server-side.',
    });

    // No login needed for validation tests — add pack and reach checkout
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);
    await addPackAndGoToCheckout(page);

    // ── Client-side step 1: empty config → should not advance ───────────────
    await page.locator('button:has-text("Continue →")').click();
    await page.waitForTimeout(500);

    const configStillVisible = await page.locator('#checkout-step-config').isVisible().catch(() => false);
    if (!configStillVisible) {
      console.error(
        '[FINDING][high] checkout-empty-required-fields: "Continue →" with empty required fields ' +
          'advanced past step 1 — client-side validation on the config step is absent or bypassable.',
      );
    } else {
      console.log('[INFO] checkout-empty-required-fields: empty config step correctly blocked ✓');
    }

    // ── Client-side billing: empty billing address → should show #billing-error ─
    // Jump to payment step via JS (simulates a UI bypass)
    await page.evaluate(() => (window as any).showPayment?.());
    await page.waitForTimeout(800);
    if (await page.locator('button:has-text("Skip upgrades")').isVisible({ timeout: 3_000 }).catch(() => false)) {
      await page.locator('button:has-text("Skip upgrades")').click();
    }
    await page.locator('#checkout-step-payment').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});

    // Click pay with #co-billing-addr still empty
    const cfOnEmptyBilling = page.waitForRequest(
      req => req.url().includes('cloudfunctions.net') && req.method() === 'POST',
      { timeout: 5_000 },
    ).catch(() => null);

    await page.locator('#pay-now-btn').click();
    await page.waitForTimeout(600);

    const billingErrVisible = await page.locator('#billing-error').isVisible().catch(() => false);
    const cfFiredOnEmpty    = await cfOnEmptyBilling;

    if (billingErrVisible) {
      console.log('[INFO] checkout-empty-required-fields: empty billing address shows #billing-error ✓');
    } else {
      console.warn(
        '[FINDING][medium] checkout-empty-required-fields: #billing-error not visible after clicking ' +
          'pay with an empty billing address.',
      );
    }

    if (cfFiredOnEmpty) {
      // Client-side gate failed — check if server caught it
      const cfResp = await page.waitForResponse(
        res => res.url() === cfFiredOnEmpty.url(),
        { timeout: 10_000 },
      ).catch(() => null);
      if (cfResp && cfResp.status() < 400) {
        console.error(
          `[FINDING][critical] checkout-empty-required-fields: Cloud Function accepted an order ` +
            `with no billing address (HTTP ${cfResp.status()}) — no server-side billing validation.`,
        );
      } else if (cfResp) {
        console.log(
          `[INFO] checkout-empty-required-fields: CF rejected empty-billing request with HTTP ${cfResp.status()} ✓`,
        );
      }
    } else {
      console.log('[INFO] checkout-empty-required-fields: no CF request fired on empty billing — client-side gate held ✓');
    }

    // ── Server-side: fill billing but submit with no property/delivery config ──
    // completeOrder() will now pass client-side and call the Cloud Function.
    // The server should reject an order that has no configured property or delivery data.
    await page.locator('#co-billing-addr').fill(ADDR.billing);

    const cfServerValidation = page.waitForResponse(
      res => res.url().includes('cloudfunctions.net') && res.request().method() === 'POST',
      { timeout: 30_000 },
    ).catch(() => null);

    const navOnBypass = page.waitForNavigation({ timeout: 30_000 }).catch(() => null);
    await page.locator('#pay-now-btn').click();

    const [cfSrvResp] = await Promise.all([cfServerValidation, navOnBypass]);
    const finalUrl = page.url();

    if (cfSrvResp) {
      const status = cfSrvResp.status();
      const cfUrl  = cfSrvResp.url();
      if (status >= 400) {
        console.log(
          `[INFO] checkout-empty-required-fields: server rejected no-config order with HTTP ${status} ` +
            `from "${cfUrl}" ✓`,
        );
      } else {
        console.error(
          `[FINDING][critical] checkout-empty-required-fields: Cloud Function "${cfUrl}" returned ` +
            `HTTP ${status} for an order with no property or delivery data — ` +
            'server-side validation does not enforce required checkout configuration.',
        );
      }
    } else if (finalUrl.includes('payfast.co.za')) {
      console.error(
        '[FINDING][critical] checkout-empty-required-fields: PayFast redirect occurred with no property ' +
          'or delivery configuration — server-side validation is absent.',
      );
    } else {
      console.log(
        '[INFO] checkout-empty-required-fields: no CF request and no PayFast redirect with bypassed config — ' +
          'completeOrder() may require additional state from the config step.',
      );
    }
  });

  // ── 4. Admin order visibility ─────────────────────────────────────────────────

  test('checkout-order-appears-in-admin — completed checkout creates a visible order in the admin dashboard', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description: `Registers a fresh non-admin account, completes a full sandbox checkout for the '${PACK_LABEL}' welcome pack, then logs in as admin and verifies the order appears in the Orders Dashboard with the correct customer email, pack name, and total. A missing order means customer orders placed through the storefront may not reach the admin and could go unprocessed.`,
    });

    const checkoutEmail = await registerForCheckout(page);
    await addPackAndGoToCheckout(page);
    await fillConfigStep(page);
    await advanceThroughDeliveryToPayment(page);
    await page.locator('#co-billing-addr').fill(ADDR.billing);

    // The CF creates the Firestore order before the PayFast redirect fires,
    // so the order exists in the database by the time we switch to the admin view.
    await Promise.all([
      page.waitForNavigation({ timeout: 30_000 }).catch(() => null),
      page.locator('#pay-now-btn').click(),
    ]);

    console.log(`[INFO] checkout-order-appears-in-admin: checkout submitted for ${checkoutEmail}, switching to admin view`);

    await loginAsAdmin(page);
    await page.waitForTimeout(2_000); // allow Firestore orders query to complete on admin page load

    // Filter by customer name so only Sentinel QA test orders are visible
    await page.locator('#filter-search').fill('SENTINEL CHECKOUT');
    await page.waitForTimeout(1_500);

    // Retry with a refresh up to 30 s — the CF may still be writing on slow runs
    let matchingRow: import('@playwright/test').Locator | null = null;
    const deadline = Date.now() + 30_000;

    while (!matchingRow && Date.now() < deadline) {
      const rows = await page.locator('#orders-body tr').all();
      for (const row of rows) {
        const rowText = await row.textContent().catch(() => '');
        if (rowText?.includes(checkoutEmail)) {
          matchingRow = row;
          break;
        }
      }
      if (!matchingRow) {
        await page.locator('#orders-refresh-btn').click();
        await page.waitForTimeout(2_000);
      }
    }

    if (!matchingRow) {
      console.error(
        `[FINDING][critical] checkout-order-appears-in-admin: order for ${checkoutEmail} not found ` +
          'in the admin Orders Dashboard within 30 s of checkout completion. A completed checkout ' +
          'that does not create a visible admin order means customer orders may be lost or unprocessed.',
      );
      return;
    }

    console.log(`[INFO] checkout-order-appears-in-admin: order for ${checkoutEmail} found in admin table ✓`);

    // Spot-check total in the table row before opening the detail view
    const rowText = await matchingRow.textContent() ?? '';
    if (!rowText.includes('1,360')) {
      console.warn(
        `[FINDING][medium] checkout-order-appears-in-admin: table row for ${checkoutEmail} does not ` +
          `show expected total "R1,360". Row content: "${rowText.replace(/\s+/g, ' ').trim().substring(0, 200)}"`,
      );
    } else {
      console.log('[INFO] checkout-order-appears-in-admin: table row shows expected total R1,360 ✓');
    }

    // Open the order detail modal
    await matchingRow.locator('button:has-text("View")').click();
    await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 });

    const modalText = await page.locator('#order-modal').textContent() ?? '';

    // Verify customer email
    if (!modalText.includes(checkoutEmail)) {
      console.error(
        `[FINDING][high] checkout-order-appears-in-admin: order modal does not contain the expected ` +
          `customer email "${checkoutEmail}" — the order may be associated with the wrong account.`,
      );
    } else {
      console.log('[INFO] checkout-order-appears-in-admin: customer email confirmed in order detail modal ✓');
    }

    // Verify pack name
    if (!modalText.includes(PACK_LABEL) && !modalText.toLowerCase().includes('juel')) {
      console.error(
        `[FINDING][high] checkout-order-appears-in-admin: pack name "${PACK_LABEL}" not found in ` +
          'order detail modal — the order may have been created with an incorrect pack reference.',
      );
    } else {
      console.log(`[INFO] checkout-order-appears-in-admin: pack name "${PACK_LABEL}" confirmed in order detail modal ✓`);
    }

    // Verify total in modal
    if (!modalText.includes('1,360')) {
      console.warn(
        '[FINDING][medium] checkout-order-appears-in-admin: expected total "R1,360" not found in ' +
          'order detail modal — the stored amount may differ from the charged amount.',
      );
    } else {
      console.log('[INFO] checkout-order-appears-in-admin: order total R1,360 confirmed in order detail modal ✓');
    }

    // Verify a status is shown
    const statusText = ((await page.locator('#order-modal .status-badge').textContent().catch(() => '')) ?? '').trim();
    if (!statusText) {
      console.warn('[FINDING][low] checkout-order-appears-in-admin: no status badge found in order detail modal.');
    } else {
      console.log(`[INFO] checkout-order-appears-in-admin: order status is "${statusText}" ✓`);
    }
  });

});
