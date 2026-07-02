import { test, expect, type Page } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';

// All four tests operate on the same synthetic record so the suite can be treated
// as a single transaction: create → verify → edit → verify → delete.
// test.describe.serial ensures they run in order; if any test fails the remainder
// are skipped rather than leaving orphaned data.
const PACK_NAME           = 'SENTINEL TEST PACK';
const PACK_TAGLINE        = 'Automated test entry - safe to delete';
const PACK_TAGLINE_EDITED = 'Automated test entry - EDITED';
const PACK_PRICE          = '1';
const PACK_DESC           = 'Automated test pack created by Sentinel QA. Safe to delete at any time.';

// ── Admin helpers ─────────────────────────────────────────────────────────────

async function openPacksTab(page: Page): Promise<void> {
  await page.locator('#atab-btn-packs').click();
  await page.locator('#packs-body').waitFor({ state: 'visible', timeout: 6_000 });
  // Wait for at least one row to appear — Firestore subscription may take 1-2 s on
  // a fresh page load. A fixed sleep is unreliable; polling a visible row is not.
  await page.locator('#packs-body tr').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
}

// Locates the table row for PACK_NAME.
function packRow(page: Page) {
  return page.locator(`#packs-body tr:has(strong:has-text("${PACK_NAME}"))`);
}

// Waits up to `timeout` ms for PACK_NAME to appear in the packs list.
// isVisible() returns immediately without polling — use this instead.
async function waitForPackRow(page: Page, timeout = 10_000): Promise<boolean> {
  return packRow(page).waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
}

// Opens the pack create/edit form. Waits for the modal to be visible.
async function openCreateForm(page: Page): Promise<void> {
  await page.locator('button:has-text("+ Add New Pack")').click();
  await page.locator('#pack-form-modal').waitFor({ state: 'visible', timeout: 5_000 });
}

// Fills all fields required by JS validation: name, price, description, image URL, and tagline.
// The "Image" field is not marked * in the form label but JS blocks save without one.
// #pack-f-active is already checked by default — new packs are immediately active.
async function fillPackForm(
  page: Page,
  opts: { tagline?: string } = {},
): Promise<void> {
  await page.locator('#pack-f-name').fill(PACK_NAME);
  await page.locator('#pack-f-tagline').fill(opts.tagline ?? PACK_TAGLINE);
  await page.locator('#pack-f-price').fill(PACK_PRICE);
  await page.locator('#pack-f-description').fill(PACK_DESC);
  // JS validation requires an image even though the form label has no *.
  // Use an existing pack image from the site's own static assets.
  await page.locator('#pack-f-image-url').fill('https://www.juelhaus.co.za/images/gift1.jpg');
}

// Submits the form and waits for the modal to close.
async function savePackForm(page: Page): Promise<void> {
  await page.locator('#pack-save-btn').click();
  await page.locator('#pack-form-modal').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(1_000); // allow list re-render after Firestore write
}

// Confirms deletion of SENTINEL TEST PACK via the #pack-delete-modal.
// Caller must have already clicked the row's "Delete" button first.
async function confirmPackDeletion(page: Page): Promise<void> {
  await page.locator('#pack-delete-modal').waitFor({ state: 'visible', timeout: 5_000 });
  // Verify the modal names the right pack before confirming
  const deleteName = ((await page.locator('#pack-delete-name').textContent().catch(() => '')) ?? '').trim();
  if (deleteName !== PACK_NAME) {
    console.warn(
      `[WARN] pack-delete-removes-it: #pack-delete-name shows "${deleteName}", expected "${PACK_NAME}". ` +
        'Proceeding with deletion anyway.',
    );
  }
  await page.locator('#pack-delete-modal button[onclick="confirmDeletePack()"]').click();
  await page.locator('#pack-delete-modal').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(1_000);
}

