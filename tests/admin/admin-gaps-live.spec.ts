import { test, expect, type Page } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';
import { runCheckoutFlow } from '../functional/checkout-helpers';
import {
  openOrderModal, closeOrderModal, getModalStatus,
  clickAdvanceStatus, verifyStatusPersisted, findAndOpenOrderInAdmin,
} from '../functional/order-lifecycle-helpers';

// Covers three admin-dashboard areas discovered live and never previously mapped
// by this suite: the Audit Log tab (#atab-btn-audit / #audit-log-body), the
// Support Tickets tab (#atab-btn-tickets / #tickets-body), and the "Force ...
// (Override)" status controls inside the order detail modal.
//
// Discovery findings (captured via a throwaway discovery run, not checked in):
// - Audit Log rows: <tr><td>TIME</td><td><span>ACTION</span></td><td>TARGET</td><td>PERFORMED BY</td></tr>
//   inside #audit-log-body. TIME format observed: "2026/06/24, 14:18:22".
// - Support Tickets: #ticket-search input, #ticket-status-filter select
//   (Open/All/Resolved), #tickets-body tbody, 7 columns (Ticket ID, Host, Issue,
//   Urgent, Created, Status, + one unlabeled action column per colspan="7" on the
//   empty-state row). Currently empty in the live environment ("No support
//   tickets found.").
// - Force/Override control: the button labelled "Force Mark as In Transit
//   (Override)" (class btn-action btn-transit, onclick="showOverrideConfirm(id)")
//   is the SAME control STATUS_STAGES already advances via clickAdvanceStatus —
//   there is no separate/hidden override mechanism (no status-jump dropdown, no
//   admin-only bypass button). What makes it distinct from the earlier
//   Pending→Assembling and Assembling→Ready-for-Collection buttons (which apply
//   instantly, no confirmation) is that stages 3-5 are explicitly UI-labelled
//   "Force ... (Override)" and reveal a "Go Back" / "Yes, Force Update" pair
//   (showOverrideConfirm/hideOverrideConfirm) before updateStatus() actually runs.
//   That confirmation step is what this file verifies directly, independent of
//   whatever tests/functional/order-lifecycle.spec.ts already covers elsewhere.

async function readAuditLogRows(page: Page): Promise<Array<{ time: string; action: string; target: string; performedBy: string }>> {
  await page.locator('#atab-btn-audit').click();
  await page.locator('#audit-log-body').waitFor({ state: 'visible', timeout: 6_000 });
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#audit-log-body tr')).map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim());
      return { time: cells[0] ?? '', action: cells[1] ?? '', target: cells[2] ?? '', performedBy: cells[3] ?? '' };
    }),
  );
}

