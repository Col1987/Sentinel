import { test, expect, type Page } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';
import {
  PACK_ID,
  registerForCheckout, addPackAndGoToCheckout, fillConfigStep,
  handleSaveConfigAndReachPayment, submitPaymentAndCapture, readOrderDocument,
} from './checkout-helpers';
import { findAndOpenOrderInAdmin } from './order-lifecycle-helpers';

// Discovery (live welcomePacks catalog read via window.loadWelcomePacks()) found only one
// pack currently has an upgrade category enabled: wooden-wine ("The Arrival", R1,350),
// whisky category, default "Jonnie Walker Black Label" + 2 paid options. PACK_ID
// ('wooden-whiskey', "The Juel") has all three categories disabled — the correct
// non-qualifying pack for test 4, and already the shared baseline used everywhere else.
const UPGRADE_PACK_ID         = 'wooden-wine';
const UPGRADE_PACK_BASE_PRICE = 1350;
const WHISKY_DEFAULT_LABEL    = 'Jonnie Walker Black Label';
const WHISKY_UPGRADE_NAME     = 'Jonnie Walker Blue Label';
const WHISKY_UPGRADE_PRICE    = 400;

// Adds packId to the cart and clicks through to the point where the Personalise Your
// Pack modal would appear (for a qualifying pack) or be skipped straight past (for a
// non-qualifying one) — mirrors advanceThroughDeliveryToPayment up to and including the
// "Proceed to Payment →" click, without auto-skipping the modal the way that shared
// helper does, since these tests need to interact with (or verify the absence of) it.
async function beginCheckoutToUpgradeTrigger(page: Page, packId: string): Promise<string> {
  const checkoutEmail = await registerForCheckout(page);
  await addPackAndGoToCheckout(page, packId);
  await fillConfigStep(page);
  await page.locator('button:has-text("Proceed to Payment →")').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('button:has-text("Proceed to Payment →")').click();
  return checkoutEmail;
}

