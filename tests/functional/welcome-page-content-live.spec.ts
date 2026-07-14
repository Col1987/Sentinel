import { test, expect, type Page } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';
import {
  GUEST, CHECKIN, CHECKOUT_DATE, setDateField,
  addPackAndGoToCheckout, advanceConfigSubSteps, handleSaveConfigAndReachPayment, submitPaymentAndCapture,
} from './checkout-helpers';
import { registerVerifiedAccount, createSavedProperty } from './account-helpers';
import { findAndOpenOrderInAdmin } from './order-lifecycle-helpers';

// Covers the guest welcome page's content sections — branding, house rules, restaurants/
// activities, and host contact — none of which had been mapped by this suite before now.
//
// Discovery findings (captured via a throwaway discovery run, not checked in):
// - Property form (#property-form-wrap) branding fields: #pf-brand (name), #pf-font
//   (select), #pf-logo-input (file upload). NO colour-picker field exists anywhere in the
//   form — branding is name + font + logo only.
// - House Rules (#acc-rules) is a real mechanism: every newly created property auto-
//   populates with 10 default rules via pfAddRule()/pfRemoveRule() — a property is never
//   created with zero rules.
// - Welcome page (https://juelhaus.co.za/welcome/{uuid}) renders all content sections as
//   plain scrollable text, not click-gated tabs (despite .screen class names — confirmed
//   via document.body.innerText containing every section's text without any navigation):
//     #wc-brand-header  — brand name display (home screen header)
//     #view-rules       — "House Rules" heading + every configured rule, verbatim
//     #view-food        — restaurant names, verbatim
//     #view-play        — activity names, verbatim
//     #view-host        — host name, phone as "+27 821234567", and a .wa-btn link:
//                          https://wa.me/27821234567?text=... (country code + number
//                          concatenated with no punctuation, message pre-filled)

async function gotoWelcomePageForOrder(
  page: Page,
  checkoutEmail: string,
  cfOrderId: string | null,
): Promise<string | null> {
  await loginAsAdmin(page);
  const orderId = await findAndOpenOrderInAdmin(page, checkoutEmail, cfOrderId);
  if (!orderId) return null;

  const welcomeHref = await page
    .locator('#order-modal a')
    .filter({ hasText: 'Welcome Page' })
    .getAttribute('href')
    .catch(() => null);
  if (!welcomeHref) return null;

  await page.goto(welcomeHref, { waitUntil: 'load' });
  await page.waitForTimeout(4_000); // allow async Firestore data fetch — same pattern as welcome-page-live.spec.ts
  return welcomeHref;
}

