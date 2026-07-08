import { test } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';
import { getLatestOrderConfirmationEmail } from '../../src/utils/gmail';
import { PACK_LABEL, runCheckoutFlow } from './checkout-helpers';
import {
  openOrderModal, closeOrderModal, getModalStatus,
  clickAdvanceStatus, verifyStatusPersisted, findAndOpenOrderInAdmin, STATUS_STAGES,
} from './order-lifecycle-helpers';

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Order lifecycle (LIVE_MODE only)', { tag: ['@functional'] }, () => {

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires real backend — set SENTINEL_LIVE_MODE=true to run');
  });

  // ── 1. Pending → Assembling triggers confirmation email ─────────────────────

  test('order-advance-to-assembling-triggers-email — advancing an order to Assembling sends the customer a confirmation email', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        "Creates a fresh order via the sandbox checkout, logs in as admin, and advances the order " +
        "from 'Pending' to 'Assembling' using the admin Orders Dashboard. Verifies the status persists " +
        "after closing and reopening the order modal (confirming the Firestore write completed). " +
        "Then polls Gmail for the 'basket is being prepared' confirmation email that should be triggered " +
        "by the Assembling transition. A missing email after a confirmed status change is a high-severity " +
        "finding — customers would receive no communication after placing an order.",
    });

    const { checkoutEmail, orderId: cfOrderId } = await runCheckoutFlow(page);
    console.log(`[INFO] order-advance-to-assembling-triggers-email: checkout complete for ${checkoutEmail}`);

    await loginAsAdmin(page);

    const orderId = await findAndOpenOrderInAdmin(page, checkoutEmail, cfOrderId);
    if (!orderId) {
      console.error(
        `[FINDING][critical] order-advance-to-assembling-triggers-email: order for ${checkoutEmail} ` +
          'not found in admin within 30 s of checkout.',
      );
      return;
    }

    const initialStatus = await getModalStatus(page);
    console.log(`[INFO] order-advance-to-assembling-triggers-email: initial status="${initialStatus}"`);

    if (initialStatus !== 'Pending') {
      console.warn(
        `[FINDING][low] order-advance-to-assembling-triggers-email: expected initial status "Pending" ` +
          `but got "${initialStatus}" — test will still attempt to advance.`,
      );
    }

    // ── Advance to Assembling ─────────────────────────────────────────────────
    const sentAfter = new Date(); // mark before the status change fires
    await clickAdvanceStatus(page, 'btn-assemble');
    await verifyStatusPersisted(page, orderId, 'Assembling', 'order-advance-to-assembling-triggers-email');

    // ── Poll for confirmation email ───────────────────────────────────────────
    console.log('[INFO] order-advance-to-assembling-triggers-email: polling Gmail for confirmation email...');
    const trackingUrl = await getLatestOrderConfirmationEmail(sentAfter);

    if (!trackingUrl) {
      console.error(
        '[FINDING][high] order-advance-to-assembling-triggers-email: no "Track Your Order" email ' +
          `arrived in the sentinelqa2026@gmail.com inbox within 60 s of the order being set to ` +
          `Assembling. Customer ${checkoutEmail} received no confirmation after their order was accepted.`,
      );
    } else {
      console.log(`[INFO] order-advance-to-assembling-triggers-email: confirmation email received ✓`);
      console.log(`[TRACK LINK] ${trackingUrl}`);
    }
  });

  // ── 2. Full status lifecycle ────────────────────────────────────────────────

  test('order-advance-through-all-stages — each status transition persists correctly in Firestore', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        "Creates a fresh order via the sandbox checkout, logs in as admin, and advances the order " +
        "through every fulfilment stage in sequence: Pending → Assembling → Ready for Collection → " +
        "In Transit → Delivered → Completed. After each transition the order modal is closed and " +
        "reopened to fetch fresh data from Firestore, confirming the status was saved. Any stage " +
        "that fails to persist is logged as a high-severity finding — a status that does not save " +
        "means admins may lose track of where an order is in the fulfilment process.",
    });

    const { checkoutEmail, orderId: cfOrderId } = await runCheckoutFlow(page);
    console.log(`[INFO] order-advance-through-all-stages: checkout complete for ${checkoutEmail}`);

    await loginAsAdmin(page);

    const orderId = await findAndOpenOrderInAdmin(page, checkoutEmail, cfOrderId);
    if (!orderId) {
      console.error(
        `[FINDING][critical] order-advance-through-all-stages: order for ${checkoutEmail} ` +
          'not found in admin within 30 s of checkout.',
      );
      return;
    }

    console.log(`[INFO] order-advance-through-all-stages: orderId=${orderId}, starting lifecycle walk`);

    for (const { btnClass, label } of STATUS_STAGES) {
      const actionVisible = await page.locator(`#order-modal button.${btnClass}`)
        .isVisible({ timeout: 3_000 }).catch(() => false);

      if (!actionVisible) {
        console.warn(
          `[FINDING][medium] order-advance-through-all-stages: action button ".${btnClass}" ` +
            `(→ ${label}) not visible — stage may already be passed or button not rendered.`,
        );
        continue;
      }

      await clickAdvanceStatus(page, btnClass);
      await verifyStatusPersisted(page, orderId, label, 'order-advance-through-all-stages');
    }

    console.log('[INFO] order-advance-through-all-stages: lifecycle walk complete');
  });

  // ── 3. Waybill entry persists ───────────────────────────────────────────────

  test('order-waybill-entry-persists — waybill number entered in the admin modal is saved and survives a page reload', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        "Creates a fresh order via the sandbox checkout, logs in as admin, opens the order detail " +
        "modal, and enters a test waybill number in the Waybill # field before clicking Save. " +
        "The modal is then closed and reopened to confirm the waybill number was persisted to " +
        "Firestore. If the value is gone after a reload, that is a medium-severity finding — " +
        "a lost waybill means the admin has no way to link the order to the courier's tracking system.",
    });

    const TEST_WAYBILL = 'SENTINEL-TEST-WB-001';

    const { checkoutEmail, orderId: cfOrderId } = await runCheckoutFlow(page);
    console.log(`[INFO] order-waybill-entry-persists: checkout complete for ${checkoutEmail}`);

    await loginAsAdmin(page);

    const orderId = await findAndOpenOrderInAdmin(page, checkoutEmail, cfOrderId);
    if (!orderId) {
      console.error(
        `[FINDING][critical] order-waybill-entry-persists: order for ${checkoutEmail} ` +
          'not found in admin within 30 s of checkout.',
      );
      return;
    }

    // ── Enter and save waybill ────────────────────────────────────────────────
    const waybillInput = page.locator(`#waybill-input-${orderId}`);
    await waybillInput.waitFor({ state: 'visible', timeout: 5_000 });
    await waybillInput.fill(TEST_WAYBILL);

    // Save button: onclick="saveWaybill(orderId)"
    const saveBtn = page.locator(`#order-modal button[onclick*="saveWaybill"]`);
    await saveBtn.click();
    await page.waitForTimeout(2_000); // allow Firestore write

    // ── Verify persistence by reopening the modal ─────────────────────────────
    await closeOrderModal(page);
    await openOrderModal(page, orderId);

    const persistedValue = await page.locator(`#waybill-input-${orderId}`).inputValue().catch(() => '');
    if (persistedValue === TEST_WAYBILL) {
      console.log(`[INFO] order-waybill-entry-persists: waybill "${TEST_WAYBILL}" persisted ✓`);
    } else {
      console.error(
        `[FINDING][medium] order-waybill-entry-persists: waybill "${TEST_WAYBILL}" was saved but ` +
          `the modal shows "${persistedValue}" after close+reopen — the waybill may not have been ` +
          'written to Firestore, leaving no record linking this order to its courier tracking number.',
      );
    }
  });

});
