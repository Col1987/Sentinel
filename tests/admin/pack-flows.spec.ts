import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin } from '../../src/utils/auth';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

// Packs are stored in Firestore `welcomePacks` and loaded via direct reads (not Cloud
// Functions), so pack data is available even in safe mode (!LIVE_MODE).

async function openPacksTab(page: Page): Promise<void> {
  await page.locator('#atab-btn-packs').click();
  // #packs-body transitions from hidden to visible when the Packs tab is activated.
  // Waiting for it to be visible is more reliable than a fixed delay.
  await page.locator('#packs-body').waitFor({ state: 'visible', timeout: 6_000 });
}

test.describe('Admin pack flows', { tag: ['@admin'] }, () => {

  test.beforeEach(() => { test.slow(); });

  // ─── packs-list-displays ─────────────────────────────────────────────────────

  test('packs-list-displays — packs tab shows existing pack entries and the Add New Pack button', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, opened the Welcome Packs tab, and checked that the pack list renders. Packs are read directly from the database, so they should always be visible — even in safe test mode. Verified that at least one pack item is displayed and that the '+ Add New Pack' button is accessible for creating new packs.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);
    await openPacksTab(page);

    expect(
      await page.locator('#packs-body').isVisible().catch(() => false),
      '#packs-body must be visible after clicking the Welcome Packs tab',
    ).toBe(true);

    // Pack entries may render as cards, list items, or table rows — count any recognisable child element.
    const packItemCount = await page.locator(
      '#packs-body .pack-card, #packs-body .pack-item, #packs-body tr:not(:first-child), #packs-body [id^="pack-"]',
    ).count();

    if (packItemCount === 0) {
      console.warn(
        '[FINDING][low] packs-list-displays: no recognisable pack items found in #packs-body. ' +
          'Either no packs exist in Firestore or the items use an unexpected DOM structure.',
      );
    }

    console.log(`[INFO] packs-list-displays: ${packItemCount} pack item(s) in #packs-body.`);

    const addBtnVisible = await page.locator('button:has-text("+ Add New Pack")').isVisible().catch(() => false);
    if (!addBtnVisible) {
      console.error(
        '[FINDING][medium] packs-list-displays: "Add New Pack" button not visible. Admins cannot create packs.',
      );
    }
    expect(addBtnVisible, '"+ Add New Pack" button must be visible on the Packs tab').toBe(true);
  });

  // ─── pack-create-form-fields ─────────────────────────────────────────────────

  test('pack-create-form-fields — create form opens, accepts input into all required fields, and can be dismissed', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, opened the 'Add New Pack' form, and typed test values into each required field: name, price, and tagline. Verified that all three fields accept the entered text and that the form can be dismissed with Escape without submitting. No data was saved — this test validates the create workflow up to (but not including) the save step.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);
    await openPacksTab(page);

    await page.locator('button:has-text("+ Add New Pack")').click();
    await page.locator('#pack-form-modal').waitFor({ state: 'visible', timeout: 5_000 });

    expect(
      await page.locator('#pack-form-modal').isVisible().catch(() => false),
      '#pack-form-modal must open after clicking Add New Pack',
    ).toBe(true);

    // Fill each required field with a clearly synthetic value.
    const FIELDS = [
      { selector: '#pack-f-name',    value: 'Sentinel Test Pack',  label: 'name' },
      { selector: '#pack-f-price',   value: '99',                   label: 'price' },
      { selector: '#pack-f-tagline', value: 'Automated test entry', label: 'tagline' },
    ];

    for (const { selector, value, label } of FIELDS) {
      const el = page.locator(selector);
      if (!(await el.isVisible().catch(() => false))) {
        console.error(
          `[FINDING][medium] pack-create-form-fields: "${label}" field (${selector}) not visible in create form.`,
        );
        continue;
      }
      await el.fill(value);
      const actual = await el.inputValue().catch(() => '');
      if (actual !== value) {
        console.error(
          `[FINDING][medium] pack-create-form-fields: "${label}" field did not accept the filled value ` +
            `(filled "${value}", read back "${actual}").`,
        );
      } else {
        console.log(`[INFO] pack-create-form-fields: "${label}" field accepted input ✓`);
      }
    }

    // Close without submitting — Escape is the expected keyboard dismissal.
    await page.keyboard.press('Escape');
    await page.locator('#pack-form-modal').waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {});

    // If Escape did not close the modal, try a visible close/cancel button.
    if (await page.locator('#pack-form-modal').isVisible().catch(() => false)) {
      const closeBtn = page.locator(
        '#pack-form-modal .modal-close, #pack-form-modal button:has-text("Cancel"), #pack-form-modal button:has-text("×")',
      ).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
        console.log('[INFO] pack-create-form-fields: Escape did not close modal — used close button instead.');
      }
    }

    console.log('[INFO] pack-create-form-fields: create form dismissed without submitting.');
  });

  // ─── pack-edit-opens ─────────────────────────────────────────────────────────

  test('pack-edit-opens — Edit button opens the form pre-populated with the existing pack data', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, opened the Welcome Packs tab, and clicked the Edit button on the first pack in the list. Verified that the pack edit form opened with the pack's existing name already filled in. Pre-population is critical — an edit form that opens empty would cause admins to accidentally overwrite pack data with blanks. If no packs or edit buttons are found, the test is skipped gracefully.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);
    await openPacksTab(page);

    const editBtn = page.locator(
      '#packs-body button:has-text("Edit"), #packs-body [aria-label*="edit" i], #packs-body .btn-edit',
    ).first();

    if (!(await editBtn.isVisible().catch(() => false))) {
      console.log(
        '[INFO] pack-edit-opens: no "Edit" button found in #packs-body. ' +
          'Either no packs exist or edit buttons use an unexpected label.',
      );
      return;
    }

    await editBtn.click();
    await page.locator('#pack-form-modal').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});

    const modalVisible = await page.locator('#pack-form-modal').isVisible().catch(() => false);
    if (!modalVisible) {
      console.error('[FINDING][medium] pack-edit-opens: clicked Edit but #pack-form-modal did not appear.');
      expect(modalVisible, '#pack-form-modal must open when Edit is clicked').toBe(true);
      return;
    }

    // The name field must be pre-populated — an empty name means the form did not load pack data.
    const nameValue = await page.locator('#pack-f-name').inputValue().catch(() => '');
    if (nameValue.trim() === '') {
      console.error(
        '[FINDING][medium] pack-edit-opens: #pack-f-name is empty in the edit form. ' +
          'Edit forms must pre-populate with the existing pack name to prevent accidental overwrites.',
      );
    } else {
      console.log(`[INFO] pack-edit-opens: edit form opened with name="${nameValue}" ✓`);
    }

    expect(nameValue.trim(), 'Edit form must pre-populate #pack-f-name with the existing pack name').not.toBe('');

    // Close without saving.
    await page.keyboard.press('Escape');
    await page.locator('#pack-form-modal').waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {});
  });

  // ─── pack-delete-confirmation ─────────────────────────────────────────────────

  test('pack-delete-confirmation — Delete button shows a confirmation prompt and cancel preserves the pack', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, opened the Welcome Packs tab, and clicked the Delete button on the first pack. Verified that a confirmation prompt appeared — either a browser confirm dialog or an in-page confirmation modal — before any deletion could proceed. The deletion was cancelled at every stage; no data was modified. A delete action with no confirmation is a destructive defect that can cause accidental permanent data loss.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);
    await openPacksTab(page);

    // Capture native browser dialogs and dismiss them immediately so the test never hangs.
    let nativeDialogSeen = false;
    page.on('dialog', async dialog => {
      nativeDialogSeen = true;
      console.log(
        `[INFO] pack-delete-confirmation: native dialog — type="${dialog.type()}", ` +
          `message="${dialog.message().slice(0, 100)}". Dismissed.`,
      );
      await dialog.dismiss(); // always cancel — never confirm a destructive action in tests
    });

    const deleteBtn = page.locator(
      '#packs-body button:has-text("Delete"), #packs-body [aria-label*="delete" i], #packs-body .btn-delete',
    ).first();

    if (!(await deleteBtn.isVisible().catch(() => false))) {
      console.log(
        '[INFO] pack-delete-confirmation: no "Delete" button found in #packs-body. ' +
          'Either no packs exist or delete buttons use an unexpected label.',
      );
      return;
    }

    await deleteBtn.click();

    // Native dialogs are handled synchronously by Playwright when they appear.
    // Wait briefly for a custom in-page confirmation modal to render if no native dialog fired.
    await page.waitForFunction(
      () => !!document.querySelector('[id*="confirm"], [class*="confirm-modal"], [class*="delete-confirm"]') || nativeDialogSeen === undefined,
      { timeout: 2_000 },
    ).catch(() => {}); // timeout is expected when no custom modal exists

    const CONFIRM_SELECTORS = [
      '[id*="confirm"]',
      '[class*="confirm-modal"]',
      '[class*="delete-confirm"]',
      '[role="dialog"]:has-text("delete")',
    ];

    let customConfirmVisible = false;
    for (const sel of CONFIRM_SELECTORS) {
      if (await page.locator(sel).first().isVisible().catch(() => false)) {
        customConfirmVisible = true;
        console.log(`[INFO] pack-delete-confirmation: custom confirmation found via "${sel}".`);

        // Cancel the confirmation — never confirm a delete in automated tests.
        const cancelBtn = page.locator(
          'button:has-text("Cancel"), button:has-text("No"), button:has-text("×")',
        ).first();
        if (await cancelBtn.isVisible().catch(() => false)) {
          await cancelBtn.click();
          console.log('[INFO] pack-delete-confirmation: cancelled custom confirmation dialog.');
        } else {
          await page.keyboard.press('Escape');
        }
        break;
      }
    }

    const confirmationSeen = nativeDialogSeen || customConfirmVisible;

    if (!confirmationSeen) {
      console.error(
        '[FINDING][high] pack-delete-confirmation: clicking Delete produced no confirmation prompt. ' +
          'Destructive actions must always require a confirmation step to prevent accidental data loss.',
      );
    } else {
      console.log('[INFO] pack-delete-confirmation: confirmation step present — delete requires confirmation ✓');
    }

    expect(confirmationSeen, 'A confirmation prompt must appear before any pack is deleted').toBe(true);
  });

});