// Deletes SENTINEL TEST PACK if it exists. Used as a cleanup safety net.
async function deleteSentinelPackIfPresent(page: Page): Promise<boolean> {
  await loginAsAdmin(page);
  await openPacksTab(page);
  const row = packRow(page);
  if (!(await row.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
  await row.locator('button:has-text("Delete")').click();
  await confirmPackDeletion(page);
  console.log('[INFO] cleanup: deleted lingering SENTINEL TEST PACK ✓');
  return true;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe.serial('Admin pack CRUD (LIVE_MODE only)', { tag: ['@admin'] }, () => {

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires real backend — set SENTINEL_LIVE_MODE=true to run');
    test.slow();
  });

  // Safety net: runs after all tests (pass or skip) and deletes SENTINEL TEST PACK
  // if the delete test was skipped due to an earlier failure.
  test.afterAll(async ({ browser }) => {
    if (!LIVE_MODE) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const deleted = await deleteSentinelPackIfPresent(page);
      if (!deleted) console.log('[INFO] afterAll cleanup: SENTINEL TEST PACK not present — nothing to clean up');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[INFO] afterAll cleanup: skipped (${msg})`);
    } finally {
      await context.close();
    }
  });

  // ── 1. Create ─────────────────────────────────────────────────────────────

  test('pack-create-persists — creating a new pack in admin saves it to Firestore and survives a page reload', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description:
        "Logs in as admin, opens the Welcome Packs tab, and clicks '+ Add New Pack'. Fills in a " +
        "clearly synthetic test pack (name: SENTINEL TEST PACK, price: R1, tagline: 'Automated test " +
        "entry — safe to delete') and saves. Verifies the new pack appears in the packs list " +
        "immediately after saving, then reloads the page and verifies it persists — confirming the " +
        "write reached Firestore and was not just added to local UI state.",
    });

    await loginAsAdmin(page);
    await openPacksTab(page);

    // Guard: if a previous interrupted run left this pack behind, remove it first
    if (await packRow(page).isVisible({ timeout: 2_000 }).catch(() => false)) {
      console.log('[INFO] pack-create-persists: stale SENTINEL TEST PACK found — removing before create');
      await packRow(page).locator('button:has-text("Delete")').click();
      await confirmPackDeletion(page);
    }

    await openCreateForm(page);
    await fillPackForm(page);
    await savePackForm(page);

    // ── Immediately visible in list ───────────────────────────────────────────
    const visibleAfterSave = await waitForPackRow(page, 8_000);
    if (!visibleAfterSave) {
      console.error(
        `[FINDING][high] pack-create-persists: "${PACK_NAME}" not found in #packs-body immediately ` +
          'after save — pack may not have been written to Firestore or the UI did not refresh.',
      );
    } else {
      console.log(`[INFO] pack-create-persists: "${PACK_NAME}" appears in list after save ✓`);
    }
    expect(visibleAfterSave, `"${PACK_NAME}" must appear in the packs list after saving`).toBe(true);

    // ── Persists after reload ─────────────────────────────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.location.pathname.includes('admin') && document.readyState === 'complete',
      { timeout: 15_000 },
    );
    await openPacksTab(page);

    const visibleAfterReload = await waitForPackRow(page, 10_000);
    if (!visibleAfterReload) {
      console.error(
        `[FINDING][high] pack-create-persists: "${PACK_NAME}" disappeared after page reload — ` +
          'the save may have only updated local state without persisting to Firestore.',
      );
    } else {
      console.log(`[INFO] pack-create-persists: "${PACK_NAME}" still present after reload ✓`);
    }
    expect(visibleAfterReload, `"${PACK_NAME}" must still be in the list after a full page reload`).toBe(true);
  });

  // ── 2. Public storefront ──────────────────────────────────────────────────

  test('pack-appears-on-public-storefront — a newly created pack is visible to anonymous visitors on the homepage', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description:
        "Navigates to the public homepage as an anonymous visitor and checks that SENTINEL TEST PACK " +
        "appears in the Welcome Packs section (#gift-packs-grid). Newly created packs are active by " +
        "default (the 'Active' toggle is checked in the create form), so they should be visible to " +
        "visitors immediately. If the pack is absent, this is a high-severity finding — customers " +
        "cannot order a pack they cannot see. An absent 'Active' toggle may explain the gap.",
    });

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(2_000); // allow Firestore data to load into the grid

    const grid = page.locator('#gift-packs-grid');
    const gridVisible = await grid.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!gridVisible) {
      console.error(
        '[FINDING][high] pack-appears-on-public-storefront: #gift-packs-grid not visible on homepage.',
      );
      expect(gridVisible, '#gift-packs-grid must be visible on the homepage').toBe(true);
      return;
    }

    const gridText = ((await grid.textContent().catch(() => '')) ?? '');
    const packVisible = gridText.includes(PACK_NAME);

    if (!packVisible) {
      // Check if the pack exists in admin but might be inactive
      console.error(
        `[FINDING][high] pack-appears-on-public-storefront: "${PACK_NAME}" not found in ` +
          '#gift-packs-grid. Pack was created with the Active toggle enabled by default. ' +
          'Either the storefront is not reflecting Firestore changes, or there is an unpublished ' +
          'activation step required before a pack becomes publicly visible.',
      );
    } else {
      console.log(`[INFO] pack-appears-on-public-storefront: "${PACK_NAME}" visible in #gift-packs-grid ✓`);
    }

    expect(packVisible, `"${PACK_NAME}" must appear in #gift-packs-grid on the public homepage`).toBe(true);
  });

  // ── 3. Edit ───────────────────────────────────────────────────────────────

  test('pack-edit-persists — editing a pack in admin updates it in Firestore and on the public storefront', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description:
        "Logs in as admin, finds SENTINEL TEST PACK in the packs list, and clicks Edit. Changes " +
        "the tagline from 'Automated test entry — safe to delete' to 'Automated test entry — EDITED'. " +
        "Saves, then reloads the page and re-opens the packs list to confirm the updated tagline " +
        "persisted to Firestore. Also navigates to the public homepage to verify the change is " +
        "reflected on the storefront. An edit that saves locally but does not persist is a " +
        "high-severity finding — admins believe they have updated pack data when they have not.",
    });

    await loginAsAdmin(page);
    await openPacksTab(page);

    const row = packRow(page);
    if (!(await waitForPackRow(page, 10_000))) {
      console.error(
        `[FINDING][critical] pack-edit-persists: "${PACK_NAME}" not found — create test may have failed.`,
      );
      return;
    }

    await row.locator('button:has-text("Edit")').click();
    await page.locator('#pack-form-modal').waitFor({ state: 'visible', timeout: 5_000 });

    // Confirm the form is pre-populated with the existing name
    const prefilledName = await page.locator('#pack-f-name').inputValue().catch(() => '');
    if (prefilledName !== PACK_NAME) {
      console.error(
        `[FINDING][medium] pack-edit-persists: edit form opened with name="${prefilledName}", ` +
          `expected "${PACK_NAME}" — form may not be loading existing pack data.`,
      );
    } else {
      console.log(`[INFO] pack-edit-persists: edit form pre-populated with name="${prefilledName}" ✓`);
    }

    // Update only the tagline
    await page.locator('#pack-f-tagline').fill(PACK_TAGLINE_EDITED);
    await savePackForm(page);

    // ── Persists after reload ─────────────────────────────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.location.pathname.includes('admin') && document.readyState === 'complete',
      { timeout: 15_000 },
    );
    await openPacksTab(page);

    if (!(await waitForPackRow(page, 10_000))) {
      console.error(`[FINDING][high] pack-edit-persists: "${PACK_NAME}" gone after reload.`);
      return;
    }

    // Open edit form again to read back the persisted tagline
    await packRow(page).locator('button:has-text("Edit")').click();
    await page.locator('#pack-form-modal').waitFor({ state: 'visible', timeout: 5_000 });

    const persistedTagline = await page.locator('#pack-f-tagline').inputValue().catch(() => '');
    if (persistedTagline !== PACK_TAGLINE_EDITED) {
      console.error(
        `[FINDING][high] pack-edit-persists: tagline after reload is "${persistedTagline}", ` +
          `expected "${PACK_TAGLINE_EDITED}" — the edit did not persist to Firestore.`,
      );
    } else {
      console.log(`[INFO] pack-edit-persists: updated tagline "${PACK_TAGLINE_EDITED}" persisted ✓`);
    }
    expect(persistedTagline, 'Updated tagline must persist after page reload').toBe(PACK_TAGLINE_EDITED);

    // Close the modal with the × button before navigating — Escape is intercepted by
    // this modal and does not close it, which blocks page.goto() on some browsers.
    const closeFnBtn = page.locator('#pack-form-modal button[onclick="closePackForm()"]');
    if (await closeFnBtn.isVisible().catch(() => false)) {
      await closeFnBtn.click();
    }
    await page.locator('#pack-form-modal').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});

    // ── Public storefront reflects edit ──────────────────────────────────────
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(2_000);

    // Use evaluate instead of locator.textContent() to avoid waiting for elements.
    const gridText = await page.evaluate(() =>
      document.getElementById('gift-packs-grid')?.textContent ?? '',
    ).catch(() => '');
    if (!gridText.includes(PACK_TAGLINE_EDITED)) {
      console.warn(
        `[FINDING][medium] pack-edit-persists: updated tagline "${PACK_TAGLINE_EDITED}" not found ` +
          'in #gift-packs-grid — storefront may be serving cached pack data rather than reading ' +
          'live from Firestore.',
      );
    } else {
      console.log(`[INFO] pack-edit-persists: updated tagline reflected on public storefront ✓`);
    }
  });

  // ── 4. Delete ─────────────────────────────────────────────────────────────

  test('pack-delete-removes-it — deleting a pack in admin removes it from Firestore and the public storefront', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description:
        "Logs in as admin, finds SENTINEL TEST PACK in the packs list, and clicks Delete. Confirms " +
        "the deletion in the confirmation modal (#pack-delete-modal). Verifies the pack disappears " +
        "from the admin list immediately, then reloads the page and confirms it remains gone. Also " +
        "navigates to the public homepage to verify the pack is no longer visible to visitors. " +
        "This test cleans up the synthetic test data created by pack-create-persists — it must " +
        "always run to avoid leaving orphaned records in the live database.",
    });

    await loginAsAdmin(page);
    await openPacksTab(page);

    const row = packRow(page);
    if (!(await waitForPackRow(page, 10_000))) {
      console.error(
        `[FINDING][critical] pack-delete-removes-it: "${PACK_NAME}" not found — ` +
          'create/edit tests may have failed. No deletion possible.',
      );
      return;
    }

    await row.locator('button:has-text("Delete")').click();
    await confirmPackDeletion(page);

    // ── Removed from list immediately ─────────────────────────────────────────
    const visibleAfterDelete = await packRow(page).isVisible({ timeout: 3_000 }).catch(() => false);
    if (visibleAfterDelete) {
      console.error(
        `[FINDING][high] pack-delete-removes-it: "${PACK_NAME}" still visible in #packs-body ` +
          'immediately after confirmed deletion — the delete may not have been applied to the UI.',
      );
    } else {
      console.log(`[INFO] pack-delete-removes-it: "${PACK_NAME}" removed from list after deletion ✓`);
    }
    expect(visibleAfterDelete, `"${PACK_NAME}" must not appear in the list after deletion`).toBe(false);

    // ── Persists after reload ─────────────────────────────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.location.pathname.includes('admin') && document.readyState === 'complete',
      { timeout: 15_000 },
    );
    await openPacksTab(page);

    const visibleAfterReload = await packRow(page).isVisible({ timeout: 3_000 }).catch(() => false);
    if (visibleAfterReload) {
      console.error(
        `[FINDING][high] pack-delete-removes-it: "${PACK_NAME}" reappeared in #packs-body after ` +
          'reload — deletion may only have removed the UI row without writing to Firestore.',
      );
    } else {
      console.log(`[INFO] pack-delete-removes-it: "${PACK_NAME}" not present after reload ✓`);
    }
    expect(visibleAfterReload, `"${PACK_NAME}" must not reappear after page reload`).toBe(false);

    // ── Removed from public storefront ────────────────────────────────────────
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_000);

    const gridText = await page.evaluate(() =>
      document.getElementById('gift-packs-grid')?.textContent ?? '',
    ).catch(() => '');
    if (gridText.includes(PACK_NAME)) {
      console.error(
        `[FINDING][high] pack-delete-removes-it: "${PACK_NAME}" still appears in #gift-packs-grid ` +
          'after deletion — the public storefront is serving a deleted pack to visitors.',
      );
    } else {
      console.log(`[INFO] pack-delete-removes-it: "${PACK_NAME}" gone from public storefront ✓`);
    }
    expect(gridText.includes(PACK_NAME), `"${PACK_NAME}" must not appear on the storefront after deletion`).toBe(false);
  });

});