test.describe('Premium upgrades (LIVE_MODE only)', { tag: ['@functional'] }, () => {

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires real backend — set SENTINEL_LIVE_MODE=true to run');
  });

  // ── 1. Selecting an upgrade updates the modal's running total live ─────────

  test('premium-upgrade-selection-updates-total — selecting a paid upgrade updates the modal total live', async ({ page }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: 'description',
      description: `Added the '${UPGRADE_PACK_ID}' welcome pack (which has a whisky upgrade category enabled) to the cart and proceeded to the Personalise Your Pack modal. Verified the whisky category shows the default "Keep ${WHISKY_DEFAULT_LABEL} (included)" option alongside the paid alternatives with their names and prices, then selected a paid upgrade and verified the modal's running total updates live to reflect the pack's base price plus the upgrade price.`,
    });

    await beginCheckoutToUpgradeTrigger(page, UPGRADE_PACK_ID);

    const modalVisible = await page.locator('#upgrade-modal').waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false);
    if (!modalVisible) {
      console.error(
        `[FINDING][critical] premium-upgrade-selection-updates-total: the Personalise Your Pack modal did not ` +
          `appear for "${UPGRADE_PACK_ID}", which has the whisky upgrade category enabled.`,
      );
    }
    expect(modalVisible, 'The Personalise Your Pack modal must appear for a pack with an upgrade category enabled').toBe(true);

    // ── Default option present ────────────────────────────────────────────────
    const defaultOptionVisible = await page.locator(`.upgrade-option-card:has-text("Keep ${WHISKY_DEFAULT_LABEL} (included)")`)
      .isVisible().catch(() => false);
    if (!defaultOptionVisible) {
      console.error(
        `[FINDING][high] premium-upgrade-selection-updates-total: default option "Keep ${WHISKY_DEFAULT_LABEL} ` +
          `(included)" not found in the whisky category.`,
      );
    } else {
      console.log('[INFO] premium-upgrade-selection-updates-total: default included option shown ✓');
    }

    // ── Paid alternative present with name and price ──────────────────────────
    const paidCard = page.locator(`.upgrade-option-card:has-text("${WHISKY_UPGRADE_NAME}")`);
    const paidOptionVisible = await paidCard.isVisible().catch(() => false);
    const paidPriceText = (await paidCard.locator('.upgrade-option-price').textContent().catch(() => '')) ?? '';
    if (!paidOptionVisible || !paidPriceText.includes(String(WHISKY_UPGRADE_PRICE))) {
      console.error(
        `[FINDING][high] premium-upgrade-selection-updates-total: paid option "${WHISKY_UPGRADE_NAME}" not shown ` +
          `with its price — visible=${paidOptionVisible}, priceText="${paidPriceText}".`,
      );
    } else {
      console.log(`[INFO] premium-upgrade-selection-updates-total: paid option shown with price "${paidPriceText}" ✓`);
    }

    // ── Initial total is just the base price ──────────────────────────────────
    const summaryBefore = (await page.locator('#upgrade-summary').innerText().catch(() => '')) ?? '';
    const hasBasePriceOnly = summaryBefore.includes(UPGRADE_PACK_BASE_PRICE.toLocaleString());
    console.log(`[INFO] premium-upgrade-selection-updates-total: summary before selection: "${summaryBefore.replace(/\n/g, ' | ')}"`);

    // ── Select the paid upgrade and verify the total updates live ─────────────
    await paidCard.locator('input[type="radio"]').click();
    await page.waitForTimeout(300);

    const summaryAfter = (await page.locator('#upgrade-summary').innerText().catch(() => '')) ?? '';
    const expectedTotal = UPGRADE_PACK_BASE_PRICE + WHISKY_UPGRADE_PRICE;
    const totalUpdatedCorrectly = summaryAfter.includes(expectedTotal.toLocaleString());
    console.log(`[INFO] premium-upgrade-selection-updates-total: summary after selection: "${summaryAfter.replace(/\n/g, ' | ')}"`);

    if (!totalUpdatedCorrectly) {
      console.error(
        `[FINDING][critical] premium-upgrade-selection-updates-total: after selecting "${WHISKY_UPGRADE_NAME}" ` +
          `(+R${WHISKY_UPGRADE_PRICE}), the modal total did not update to reflect basePrice + upgradePrice ` +
          `(expected R${expectedTotal.toLocaleString()}). Summary shows: "${summaryAfter.replace(/\n/g, ' | ')}".`,
      );
    } else {
      console.log(`[INFO] premium-upgrade-selection-updates-total: total correctly updated to R${expectedTotal.toLocaleString()} ✓`);
    }

    expect(defaultOptionVisible, 'The default "Keep ... (included)" option must be shown').toBe(true);
    expect(paidOptionVisible && paidPriceText.includes(String(WHISKY_UPGRADE_PRICE)), 'The paid upgrade option must be shown with its name and price').toBe(true);
    expect(hasBasePriceOnly, 'Before any selection, the modal total must equal the base price').toBe(true);
    expect(totalUpdatedCorrectly, `After selecting the upgrade, the modal total must equal basePrice + upgradePrice (R${expectedTotal.toLocaleString()})`).toBe(true);
  });

  // ── 2. Selected upgrade persists to the completed order ────────────────────

  test('premium-upgrade-persists-to-order — a selected upgrade is reflected in the completed order\'s total and detail', async ({ page }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: 'description',
      description: `Selected a paid whisky upgrade in the Personalise Your Pack modal, completed checkout, and verified in the admin dashboard that the order's subtotal equals the pack's base price plus the upgrade price, and that the order detail shows the selected upgrade by name — confirming the selection made in the modal actually persists through to the order record, not just the on-screen total.`,
    });

    const checkoutEmail = await beginCheckoutToUpgradeTrigger(page, UPGRADE_PACK_ID);
    await page.locator('#upgrade-modal').waitFor({ state: 'visible', timeout: 8_000 });

    await page.locator(`.upgrade-option-card:has-text("${WHISKY_UPGRADE_NAME}") input[type="radio"]`).click();
    await page.waitForTimeout(300);
    await page.locator('#upgrade-modal button:has-text("Continue")').click();

    await handleSaveConfigAndReachPayment(page);
    await submitPaymentAndCapture(page);

    await loginAsAdmin(page);
    const orderId = await findAndOpenOrderInAdmin(page, checkoutEmail, null);
    if (!orderId) {
      console.error(
        `[FINDING][critical] premium-upgrade-persists-to-order: order for ${checkoutEmail} not found in admin after checkout.`,
      );
    }
    expect(orderId, 'The completed order must be findable in the admin dashboard').not.toBeNull();

    // ── Order detail shows the selected upgrade by name ───────────────────────
    const modalText = (await page.locator('#order-modal').innerText().catch(() => '')) ?? '';
    const upgradeNameShown = modalText.includes(WHISKY_UPGRADE_NAME);
    if (!upgradeNameShown) {
      console.error(
        `[FINDING][high] premium-upgrade-persists-to-order: selected upgrade "${WHISKY_UPGRADE_NAME}" is not ` +
          'shown in the admin order detail.',
      );
    } else {
      console.log('[INFO] premium-upgrade-persists-to-order: upgrade name shown in admin order detail ✓');
    }

    // ── Order subtotal equals basePrice + upgradeTotal ────────────────────────
    const orderDoc = await readOrderDocument(page, orderId!);
    const expectedSubtotal = UPGRADE_PACK_BASE_PRICE + WHISKY_UPGRADE_PRICE;
    const actualSubtotal = orderDoc.data?.subtotal;
    console.log(`[INFO] premium-upgrade-persists-to-order: order subtotal=${actualSubtotal}, expected=${expectedSubtotal}`);

    if (actualSubtotal !== expectedSubtotal) {
      console.error(
        `[FINDING][critical] premium-upgrade-persists-to-order: order subtotal is ${actualSubtotal}, expected ` +
          `basePrice + upgradeTotal = ${expectedSubtotal}. The selected upgrade may not be priced correctly server-side.`,
      );
    } else {
      console.log('[INFO] premium-upgrade-persists-to-order: subtotal correctly reflects basePrice + upgradeTotal ✓');
    }

    expect(actualSubtotal, `Order subtotal must equal basePrice + upgradeTotal (${expectedSubtotal})`).toBe(expectedSubtotal);
    expect(upgradeNameShown, `Admin order detail must show the selected upgrade name "${WHISKY_UPGRADE_NAME}"`).toBe(true);
  });

  // ── 3. Skipping upgrades keeps the base price ───────────────────────────────

  test('premium-upgrade-skip-keeps-base-price — skipping the upgrade modal charges only the base price', async ({ page }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: 'description',
      description: 'Reached the Personalise Your Pack modal for a pack with upgrades enabled, but clicked "Skip upgrades" instead of selecting a paid option. Verified the completed order\'s total reflects only the base price, with no upgrade charge applied.',
    });

    const checkoutEmail = await beginCheckoutToUpgradeTrigger(page, UPGRADE_PACK_ID);
    await page.locator('#upgrade-modal').waitFor({ state: 'visible', timeout: 8_000 });

    await page.locator('#upgrade-modal button:has-text("Skip upgrades")').click();

    await handleSaveConfigAndReachPayment(page);
    await submitPaymentAndCapture(page);

    await loginAsAdmin(page);
    const orderId = await findAndOpenOrderInAdmin(page, checkoutEmail, null);
    if (!orderId) {
      console.error(
        `[FINDING][critical] premium-upgrade-skip-keeps-base-price: order for ${checkoutEmail} not found in admin after checkout.`,
      );
    }
    expect(orderId, 'The completed order must be findable in the admin dashboard').not.toBeNull();

    const orderDoc = await readOrderDocument(page, orderId!);
    const actualSubtotal = orderDoc.data?.subtotal;
    console.log(`[INFO] premium-upgrade-skip-keeps-base-price: order subtotal=${actualSubtotal}, expected base price=${UPGRADE_PACK_BASE_PRICE}`);

    if (actualSubtotal !== UPGRADE_PACK_BASE_PRICE) {
      console.error(
        `[FINDING][high] premium-upgrade-skip-keeps-base-price: order subtotal is ${actualSubtotal} after ` +
          `skipping upgrades — expected the base price (${UPGRADE_PACK_BASE_PRICE}) with no upgrade charge.`,
      );
    } else {
      console.log('[INFO] premium-upgrade-skip-keeps-base-price: subtotal correctly equals base price with no upgrade charge ✓');
    }

    expect(actualSubtotal, `Order subtotal must equal the base price (${UPGRADE_PACK_BASE_PRICE}) with no upgrade charge`).toBe(UPGRADE_PACK_BASE_PRICE);
  });

  // ── 4. Non-qualifying packs never show the upgrade modal ───────────────────

  test('premium-upgrade-modal-skipped-for-non-qualifying-pack — the upgrade modal never appears for a pack with no upgrade categories enabled', async ({ page }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: 'description',
      description: `Added '${PACK_ID}' — a pack with no upgrade categories enabled — to the cart and proceeded through checkout. Verified the Personalise Your Pack modal never appears, and that checkout instead proceeds directly to the save-configuration/payment steps.`,
    });

    await beginCheckoutToUpgradeTrigger(page, PACK_ID);

    const modalAppeared = await page.locator('#upgrade-modal').waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    if (modalAppeared) {
      console.error(
        `[FINDING][high] premium-upgrade-modal-skipped-for-non-qualifying-pack: the Personalise Your Pack modal ` +
          `appeared for "${PACK_ID}", which has no upgrade categories enabled.`,
      );
    } else {
      console.log('[INFO] premium-upgrade-modal-skipped-for-non-qualifying-pack: modal correctly did not appear ✓');
    }
    expect(modalAppeared, 'The upgrade modal must not appear for a pack with no upgrade categories enabled').toBe(false);

    // Confirm checkout proceeded normally instead of getting stuck.
    await handleSaveConfigAndReachPayment(page);
    const reachedPayment = await page.locator('#checkout-step-payment').isVisible().catch(() => false);
    if (!reachedPayment) {
      console.error(
        '[FINDING][high] premium-upgrade-modal-skipped-for-non-qualifying-pack: checkout did not reach the ' +
          'payment step after the (absent) upgrade modal.',
      );
    }
    expect(reachedPayment, 'Checkout must reach the payment step when no upgrade modal is shown').toBe(true);
  });

});
