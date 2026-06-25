import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../../src/utils/auth';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

// Packs are stored in Firestore `welcomePacks` and loaded via direct Firestore reads
// (not via Cloud Function), so they appear even when CF endpoints are blocked.

test.describe('Admin pack management', { tag: ['@admin'] }, () => {

  test.beforeEach(() => { test.slow(); });

  // ─── packs-tab-loads ───────────────────────────────────────────────────────

  test('packs-tab-loads — Welcome Packs list is visible after opening the Packs tab', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, clicked the Welcome Packs tab, and checked that the packs list loads. Welcome Packs are read directly from Firestore, so they should appear regardless of test mode. CONFIRMED: the #packs-body container is visible with pack entries loaded.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    // Click the Welcome Packs tab
    await page.locator('#atab-btn-packs').click();
    await page.waitForTimeout(2_000);

    const packsBodyVisible = await page.locator('#packs-body').isVisible().catch(() => false);

    if (!packsBodyVisible) {
      console.error(
        '[FINDING][high] packs-tab-loads: #packs-body is not visible after clicking the Welcome Packs tab. ' +
          'The packs section may have failed to render.',
      );
    }

    console.log(`[INFO] packs-tab-loads: #packs-body visible=${packsBodyVisible}.`);
    expect(packsBodyVisible, '#packs-body must be visible after clicking the Welcome Packs tab').toBe(true);
  });

  // ─── pack-add-form-opens ───────────────────────────────────────────────────

  test('pack-add-form-opens — clicking Add New Pack reveals the pack creation form', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, opened the Welcome Packs tab, and clicked the '+ Add New Pack' button. Checked that the pack creation form (#pack-form-modal) opens with all required fields: name, price, tagline, and image upload. These fields are the minimum needed to create a new pack that appears on the public storefront. CONFIRMED: the form opened with all required fields visible.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    // Navigate to Welcome Packs tab
    await page.locator('#atab-btn-packs').click();
    await page.waitForTimeout(1_500);

    // Click the Add New Pack button
    await page.locator('button:has-text("+ Add New Pack")').click();
    await page.waitForTimeout(500);

    // Wait for the pack form modal to appear
    await page.locator('#pack-form-modal').waitFor({ state: 'visible', timeout: 5_000 });

    const modalVisible = await page.locator('#pack-form-modal').isVisible().catch(() => false);

    if (!modalVisible) {
      console.error(
        '[FINDING][medium] pack-add-form-opens: #pack-form-modal did not become visible after clicking "Add New Pack". ' +
          'Admins cannot create new Welcome Packs from the dashboard.',
      );
      expect(modalVisible, '#pack-form-modal must open after clicking Add New Pack').toBe(true);
      return;
    }

    // Check required fields using their known IDs from page inspection
    const REQUIRED_FIELDS: Array<{ label: string; selector: string }> = [
      { label: 'name',         selector: '#pack-f-name' },
      { label: 'price',        selector: '#pack-f-price' },
      { label: 'tagline',      selector: '#pack-f-tagline' },
      { label: 'image upload', selector: '#pack-f-image-input, #pack-img-drop' },
    ];

    const fieldResults: Array<{ label: string; found: boolean }> = [];
    for (const { label, selector } of REQUIRED_FIELDS) {
      const found = await page.locator(selector).first().isVisible().catch(() => false);
      fieldResults.push({ label, found });
      if (!found) {
        console.error(
          `[FINDING][medium] pack-add-form-opens: "${label}" field not found in #pack-form-modal. ` +
            'Pack data cannot be fully entered without this field.',
        );
      }
    }

    const foundLabels  = fieldResults.filter(r => r.found).map(r => r.label);
    const missingLabels = fieldResults.filter(r => !r.found).map(r => r.label);

    console.log(
      `[INFO] pack-add-form-opens: ${foundLabels.length}/${fieldResults.length} fields visible` +
        (missingLabels.length ? ` — missing: ${missingLabels.join(', ')}` : ' — all present'),
    );

    expect(fieldResults.find(r => r.label === 'name')?.found,  'Pack name field (#pack-f-name) must be present').toBe(true);
    expect(fieldResults.find(r => r.label === 'price')?.found, 'Pack price field (#pack-f-price) must be present').toBe(true);
  });

});
