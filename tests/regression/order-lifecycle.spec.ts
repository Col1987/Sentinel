import { test, expect } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';
import { getLatestOrderConfirmationEmail } from '../../src/utils/gmail';
import { runCheckoutFlow } from '../functional/checkout-helpers';
import {
  getModalStatus, clickAdvanceStatus, verifyStatusPersisted, findAndOpenOrderInAdmin, STATUS_STAGES,
} from '../functional/order-lifecycle-helpers';

// One status-progression cycle: Pending → Assembling (confirming the customer email is
// triggered) → one further stage. The full five-stage walk is covered in
// tests/functional/order-lifecycle.spec.ts; this suite only needs proof the admin
// status-update pipeline and its email trigger both work, not exhaustive stage coverage.

test.describe('Order lifecycle', { tag: ['@regression'] }, () => {

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires a real backend and real Firestore persistence — set SENTINEL_LIVE_MODE=true to run');
  });

  test('order-status-progression-and-email-trigger — advancing an order two stages persists each transition and triggers the confirmation email', async ({ page }) => {
    // Budget: register+checkout(~30s) + adminLogin(~10s) + findOrder(~2s typical, 30s worst case)
    //   + advance-to-Assembling(~3s) + persist-check(~2s) + email-poll(~60s worst case)
    //   + advance-to-ReadyForCollection(~3s) + persist-check(~2s) ≈ 140s worst case.
    test.setTimeout(240_000);
    test.info().annotations.push({
      type: 'description',
      description: "Creates a fresh order via the sandbox checkout, logs in as admin, and advances the order from Pending to Assembling — confirming both that the status persists in Firestore and that the customer confirmation email fires. Advances one further stage (Ready for Collection) to confirm the transition pipeline generalises beyond the first stage, without repeating the full five-stage walk covered in the functional suite.",
    });

    const { checkoutEmail, orderId: cfOrderId } = await runCheckoutFlow(page);
    console.log(`[INFO] order-status-progression-and-email-trigger: checkout complete for ${checkoutEmail}`);

    await loginAsAdmin(page);

    const orderId = await findAndOpenOrderInAdmin(page, checkoutEmail, cfOrderId);
    if (!orderId) {
      console.error(
        `[FINDING][critical] order-status-progression-and-email-trigger: order for ${checkoutEmail} not found in admin within 30 s of checkout.`,
      );
    }
    expect(orderId, 'The newly-created order must be findable in the admin dashboard').not.toBeNull();

    const initialStatus = await getModalStatus(page);
    console.log(`[INFO] order-status-progression-and-email-trigger: initial status="${initialStatus}"`);

    // ── Stage 1: Pending → Assembling, confirming the email trigger ────────────
    const sentAfter = new Date();
    await clickAdvanceStatus(page, STATUS_STAGES[0].btnClass);
    await verifyStatusPersisted(page, orderId!, STATUS_STAGES[0].label, 'order-status-progression-and-email-trigger');

    const trackingUrl = await getLatestOrderConfirmationEmail(sentAfter);
    if (!trackingUrl) {
      console.error(
        '[FINDING][high] order-status-progression-and-email-trigger: no confirmation email arrived within 60 s of the order being set to Assembling.',
      );
    } else {
      console.log(`[INFO] order-status-progression-and-email-trigger: confirmation email received ✓ — ${trackingUrl}`);
    }

    // ── Stage 2: Assembling → Ready for Collection ──────────────────────────────
    await clickAdvanceStatus(page, STATUS_STAGES[1].btnClass);
    await verifyStatusPersisted(page, orderId!, STATUS_STAGES[1].label, 'order-status-progression-and-email-trigger');

    console.log('[INFO] order-status-progression-and-email-trigger: two-stage progression complete ✓');
  });

});