test.describe('Admin dashboard gaps (LIVE_MODE only)', { tag: ['@admin'] }, () => {

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires real backend — set SENTINEL_LIVE_MODE=true to run');
  });

  // ── 1. Audit Log records admin actions ───────────────────────────────────────

  test('audit-log-records-admin-actions — advancing an order status produces a new Audit Log entry with a timestamp and the acting admin\'s identity', async ({ page }) => {
    // Full checkout + admin login + one status advance + a polled Audit Log check
    // realistically runs 90-130s live (checkout alone is the bulk of that, same
    // cost already paid by tests/functional/order-lifecycle.spec.ts's first test,
    // whose exact pattern this reuses) — 150s cap leaves headroom, not new budget.
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: 'description',
      description:
        "Created a fresh order via the sandbox checkout, logged in as admin, and advanced the order " +
        "from 'Pending' to 'Assembling' — the same proven action tests/functional/order-lifecycle.spec.ts " +
        "already uses. Then opened the Audit Log tab and checked for a new entry recording that action, " +
        "with a timestamp and the acting admin's email in the 'Performed By' column. An audit log that " +
        "doesn't actually record admin actions provides no real accountability trail — an admin could " +
        "advance, cancel, or override an order with no record of who did it or when.",
    });

    const { checkoutEmail, orderId: cfOrderId } = await runCheckoutFlow(page);
    console.log(`[INFO] audit-log-records-admin-actions: checkout complete for ${checkoutEmail}`);

    await loginAsAdmin(page);

    const orderId = await findAndOpenOrderInAdmin(page, checkoutEmail, cfOrderId);
    if (!orderId) {
      console.error(
        `[FINDING][critical] audit-log-records-admin-actions: order for ${checkoutEmail} ` +
          'not found in admin within 30 s of checkout — cannot perform the admin action to audit.',
      );
      return;
    }

    // findAndOpenOrderInAdmin leaves #order-modal open (active) after locating the order —
    // close it before touching any tab button, or the modal overlay intercepts the click.
    await closeOrderModal(page);

    // Baseline: capture the Audit Log's current rows before performing the action,
    // so we can detect a genuinely new entry rather than assume timestamp format/timezone.
    const baselineRows = await readAuditLogRows(page);
    const baselineSignature = new Set(baselineRows.map((r) => `${r.time}|${r.action}|${r.target}|${r.performedBy}`));
    console.log(`[INFO] audit-log-records-admin-actions: baseline has ${baselineRows.length} row(s)`);

    // ── Perform the known admin action ───────────────────────────────────────
    await openOrderModal(page, orderId);
    await clickAdvanceStatus(page, 'btn-assemble');
    await verifyStatusPersisted(page, orderId, 'Assembling', 'audit-log-records-admin-actions');
    await closeOrderModal(page); // modal stays open/active after verifyStatusPersisted and would intercept the tab click below

    // ── Poll the Audit Log for a new entry ───────────────────────────────────
    const adminEmail = process.env.ADMIN_EMAIL ?? '';
    let newRow: { time: string; action: string; target: string; performedBy: string } | undefined;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !newRow) {
      const rows = await readAuditLogRows(page);
      newRow = rows.find((r) => !baselineSignature.has(`${r.time}|${r.action}|${r.target}|${r.performedBy}`));
      if (!newRow) await page.waitForTimeout(2_000);
    }

    if (!newRow) {
      console.error(
        '[FINDING][medium] audit-log-records-admin-actions: no new row appeared in #audit-log-body ' +
          'within 20 s of advancing an order from Pending to Assembling — an audit log that doesn\'t ' +
          'actually log actions provides no real accountability trail.',
      );
    } else {
      console.log(`[INFO] audit-log-records-admin-actions: new entry found — time="${newRow.time}", action="${newRow.action}", target="${newRow.target}", performedBy="${newRow.performedBy}"`);

      if (!newRow.time.trim()) {
        console.error('[FINDING][medium] audit-log-records-admin-actions: new entry has no timestamp.');
      }
      if (!adminEmail || newRow.performedBy !== adminEmail) {
        console.error(
          `[FINDING][medium] audit-log-records-admin-actions: new entry's "Performed By" is ` +
            `"${newRow.performedBy}", expected the acting admin's email ("${adminEmail}") — the log may ` +
            'not be recording WHO performed the action, only THAT something happened.',
        );
      } else {
        console.log('[INFO] audit-log-records-admin-actions: entry correctly attributes the acting admin ✓');
      }
    }

    expect(newRow, 'A new Audit Log entry must appear after a known admin action (order status advance)').toBeTruthy();
  });

  // ── 2. Support Tickets tab loads ─────────────────────────────────────────────

  test('support-tickets-tab-loads — the Support Tickets tab loads without error and its structure is documented', async ({ page }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: 'description',
      description:
        "Logged in as admin and opened the Support Tickets tab. Verified the tab switches without a " +
        "JavaScript exception and the tickets list container becomes visible. If tickets exist, checked " +
        "for basic structure (a list with status per ticket, and the ability to open one for detail). If " +
        "the list is empty, documented the empty-state message shown to the admin instead of failing.",
    });

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await loginAsAdmin(page);

    await page.locator('#atab-btn-tickets').click();
    const bodyVisible = await page.locator('#tickets-body').waitFor({ state: 'visible', timeout: 6_000 }).then(() => true).catch(() => false);

    if (!bodyVisible) {
      console.error('[FINDING][high] support-tickets-tab-loads: #tickets-body did not become visible after clicking the Support Tickets tab.');
      expect(bodyVisible, '#tickets-body must be visible after opening the Support Tickets tab').toBe(true);
      return;
    }
    console.log('[INFO] support-tickets-tab-loads: #tickets-body visible ✓');

    await page.waitForTimeout(1_500); // allow Firestore subscription to populate before reading rows

    const rows = await page.locator('#tickets-body tr').all();
    const bodyText = ((await page.locator('#tickets-body').textContent().catch(() => '')) ?? '').trim();
    const isEmptyState = /no support tickets found/i.test(bodyText);

    if (isEmptyState || rows.length === 0) {
      console.log(`[INFO] support-tickets-tab-loads: empty state documented — "${bodyText}"`);
    } else {
      console.log(`[INFO] support-tickets-tab-loads: ${rows.length} ticket row(s) present — checking basic structure.`);

      const firstRowText = ((await rows[0].textContent().catch(() => '')) ?? '').trim();
      console.log(`[INFO] support-tickets-tab-loads: first row text: "${firstRowText.slice(0, 200)}"`);

      // Status column: from discovery, header order is Ticket ID / Host / Issue / Urgent / Created / Status.
      const statusFilterOptions = await page.locator('#ticket-status-filter option').allTextContents().catch(() => []);
      console.log(`[INFO] support-tickets-tab-loads: status filter options: ${JSON.stringify(statusFilterOptions)}`);

      // Try to open the first ticket for detail — look for any clickable control in the row.
      const openControl = rows[0].locator('button, a').first();
      const hasOpenControl = await openControl.isVisible({ timeout: 2_000 }).catch(() => false);
      if (!hasOpenControl) {
        console.error(
          '[FINDING][medium] support-tickets-tab-loads: a ticket row exists but no button/link was found ' +
            'to open it for detail — admins may not be able to view or respond to a submitted ticket.',
        );
      } else {
        await openControl.click().catch(() => {});
        await page.waitForTimeout(1_000);
        console.log('[INFO] support-tickets-tab-loads: clicked the first ticket\'s open control — no crash.');
      }
    }

    if (pageErrors.length > 0) {
      console.error(
        `[FINDING][high] support-tickets-tab-loads: ${pageErrors.length} unhandled JS exception(s) while ` +
          'loading the Support Tickets tab: ' + pageErrors.join(' | '),
      );
    }
    expect(pageErrors, 'Opening the Support Tickets tab must not throw unhandled JS exceptions').toHaveLength(0);
  });

  // ── 3. Force/Override status requires confirmation ──────────────────────────

  test('force-override-status-requires-confirmation — the "Force ... (Override)" status control cannot apply without an explicit confirmation step', async ({ page }) => {
    // Full checkout + two cheap non-override status advances (Pending→Assembling→
    // Ready for Collection) to reach the override-labelled stage, then the
    // confirmation-flow check itself. Realistically 100-140s live — flagged here
    // per CLAUDE.md, same order of cost as order-lifecycle.spec.ts's full-stage walk.
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: 'description',
      description:
        "Created a fresh order via the sandbox checkout and advanced it (via the already-proven admin " +
        "pattern) to 'Ready for Collection', the stage whose next action is explicitly UI-labelled " +
        "'Force Mark as In Transit (Override)'. Clicked that control and verified the order's status did " +
        "NOT change immediately — instead a 'Go Back' / 'Yes, Force Update' confirmation step must appear " +
        "first. Verified 'Go Back' cancels without applying the change, then confirmed via 'Yes, Force " +
        "Update' and verified the status only changes at that point. Same principle as the pack-delete " +
        "confirmation flow already proven in pack-crud-live.spec.ts. If the override control applies " +
        "instantly with no confirmation step, that is a higher-severity finding than the pack-deletion " +
        "gap already flagged — it is a bypass mechanism for the normal status workflow with no safeguard.",
    });

    const { checkoutEmail, orderId: cfOrderId } = await runCheckoutFlow(page);
    console.log(`[INFO] force-override-status-requires-confirmation: checkout complete for ${checkoutEmail}`);

    await loginAsAdmin(page);

    const orderId = await findAndOpenOrderInAdmin(page, checkoutEmail, cfOrderId);
    if (!orderId) {
      console.error(
        `[FINDING][critical] force-override-status-requires-confirmation: order for ${checkoutEmail} ` +
          'not found in admin within 30 s of checkout.',
      );
      return;
    }

    // ── Reach 'Ready for Collection' via the two non-override stages ─────────
    await clickAdvanceStatus(page, 'btn-assemble');
    await verifyStatusPersisted(page, orderId, 'Assembling', 'force-override-status-requires-confirmation');
    await clickAdvanceStatus(page, 'btn-ready');
    await verifyStatusPersisted(page, orderId, 'Ready for Collection', 'force-override-status-requires-confirmation');

    // ── Click the override control WITHOUT confirming ─────────────────────────
    const overrideBtn = page.locator('#order-modal button.btn-transit');
    await overrideBtn.waitFor({ state: 'visible', timeout: 5_000 });
    const overrideBtnText = ((await overrideBtn.textContent().catch(() => '')) ?? '').trim();
    console.log(`[INFO] force-override-status-requires-confirmation: override button text = "${overrideBtnText}"`);

    await overrideBtn.click();
    await page.waitForTimeout(500);

    const statusRightAfterClick = await getModalStatus(page);
    const appliedInstantly = statusRightAfterClick !== 'Ready for Collection';
    if (appliedInstantly) {
      console.error(
        `[FINDING][high] force-override-status-requires-confirmation: clicking "${overrideBtnText}" changed ` +
          `the status to "${statusRightAfterClick}" immediately, with no confirmation step — a bypass ` +
          'mechanism for the normal status workflow with no safeguard.',
      );
    }

    // ── Confirmation controls must be visible before the change is committed ──
    // "Go Back" text is shared with the unrelated Cancel Order confirmation's own Go Back
    // button (hideCancelConfirm) — scope by onclick to avoid a strict-mode multi-match.
    const goBackBtn = page.locator('#order-modal button[onclick*="hideOverrideConfirm"]');
    const confirmBtn = page.locator('#order-modal button:has-text("Yes, Force Update")');
    const confirmStepVisible = await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false);

    if (!appliedInstantly && !confirmStepVisible) {
      console.error(
        `[FINDING][high] force-override-status-requires-confirmation: clicking "${overrideBtnText}" neither ` +
          'applied the change nor showed a confirmation step — the control may be broken rather than safe.',
      );
    } else if (confirmStepVisible) {
      console.log('[INFO] force-override-status-requires-confirmation: confirmation step ("Yes, Force Update") appeared, change not yet applied ✓');
    }

    // ── "Go Back" must cancel without applying the change ─────────────────────
    if (await goBackBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await goBackBtn.click();
      await page.waitForTimeout(500);
      const statusAfterGoBack = await getModalStatus(page);
      if (statusAfterGoBack !== 'Ready for Collection') {
        console.error(
          `[FINDING][high] force-override-status-requires-confirmation: status is "${statusAfterGoBack}" ` +
            'after clicking "Go Back" — cancelling the confirmation must not apply the change.',
        );
      } else {
        console.log('[INFO] force-override-status-requires-confirmation: "Go Back" correctly cancelled without applying the change ✓');
      }

      // Re-open the confirmation to proceed with the actual confirm step below.
      await overrideBtn.click();
      await page.waitForTimeout(500);
    }

    // ── Confirming applies the change and it persists ──────────────────────────
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmBtn.click();
      await verifyStatusPersisted(page, orderId, 'In Transit', 'force-override-status-requires-confirmation');
    }

    expect(appliedInstantly, `"${overrideBtnText}" must not apply the status change before an explicit confirmation`).toBe(false);
    expect(confirmStepVisible, `"${overrideBtnText}" must show a confirmation step ("Yes, Force Update") before applying`).toBe(true);
  });

});
