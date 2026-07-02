import { test, expect } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';
import { getLatestOrderConfirmationEmail } from '../../src/utils/gmail';
import {
  PACK_LABEL, EXPECTED_SUBTOTAL, ADDR,
  registerForCheckout, addPackAndGoToCheckout, fillConfigStep, advanceThroughDeliveryToPayment,
} from './checkout-helpers';

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

  // ── 5. Confirmation email tracking link ───────────────────────────────────────

  test('checkout-confirmation-email-tracking-link — order confirmation email contains a working track link that shows the correct order', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description: `Completes a full sandbox checkout for '${PACK_LABEL}', then polls Gmail for the order confirmation email from no-reply@juelhaus.co.za. Extracts the "Track Your Order" link, verifies it deep-links directly to the order (via ?id= or ?waybill= query parameter), and confirms the tracking page shows the correct pack name and order status without any manual input. If the email links to a generic tracking page instead of deep-linking, that is flagged as a medium finding — the tracking page supports query-parameter deep links, so not using them creates unnecessary friction for customers.`,
    });

    const checkoutEmail = await registerForCheckout(page);
    await addPackAndGoToCheckout(page);
    await fillConfigStep(page);
    await advanceThroughDeliveryToPayment(page);
    await page.locator('#co-billing-addr').fill(ADDR.billing);

    // Capture the order ID from the CF response — needed as fallback for manual
    // tracking input if the email links to the generic /track.html without params.
    const cfResponsePromise = page.waitForResponse(
      res => res.url().includes('cloudfunctions.net') && res.request().method() === 'POST',
      { timeout: 30_000 },
    ).catch(() => null);

    // Mark time just before payment — Gmail polling uses this to exclude earlier
    // emails (e.g. the account verification sent during registerForCheckout).
    const sentAfter = new Date();

    const navigationPromise = page.waitForNavigation({ timeout: 30_000 }).catch(() => null);
    await page.locator('#pay-now-btn').click();

    const [cfResp] = await Promise.all([cfResponsePromise, navigationPromise]);

    // Extract order ID from the CF response body for the manual-entry fallback
    let orderId: string | null = null;
    if (cfResp) {
      const body = await cfResp.json().catch(() => ({})) as Record<string, unknown>;
      const result = body?.result as Record<string, unknown> | undefined;
      orderId = (result?.orderId ?? result?.id ?? body?.orderId ?? null) as string | null;
    }
    if (orderId) {
      console.log(`[INFO] checkout-confirmation-email-tracking-link: CF orderId=${orderId}`);
    }

    console.log(`[INFO] checkout-confirmation-email-tracking-link: polling Gmail for confirmation email sent to ${checkoutEmail}`);

    const trackingUrl = await getLatestOrderConfirmationEmail(sentAfter);

    if (!trackingUrl) {
      console.error(
        `[FINDING][high] checkout-confirmation-email-tracking-link: no order confirmation email ` +
          `with a "Track Your Order" link arrived in the sentinelqa2026@gmail.com inbox within 60 s ` +
          `of checkout completion for ${checkoutEmail}. Customers may not receive order confirmation emails.`,
      );
      return;
    }

    console.log(`[TRACK LINK] ${trackingUrl}`);

    // ── Determine whether the email deep-links to the order ────────────────────
    const parsedUrl  = new URL(trackingUrl);
    const idParam    = parsedUrl.searchParams.get('id');
    const waybillParam = parsedUrl.searchParams.get('waybill');
    const hasDeepLink = Boolean(idParam ?? waybillParam);

    // If the CF returned no orderId, try to infer it from the URL's ?id= param
    if (!orderId && idParam) orderId = idParam;

    if (!hasDeepLink) {
      // The email links to the bare tracking page without pre-filling the order.
      // The tracking page supports ?id= deep links, so this is an avoidable friction point.
      console.warn(
        '[FINDING][medium] checkout-confirmation-email-tracking-link: order confirmation email links ' +
          `to a generic tracking page ("${trackingUrl}") instead of deep-linking directly to the order, ` +
          'despite the tracking page supporting ?id= and ?waybill= query-parameter deep links elsewhere. ' +
          'This forces the customer to manually locate and enter their order number.',
      );
    } else {
      console.log(
        `[INFO] checkout-confirmation-email-tracking-link: confirmation email correctly deep-links ` +
          `to the order via ${idParam ? '?id=' : '?waybill='}${idParam ?? waybillParam} ✓`,
      );
    }

    // ── Navigate to the tracking URL ──────────────────────────────────────────
    await page.goto(trackingUrl, { waitUntil: 'domcontentloaded' });

    if (!hasDeepLink && orderId) {
      // Generic link — manually enter the order ID and submit
      await page.locator('#track-input').waitFor({ state: 'visible', timeout: 5_000 });
      await page.locator('#track-input').fill(orderId);
      await page.locator('button.btn-track').click();
    }

    // Wait for the result card to render (Firestore fetch is async)
    const resultVisible = await page.locator('#track-result .result-card')
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!resultVisible) {
      const resultText = ((await page.locator('#track-result').textContent().catch(() => '')) ?? '').trim();
      if (resultText.toLowerCase().includes('no order found')) {
        console.error(
          `[FINDING][high] checkout-confirmation-email-tracking-link: tracking page reported ` +
            `"No order found" for the ID from the confirmation email link. ` +
            `orderId=${orderId ?? 'unknown'} trackingUrl=${trackingUrl}`,
        );
      } else {
        console.error(
          `[FINDING][high] checkout-confirmation-email-tracking-link: tracking page result card ` +
            `did not appear within 10 s. trackingUrl=${trackingUrl}`,
        );
      }
      return;
    }

    // ── Verify the result card content ─────────────────────────────────────────
    const packTitle = ((await page.locator('#track-result .result-title').textContent().catch(() => '')) ?? '').trim();
    if (!packTitle.includes(PACK_LABEL) && !packTitle.toLowerCase().includes('juel')) {
      console.error(
        `[FINDING][high] checkout-confirmation-email-tracking-link: tracking page shows pack ` +
          `"${packTitle}" instead of expected "${PACK_LABEL}".`,
      );
    } else {
      console.log(`[INFO] checkout-confirmation-email-tracking-link: tracking page shows correct pack "${packTitle}" ✓`);
    }

    const trackStatus = ((await page.locator('#track-result .status-badge').textContent().catch(() => '')) ?? '').trim();
    if (!trackStatus) {
      console.warn(
        '[FINDING][low] checkout-confirmation-email-tracking-link: tracking page shows no status badge.',
      );
    } else {
      console.log(`[INFO] checkout-confirmation-email-tracking-link: tracking page status is "${trackStatus}" ✓`);
    }
  });

});