test.describe('Welcome page content sections (LIVE_MODE only)', { tag: ['@functional'] }, () => {

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires real backend and a real Gmail inbox — set SENTINEL_LIVE_MODE=true to run');
  });

  // ── 1. Branding ───────────────────────────────────────────────────────────────

  test('welcome-page-shows-correct-branding — the welcome page displays the configured brand name and font, not a default template', async ({ page }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: 'description',
      description:
        "Created a saved property with a distinctive brand name and a non-default font selected in " +
        "the 'Welcome Card Branding' section, then placed an order for it and opened the guest welcome " +
        "page. Verified the brand name shown in the page header (#wc-brand-header) matches exactly what " +
        "was configured, not a generic/default name, and checked whether the selected font is actually " +
        "applied to that header (via computed font-family) rather than silently falling back to a " +
        "default. No colour customisation field exists on the property form at this stage of testing — " +
        "documented rather than assumed. A brand name that doesn't match, or a font that doesn't apply, " +
        "is a medium-severity finding — hosts configuring their guest-facing branding would see it " +
        "silently ignored.",
    });

    const PROP_NAME  = `Sentinel Branding Test ${Date.now()}`;
    const BRAND_NAME = `Sentinel Brand ${Date.now()}`;
    const SELECTED_FONT = 'Pacifico';

    const checkoutEmail = await registerVerifiedAccount(page);
    await page.goto('/account.html', { waitUntil: 'load' });
    await page.locator('#tab-btn-properties').click({ timeout: 15_000 });
    await page.waitForTimeout(1_500);

    await createSavedProperty(page, PROP_NAME);

    // Edit the just-created property to set a distinctive brand name + font.
    const propCard = page.locator(`.prop-card:has-text("${PROP_NAME}")`);
    const propCardVisible = await propCard.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false);
    if (!propCardVisible) {
      console.error(`[FINDING][critical] welcome-page-shows-correct-branding: property "${PROP_NAME}" not found after creation — cannot configure branding.`);
      return;
    }
    await propCard.locator('button:has-text("Edit")').click();
    await page.locator('#property-form-wrap').waitFor({ state: 'visible', timeout: 5_000 });

    const brandFieldVisible = await page.locator('#pf-brand').isVisible({ timeout: 500 }).catch(() => false);
    if (!brandFieldVisible) {
      await page.locator('#acc-brand .acc-btn').click();
      await page.locator('#pf-brand').waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {});
    }
    await page.locator('#pf-brand').fill(BRAND_NAME);
    await page.locator('#pf-font').selectOption({ label: SELECTED_FONT }).catch(async () => {
      await page.locator('#pf-font').selectOption({ value: SELECTED_FONT }).catch(() => {});
    });

    // KNOWN SITE DEFECT (already documented via my-account-live.spec.ts's
    // my-properties-actual-behavior test): editing an existing property does not
    // repopulate pfState.restaurants/activities, leaving Save disabled until the user
    // re-adds an entry that already exists in the saved record. Apply the same proven
    // manual-entry workaround rather than waiting indefinitely on a Save button that
    // will never enable.
    await page.locator('#acc-restaurants .acc-btn').click();
    await page.evaluate(() => (window as any).pfToggleManualPanel('rest', true));
    await page.locator('#pf-new-rest-name').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#pf-new-rest-name').fill('Sentinel Test Restaurant Edit');
    await page.locator('button:has-text("Add Restaurant")').click();

    await page.locator('#acc-activities .acc-btn').click();
    await page.evaluate(() => (window as any).pfToggleManualPanel('act', true));
    await page.locator('#pf-new-act-name').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#pf-new-act-name').fill('Sentinel Test Activity Edit');
    await page.locator('button:has-text("Add Activity")').click();

    await page.locator('#pf-save-btn').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#pf-save-btn:not([disabled])').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    await page.locator('#pf-save-btn').click();
    await page.waitForTimeout(2_000);

    // ── Checkout via the saved-property chooser ─────────────────────────────
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => typeof (window as any).addToCart === 'function' && Array.isArray((window as any).PRODUCTS) && (window as any).PRODUCTS.length > 0,
      { timeout: 15_000 },
    ).catch(() => {});
    await addPackAndGoToCheckout(page);
    await page.locator('#prop-chooser .pcc', { hasText: PROP_NAME }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#prop-chooser .pcc', { hasText: PROP_NAME }).click();
    await page.waitForTimeout(800);
    await page.locator('#cfg-guest').last().fill(GUEST);
    await setDateField(page, 'cfg-checkin', CHECKIN);
    await setDateField(page, 'cfg-checkout', CHECKOUT_DATE);
    await advanceConfigSubSteps(page);
    await page.locator('button:has-text("Proceed to Payment →")').click();
    const skipBtn = page.locator('button:has-text("Skip upgrades")');
    if (await skipBtn.isVisible({ timeout: 5_000 }).catch(() => false)) await skipBtn.click();
    await handleSaveConfigAndReachPayment(page);
    const cfOrderId = await submitPaymentAndCapture(page);

    const welcomeHref = await gotoWelcomePageForOrder(page, checkoutEmail, cfOrderId);
    if (!welcomeHref) {
      console.error('[FINDING][critical] welcome-page-shows-correct-branding: could not reach the welcome page for the created order.');
      return;
    }

    // ── Brand name ────────────────────────────────────────────────────────────
    const brandHeaderText = ((await page.locator('#wc-brand-header').textContent().catch(() => '')) ?? '').trim();
    if (brandHeaderText !== BRAND_NAME) {
      console.error(
        `[FINDING][high] welcome-page-shows-correct-branding: #wc-brand-header shows "${brandHeaderText}", ` +
          `expected "${BRAND_NAME}" — welcome page may be showing a default/generic template instead of ` +
          'the host\'s configured branding.',
      );
    } else {
      console.log(`[INFO] welcome-page-shows-correct-branding: brand name "${BRAND_NAME}" displayed correctly ✓`);
    }
    expect(brandHeaderText, 'welcome page header must show the configured brand name').toBe(BRAND_NAME);

    // ── Font applied ──────────────────────────────────────────────────────────
    const appliedFont = await page.locator('#wc-brand-header').evaluate((el) => getComputedStyle(el).fontFamily).catch(() => '');
    const fontApplied = appliedFont.toLowerCase().includes(SELECTED_FONT.toLowerCase());
    if (!fontApplied) {
      console.warn(
        `[FINDING][medium] welcome-page-shows-correct-branding: selected font "${SELECTED_FONT}" not found in ` +
          `#wc-brand-header's computed font-family ("${appliedFont}") — the configured font may not be applied ` +
          'on the guest-facing page.',
      );
    } else {
      console.log(`[INFO] welcome-page-shows-correct-branding: font "${SELECTED_FONT}" applied ✓`);
    }

    // ── No colour field exists — documented, not assumed ─────────────────────
    console.log('[INFO] welcome-page-shows-correct-branding: property form has no colour-picker field ' +
      '(#pf-brand, #pf-font, #pf-logo-input only) — colour-matching is not a testable mechanism at this stage.');
  });

  // ── 2. House rules ───────────────────────────────────────────────────────────

  test('welcome-page-shows-house-rules — the welcome page displays the property\'s configured house rules', async ({ page }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: 'description',
      description:
        "Created a saved property (which auto-populates 10 default house rules — confirmed via " +
        "discovery to be a real, working mechanism, not something this test needed to configure " +
        "manually), placed an order for it, and opened the guest welcome page. Verified every one of " +
        "the property's configured house rules appears verbatim in the House Rules section " +
        "(#view-rules). A missing rule is a medium-severity finding — guests would be held to rules " +
        "they were never shown.",
    });

    const PROP_NAME = `Sentinel Rules Test ${Date.now()}`;
    const DEFAULT_RULES = [
      'Check-in from 14:00, check-out by 10:00',
      'No smoking inside the property',
      'Keep noise to a minimum after 22:00',
      'No parties or events of any kind',
      'No pets unless agreed in writing before arrival',
      'Registered guests only — no unauthorised overnight visitors',
      'Keep keys safe — lost keys will incur a replacement fee',
      'Leave the property clean — wash dishes and dispose of rubbish before checkout',
      'No candles or open flames inside the property',
      'Use designated parking only',
    ];

    const checkoutEmail = await registerVerifiedAccount(page);
    await page.goto('/account.html', { waitUntil: 'load' });
    await page.locator('#tab-btn-properties').click({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    await createSavedProperty(page, PROP_NAME);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => typeof (window as any).addToCart === 'function' && Array.isArray((window as any).PRODUCTS) && (window as any).PRODUCTS.length > 0,
      { timeout: 15_000 },
    ).catch(() => {});
    await addPackAndGoToCheckout(page);
    await page.locator('#prop-chooser .pcc', { hasText: PROP_NAME }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#prop-chooser .pcc', { hasText: PROP_NAME }).click();
    await page.waitForTimeout(800);
    await page.locator('#cfg-guest').last().fill(GUEST);
    await setDateField(page, 'cfg-checkin', CHECKIN);
    await setDateField(page, 'cfg-checkout', CHECKOUT_DATE);
    await advanceConfigSubSteps(page);
    await page.locator('button:has-text("Proceed to Payment →")').click();
    const skipBtn = page.locator('button:has-text("Skip upgrades")');
    if (await skipBtn.isVisible({ timeout: 5_000 }).catch(() => false)) await skipBtn.click();
    await handleSaveConfigAndReachPayment(page);
    const cfOrderId = await submitPaymentAndCapture(page);

    const welcomeHref = await gotoWelcomePageForOrder(page, checkoutEmail, cfOrderId);
    if (!welcomeHref) {
      console.error('[FINDING][critical] welcome-page-shows-house-rules: could not reach the welcome page for the created order.');
      return;
    }

    const rulesText = ((await page.locator('#view-rules').textContent().catch(() => '')) ?? '');
    if (!rulesText.trim()) {
      console.error(
        '[FINDING][high] welcome-page-shows-house-rules: #view-rules is empty — the property has ' +
          'configured house rules but none are shown to the guest.',
      );
    }

    const missingRules = DEFAULT_RULES.filter((rule) => !rulesText.includes(rule));
    if (missingRules.length > 0) {
      console.error(
        `[FINDING][medium] welcome-page-shows-house-rules: ${missingRules.length}/${DEFAULT_RULES.length} ` +
          `configured rule(s) not found on the welcome page: ${JSON.stringify(missingRules)}`,
      );
    } else {
      console.log(`[INFO] welcome-page-shows-house-rules: all ${DEFAULT_RULES.length} configured rules displayed correctly ✓`);
    }

    expect(missingRules, 'every configured house rule must appear on the welcome page').toHaveLength(0);
  });

  // ── 3. Restaurants and activities ────────────────────────────────────────────

  test('welcome-page-shows-restaurants-and-activities — the welcome page shows only this property\'s restaurants and activities, not another property\'s', async ({ page }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: 'description',
      description:
        "Created two saved properties under one account with distinctly named restaurants and " +
        "activities each (only the first was ordered — the second exists purely to prove isolation, " +
        "without paying for a second full checkout), then placed one order for the first property and " +
        "opened its guest welcome page. Verified the correct restaurant and activity names appear, and " +
        "that the second property's distinctly-named restaurant/activity do NOT appear anywhere on the " +
        "page. Data crossing between properties sharing an account is a high-severity finding — guests " +
        "would be shown recommendations for the wrong property.",
    });

    const PROP_A_NAME = `Sentinel Food Test A ${Date.now()}`;
    const PROP_B_NAME = `Sentinel Food Test B ${Date.now()}`;
    const REST_A = `Sentinel Restaurant A ${Date.now()}`;
    const ACT_A  = `Sentinel Activity A ${Date.now()}`;
    const REST_B = `Sentinel Restaurant B (must not appear) ${Date.now()}`;
    const ACT_B  = `Sentinel Activity B (must not appear) ${Date.now()}`;

    const checkoutEmail = await registerVerifiedAccount(page);
    await page.goto('/account.html', { waitUntil: 'load' });
    await page.locator('#tab-btn-properties').click({ timeout: 15_000 });
    await page.waitForTimeout(1_500);

    await createSavedProperty(page, PROP_A_NAME, { restaurantName: REST_A, activityName: ACT_A });
    await createSavedProperty(page, PROP_B_NAME, { restaurantName: REST_B, activityName: ACT_B });

    const bothCreated =
      (await page.locator(`.prop-card:has-text("${PROP_A_NAME}")`).isVisible().catch(() => false)) &&
      (await page.locator(`.prop-card:has-text("${PROP_B_NAME}")`).isVisible().catch(() => false));
    if (!bothCreated) {
      console.error('[FINDING][critical] welcome-page-shows-restaurants-and-activities: could not create both saved properties.');
    }
    expect(bothCreated, 'both saved properties must be created before proceeding').toBe(true);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => typeof (window as any).addToCart === 'function' && Array.isArray((window as any).PRODUCTS) && (window as any).PRODUCTS.length > 0,
      { timeout: 15_000 },
    ).catch(() => {});
    await addPackAndGoToCheckout(page);
    await page.locator('#prop-chooser .pcc', { hasText: PROP_A_NAME }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#prop-chooser .pcc', { hasText: PROP_A_NAME }).click();
    await page.waitForTimeout(800);
    await page.locator('#cfg-guest').last().fill(GUEST);
    await setDateField(page, 'cfg-checkin', CHECKIN);
    await setDateField(page, 'cfg-checkout', CHECKOUT_DATE);
    await advanceConfigSubSteps(page);
    await page.locator('button:has-text("Proceed to Payment →")').click();
    const skipBtn = page.locator('button:has-text("Skip upgrades")');
    if (await skipBtn.isVisible({ timeout: 5_000 }).catch(() => false)) await skipBtn.click();
    await handleSaveConfigAndReachPayment(page);
    const cfOrderId = await submitPaymentAndCapture(page);

    const welcomeHref = await gotoWelcomePageForOrder(page, checkoutEmail, cfOrderId);
    if (!welcomeHref) {
      console.error('[FINDING][critical] welcome-page-shows-restaurants-and-activities: could not reach the welcome page for the created order.');
      return;
    }

    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');

    const showsOwnRestaurant = pageText.includes(REST_A);
    const showsOwnActivity   = pageText.includes(ACT_A);
    const leaksOtherRestaurant = pageText.includes(REST_B);
    const leaksOtherActivity   = pageText.includes(ACT_B);

    if (!showsOwnRestaurant) {
      console.error(`[FINDING][high] welcome-page-shows-restaurants-and-activities: property A's restaurant "${REST_A}" not shown — empty or wrong data.`);
    } else {
      console.log(`[INFO] welcome-page-shows-restaurants-and-activities: restaurant "${REST_A}" shown correctly ✓`);
    }
    if (!showsOwnActivity) {
      console.error(`[FINDING][high] welcome-page-shows-restaurants-and-activities: property A's activity "${ACT_A}" not shown — empty or wrong data.`);
    } else {
      console.log(`[INFO] welcome-page-shows-restaurants-and-activities: activity "${ACT_A}" shown correctly ✓`);
    }
    if (leaksOtherRestaurant || leaksOtherActivity) {
      console.error(
        `[FINDING][critical] welcome-page-shows-restaurants-and-activities: property B's data leaked onto ` +
          `property A's welcome page (restaurant leaked=${leaksOtherRestaurant}, activity leaked=${leaksOtherActivity}) ` +
          '— guests are shown recommendations belonging to a different property on the same account.',
      );
    } else {
      console.log('[INFO] welcome-page-shows-restaurants-and-activities: no cross-property data leak ✓');
    }

    expect(showsOwnRestaurant, 'the ordered property\'s own restaurant must appear').toBe(true);
    expect(showsOwnActivity, 'the ordered property\'s own activity must appear').toBe(true);
    expect(leaksOtherRestaurant, 'the other property\'s restaurant must NOT appear').toBe(false);
    expect(leaksOtherActivity, 'the other property\'s activity must NOT appear').toBe(false);
  });

  // ── 4. Host contact ───────────────────────────────────────────────────────────

  test('welcome-page-shows-host-contact — the welcome page displays the correct host name and a correctly formatted WhatsApp link', async ({ page }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: 'description',
      description:
        "Created a saved property with host contact details configured (name: SENTINEL HOST, phone: " +
        "+27 821234567 — the standard test values createSavedProperty fills), placed an order for it, " +
        "and opened the guest welcome page. Verified the host name displays correctly in the Your Host " +
        "section (#view-host), and that the 'Message on WhatsApp' link's href points to the correct " +
        "wa.me number (country code + phone number concatenated, matching what was configured). A wrong " +
        "or missing WhatsApp number is a high-severity finding — guests trying to reach their host would " +
        "message the wrong person or nobody at all.",
    });

    const PROP_NAME  = `Sentinel Host Test ${Date.now()}`;
    const HOST_NAME  = 'SENTINEL HOST';
    const HOST_PHONE = '821234567';
    const EXPECTED_WA_NUMBER = `27${HOST_PHONE}`; // createSavedProperty leaves #pf-host-phone-cc at its default (+27)

    const checkoutEmail = await registerVerifiedAccount(page);
    await page.goto('/account.html', { waitUntil: 'load' });
    await page.locator('#tab-btn-properties').click({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    await createSavedProperty(page, PROP_NAME);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => typeof (window as any).addToCart === 'function' && Array.isArray((window as any).PRODUCTS) && (window as any).PRODUCTS.length > 0,
      { timeout: 15_000 },
    ).catch(() => {});
    await addPackAndGoToCheckout(page);
    await page.locator('#prop-chooser .pcc', { hasText: PROP_NAME }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#prop-chooser .pcc', { hasText: PROP_NAME }).click();
    await page.waitForTimeout(800);
    await page.locator('#cfg-guest').last().fill(GUEST);
    await setDateField(page, 'cfg-checkin', CHECKIN);
    await setDateField(page, 'cfg-checkout', CHECKOUT_DATE);
    await advanceConfigSubSteps(page);
    await page.locator('button:has-text("Proceed to Payment →")').click();
    const skipBtn = page.locator('button:has-text("Skip upgrades")');
    if (await skipBtn.isVisible({ timeout: 5_000 }).catch(() => false)) await skipBtn.click();
    await handleSaveConfigAndReachPayment(page);
    const cfOrderId = await submitPaymentAndCapture(page);

    const welcomeHref = await gotoWelcomePageForOrder(page, checkoutEmail, cfOrderId);
    if (!welcomeHref) {
      console.error('[FINDING][critical] welcome-page-shows-host-contact: could not reach the welcome page for the created order.');
      return;
    }

    // ── Host name ─────────────────────────────────────────────────────────────
    const hostSectionText = ((await page.locator('#view-host').textContent().catch(() => '')) ?? '');
    const hostNameShown = hostSectionText.includes(HOST_NAME);
    if (!hostNameShown) {
      console.error(`[FINDING][high] welcome-page-shows-host-contact: host name "${HOST_NAME}" not found in #view-host ("${hostSectionText.slice(0, 150)}").`);
    } else {
      console.log(`[INFO] welcome-page-shows-host-contact: host name "${HOST_NAME}" displayed correctly ✓`);
    }

    // ── WhatsApp link ─────────────────────────────────────────────────────────
    const waHref = await page.locator('a.wa-btn').getAttribute('href').catch(() => null);
    if (!waHref) {
      console.error('[FINDING][high] welcome-page-shows-host-contact: no WhatsApp link (a.wa-btn) found on the welcome page — guests have no way to message the host.');
    } else {
      console.log(`[INFO] welcome-page-shows-host-contact: WhatsApp link href = "${waHref}"`);
      const waNumberCorrect = waHref.includes(`wa.me/${EXPECTED_WA_NUMBER}`);
      if (!waNumberCorrect) {
        console.error(
          `[FINDING][high] welcome-page-shows-host-contact: WhatsApp link does not point to the expected ` +
            `number "${EXPECTED_WA_NUMBER}" (href: "${waHref}") — guests messaging the host would reach the ` +
            'wrong number or an invalid link.',
        );
      } else {
        console.log(`[INFO] welcome-page-shows-host-contact: WhatsApp link number "${EXPECTED_WA_NUMBER}" correct ✓`);
      }
      expect(waNumberCorrect, `WhatsApp link must point to wa.me/${EXPECTED_WA_NUMBER}`).toBe(true);
    }

    expect(hostNameShown, 'host name must appear in #view-host').toBe(true);
    expect(waHref, 'a WhatsApp link (a.wa-btn) must be present').toBeTruthy();
  });

});
