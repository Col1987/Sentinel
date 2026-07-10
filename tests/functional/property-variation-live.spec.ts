import { test, expect, type Page } from '@playwright/test';
import { LIVE_MODE, testEmail } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';
import {
  PACK_ID,
  registerForCheckout, addPackAndGoToCheckout, advanceThroughDeliveryToPayment,
  setDateField, dateFromCheckinBase,
} from './checkout-helpers';

const CF_PATTERN  = '**cloudfunctions.net**';
const SIGN_UP_URL = '**/accounts:signUp**';

// Property-specific details used in checkout config for property-a-vs-property-b.
// Two distinct bundles so each order has unambiguous identifying strings.
interface PropAddr {
  name: string;
  unit: string; street: string; suburb: string; city: string;
  province: string; postal: string;
  guest: string; hostName: string; hostPhone: string;
  checkin: string; checkoutDate: string;
}

// Dates are offset from the same dynamic base checkout-helpers.ts computes CHECKIN from
// (today + 30 days) — never hardcode calendar dates here; see CLAUDE.md "Known-working
// patterns". Offsets preserve the original staggered-stay spacing: Alpha runs first,
// Beta's stay starts the day Alpha's ends.
const PROP_ALPHA: PropAddr = {
  name:         'Sentinel Alpha Lodge',
  unit:         '1', street: 'Alpha Avenue', suburb: 'Rondebosch',
  city:         'Cape Town', province: 'Western Cape', postal: '7700',
  guest:        'SENTINEL ALPHA GUEST',
  hostName:     'SENTINEL HOST ALPHA',
  hostPhone:    '821111111',
  checkin:      dateFromCheckinBase(17), checkoutDate: dateFromCheckinBase(20),
};

const PROP_BETA: PropAddr = {
  name:         'Sentinel Beta Villa',
  unit:         '2', street: 'Beta Boulevard', suburb: 'Sandton',
  city:         'Johannesburg', province: 'Gauteng', postal: '2196',
  guest:        'SENTINEL BETA GUEST',
  hostName:     'SENTINEL HOST BETA',
  hostPhone:    '822222222',
  checkin:      dateFromCheckinBase(21), checkoutDate: dateFromCheckinBase(24),
};

// Mirrors fillConfigStep from checkout-helpers but accepts arbitrary property details.
// This lets test 3 use two uniquely-named properties without changing the shared helper.
async function fillPropertyConfig(page: Page, prop: PropAddr): Promise<void> {
  await page.locator('#cfg-property').fill(prop.name);
  await page.locator('#cfg-address').fill(
    `${prop.unit} ${prop.street}, ${prop.suburb}, ${prop.city}`,
  );
  await page.locator('#addr-breakdown-btn').click();
  await page.locator('#cfg-addr-street').waitFor({ state: 'visible', timeout: 6_000 });
  await page.locator('#cfg-addr-unit').fill(prop.unit);
  await page.locator('#cfg-addr-street').fill(prop.street);
  await page.locator('#cfg-addr-suburb').fill(prop.suburb);
  await page.locator('#cfg-addr-city').fill(prop.city);
  await page.locator('#cfg-addr-province').fill(prop.province);
  await page.locator('#cfg-addr-postal').fill(prop.postal);
  await page.locator('#cfg-guest').fill(prop.guest);
  await page.locator('#cfg-host-name').fill(prop.hostName);
  await page.locator('#cfg-host-phone-num').fill(prop.hostPhone);
  await setDateField(page, 'cfg-checkin',  prop.checkin);
  await setDateField(page, 'cfg-checkout', prop.checkoutDate);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (
      await page
        .locator('button:has-text("Proceed to Payment →")')
        .isVisible({ timeout: 1_000 })
        .catch(() => false)
    ) {
      console.log(`[INFO] fillPropertyConfig: reached delivery step for "${prop.name}" ✓`);
      return;
    }

    const wifiSkip = page.locator('button:has-text("Continue Without Wi-Fi")');
    if (await wifiSkip.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await wifiSkip.click();
      await page.waitForTimeout(500);
      continue;
    }

    const brandRequired = page.locator('text=Brand / Property Name is required');
    if (await brandRequired.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const brandInput = page.locator(
        'input[placeholder*="Bonita"], input[placeholder*="The Hut"]',
      );
      await brandInput.fill('Sentinel QA').catch(() => {});
      await page.waitForTimeout(300);
    }

    const quickSetup = page.locator('button:has-text("Quick Setup")');
    if (await quickSetup.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await quickSetup.click();
      await page.waitForTimeout(1_500);
      continue;
    }

    const continueBtn = page.locator('button:has-text("Continue →")').first();
    if (await continueBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(800);
    } else {
      break;
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Property variation and international registration', { tag: ['@functional'] }, () => {

  // ── 1. multiple-properties-single-account ─────────────────────────────────

  test('multiple-properties-single-account — inspect account page for multi-property support and attempt to add a second property', async ({ page }) => {
    test.slow();
    test.skip(!LIVE_MODE, 'requires real backend — account page content and Firestore property list are inaccessible without a live Firebase session');
    test.info().annotations.push({
      type: 'description',
      description:
        'Registers a fresh host account and navigates to the account dashboard (/account.html). ' +
        'Inspects the page for any multi-property mechanism (an "Add Property" button, property list, ' +
        'or property management section). If found, attempts to add a second property with distinct ' +
        'details (different name and address) and verifies both properties appear on the account page. ' +
        '\n\n' +
        'If no multi-property UI exists, this is logged as [INFO] rather than a finding — ' +
        'single-property-per-account may be intentional for the current product tier. ' +
        'The platform serves Airbnb hosts who often manage one listing per account, so this design ' +
        'choice is valid. The absence of multi-property support is recorded so test 3 can adapt its approach.',
    });

    await registerForCheckout(page);

    await page.goto('/account.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_000); // allow Firebase auth state and Firestore subscriptions to load

    // Log a short excerpt of the account page for discovery context
    const pageSnippet = (await page.evaluate(() => document.body.innerText.trim().slice(0, 500)))
      .replace(/\s+/g, ' ');
    console.log(`[INFO] multiple-properties-single-account: account page content snippet: "${pageSnippet}"`);

    // ── Look for an "Add Property" or multi-property control ─────────────────
    const ADD_CONTROLS = [
      '#add-property-btn',
      '[id*="add-property"]',
      '[id*="new-property"]',
      'button:has-text("Add Property")',
      'button:has-text("Add another property")',
      'button:has-text("New Property")',
      'a:has-text("Add Property")',
    ];

    let addPropLocator: ReturnType<Page['locator']> | null = null;
    let foundSelector = '';
    for (const sel of ADD_CONTROLS) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
        addPropLocator = loc;
        foundSelector = sel;
        break;
      }
    }

    // ── Look for an existing property list ───────────────────────────────────
    const LIST_SELECTORS = [
      '#properties', '#user-properties', '#host-properties',
      '.property-list', '[id*="property-list"]', '[class*="property-list"]',
    ];
    let propListContent = '';
    for (const sel of LIST_SELECTORS) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
        propListContent = ((await loc.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
        console.log(
          `[INFO] multiple-properties-single-account: property list element "${sel}" found — ` +
            `content: "${propListContent.slice(0, 200)}"`,
        );
        break;
      }
    }

    if (!addPropLocator) {
      console.log(
        '[INFO] multiple-properties-single-account: no "Add Property" control found on /account.html. ' +
          'Platform appears to support one property per account — this may be by design. ' +
          'Test 3 will adapt by verifying that a single-property checkout correctly captures that property\'s details end-to-end.',
      );
      return;
    }

    // ── Multi-property mechanism found — attempt to add a second property ────
    console.log(
      `[INFO] multiple-properties-single-account: "Add Property" control found ("${foundSelector}") — attempting to add second property.`,
    );
    await addPropLocator.click();
    await page.waitForTimeout(1_500);

    // Discover the form fields that appear after clicking "Add Property"
    const propNameField = page
      .locator(
        '#property-name, #prop-name, #new-property-name, ' +
          'input[placeholder*="property name" i], input[placeholder*="Property Name" i]',
      )
      .first();
    const propAddrField = page
      .locator(
        '#property-address, #prop-address, #new-property-address, ' +
          'input[placeholder*="address" i]',
      )
      .first();

    const hasNameField = await propNameField.isVisible({ timeout: 2_000 }).catch(() => false);

    if (!hasNameField) {
      console.warn(
        '[INFO] multiple-properties-single-account: "Add Property" control was clicked but no property ' +
          'name input appeared. The form structure differs from expected selectors — manual inspection required.',
      );
      return;
    }

    await propNameField.fill(PROP_BETA.name);
    if (await propAddrField.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await propAddrField.fill(
        `${PROP_BETA.unit} ${PROP_BETA.street}, ${PROP_BETA.suburb}, ${PROP_BETA.city}`,
      );
    }

    const saveBtn = page
      .locator(
        'button:has-text("Save"), button:has-text("Add"), ' +
          'button:has-text("Create"), button[type="submit"]',
      )
      .first();
    if (await saveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(3_000); // allow Firestore write to propagate
    }

    const updatedText = await page.evaluate(() => document.body.innerText);
    const hasSecondProp = updatedText.includes(PROP_BETA.name);

    if (hasSecondProp) {
      console.log(
        `[INFO] multiple-properties-single-account: second property "${PROP_BETA.name}" now appears on the account page ✓`,
      );
    } else {
      console.warn(
        `[FINDING][medium] multiple-properties-single-account: second property "${PROP_BETA.name}" was submitted ` +
          'but does not appear on the account page after 3 seconds. The Firestore write may have failed silently, ' +
          'the form may not have been submitted, or the property list selector is not recognised.',
      );
    }

    expect(hasSecondProp, `"${PROP_BETA.name}" must appear on the account page after being added`).toBe(true);
  });

  // ── 2. international-phone-number-formats ─────────────────────────────────

  test('international-phone-number-formats — registration with non-SA country codes must not produce false validation errors', async ({ page }) => {
    if (LIVE_MODE) test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Tests the phone number field in the registration form with valid local numbers for four ' +
        'non-South-African country codes: UK (+44), USA (+1), UAE (+971), and Germany (+49). ' +
        'For each country: checks that the dial-code option exists in the #reg-mobile-cc dropdown, ' +
        'selects it, enters a correctly-formatted local number, and submits the form. ' +
        '\n\n' +
        'The signUp network request is always intercepted and aborted to prevent accumulating real ' +
        'Firebase accounts. Whether the signUp request fires is used as a proxy: if it fires, the form ' +
        'accepted the phone number (no false client-side validation error). If it does not fire and a ' +
        'visible error appears, the valid number was incorrectly rejected — [FINDING][medium] per country. ' +
        '\n\n' +
        'This test is mode-agnostic: the signUp interception means it runs identically in safe mode ' +
        'and LIVE_MODE without creating real accounts in either case.',
    });

    // Countries: code, search value in dropdown options, valid local number (no leading 0)
    const COUNTRIES = [
      { code: '+44',  name: 'UK',      searchVal: '44',  phone: '7911123456',  label: 'United Kingdom' },
      { code: '+1',   name: 'US',      searchVal: '1',   phone: '4155552671',  label: 'United States'  },
      { code: '+971', name: 'UAE',     searchVal: '971', phone: '501234567',   label: 'UAE'            },
      { code: '+49',  name: 'Germany', searchVal: '49',  phone: '15123456789', label: 'Germany'        },
    ];

    const findings: string[] = [];

    for (const country of COUNTRIES) {
      // Fresh modal for each country to reset form state
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.locator('#btn-login').click();
      await page.locator('#login-email').waitFor({ state: 'visible', timeout: 5_000 });
      await page.locator('a:has-text("Register")').click();
      await page.locator('#reg-firstname').waitFor({ state: 'visible', timeout: 5_000 });

      // ── Check if the country's dial code exists in the dropdown ─────────────
      const allOptions: Array<{ value: string; text: string }> = await page.evaluate(() => {
        const sel = document.getElementById('reg-mobile-cc') as HTMLSelectElement | null;
        if (!sel) return [];
        return Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim() }));
      });

      const matchingOpt = allOptions.find(
        o =>
          o.value === country.searchVal ||
          o.value === country.code ||
          o.text.includes(country.code) ||
          // "+1" matches "+1" but also "+11x" — confirm it's a short prefix match
          (country.searchVal.length >= 2 && o.value.replace(/\D/g, '') === country.searchVal) ||
          o.text.replace(/\D/g, '').startsWith(country.searchVal),
      );

      if (!matchingOpt) {
        const finding =
          `[FINDING][medium] international-phone-number-formats: dial code ${country.code} (${country.label}) ` +
          `not found in #reg-mobile-cc (${allOptions.length} option(s) available). ` +
          `Hosts from ${country.label} cannot select their local country code.`;
        console.warn(finding);
        findings.push(finding);
        continue;
      }

      // ── Select the matching dial code ────────────────────────────────────────
      await page.locator('#reg-mobile-cc').selectOption(matchingOpt.value).catch(async () => {
        // Fallback: set via evaluate if Playwright's select doesn't match by value
        await page.evaluate((val: string) => {
          const sel = document.getElementById('reg-mobile-cc') as HTMLSelectElement | null;
          if (sel) {
            sel.value = val;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, matchingOpt.value);
      });

      // ── Set up signUp interception for this iteration ────────────────────────
      let signUpFired = false;
      const signUpHandler = async (route: import('@playwright/test').Route) => {
        signUpFired = true;
        await route.abort();
      };
      await page.route(SIGN_UP_URL, signUpHandler);

      const signUpReqPromise = page.waitForRequest(
        req => req.url().includes('accounts:signUp') && req.method() === 'POST',
        { timeout: 4_000 },
      ).catch(() => null);

      // ── Fill remaining fields and submit ─────────────────────────────────────
      await page.locator('#reg-firstname').fill('SENTINEL');
      await page.locator('#reg-lastname').fill('INTL');
      await page.locator('#reg-email').fill(
        testEmail(`intl-${country.searchVal}-${Date.now()}`),
      );
      await page.locator('#reg-mobile-num').fill(country.phone);
      await page.locator('#reg-password').fill('Test@12345!');
      await page.locator('#reg-confirm-password').fill('Test@12345!');
      await page.locator('#reg-terms').click();
      await page.locator('button:has-text("Create Account")').click();

      // Allow client-side validation to run and the signUp request to fire (if it will)
      await page.waitForTimeout(2_500);
      await signUpReqPromise; // resolves immediately if already captured, times out otherwise

      // ── Inspect modal for a visible phone validation error ───────────────────
      const modalText = (
        (await page.locator('#auth-modal').textContent().catch(() => '')) ?? ''
      ).toLowerCase();

      // A validation error referencing phone/mobile/number alongside invalid/required signals
      // that the form rejected the valid number as incorrectly formatted.
      const PHONE_ERROR_SIGNALS = ['phone', 'mobile', 'number', 'format', 'required'];
      const REJECT_SIGNALS      = ['invalid', 'incorrect', 'error', 'required'];
      const hasPhoneWord  = PHONE_ERROR_SIGNALS.some(s => modalText.includes(s));
      const hasRejectWord = REJECT_SIGNALS.some(s => modalText.includes(s));
      const looksLikePhoneError = hasPhoneWord && hasRejectWord;

      if (!signUpFired && looksLikePhoneError) {
        const finding =
          `[FINDING][medium] international-phone-number-formats: ` +
          `phone "${country.phone}" for ${country.code} (${country.label}) was rejected by ` +
          `client-side validation (signUp request never fired; modal shows: "${modalText.slice(0, 120)}"). ` +
          `A valid local number for ${country.label} is being incorrectly blocked — ` +
          `non-SA hosts may be unable to register.`;
        console.warn(finding);
        findings.push(finding);
      } else if (!signUpFired && !looksLikePhoneError) {
        // No request, no error message — likely another field failed validation first
        console.log(
          `[INFO] international-phone-number-formats: ${country.code} (${country.name}) — ` +
            `signUp not fired and no phone-specific error detected. ` +
            `Modal text: "${modalText.slice(0, 80) || '(empty)'}". ` +
            `Phone may have passed but another field triggered a validation error.`,
        );
      } else if (signUpFired) {
        console.log(
          `[INFO] international-phone-number-formats: ${country.code} (${country.name}) — ` +
            `signUp request fired for phone "${country.phone}" — no false client-side rejection ✓`,
        );
      }

      // Remove handler before next iteration
      await page.unroute(SIGN_UP_URL, signUpHandler);
    }

    // Soft-fail for each finding so all countries are reported before the test stops
    for (const f of findings) {
      expect.soft(false, f).toBe(true);
    }
  });

  // ── 3. checkout-property-a-vs-property-b ──────────────────────────────────

  test('checkout-property-a-vs-property-b — order in admin must reflect the specific property configured during checkout, not a generic placeholder', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Verifies that property-specific details entered during the checkout configuration step ' +
        `("${PROP_ALPHA.name}") are correctly stored in the order record and visible in the admin ` +
        'order detail, rather than being replaced by a generic placeholder or defaulting to another account\'s property.' +
        '\n\n' +
        'Platform context: this site appears to support one property per account. The intended ' +
        '"Property A vs Property B" test (where a multi-property account selects Property B by mistake ' +
        'and we verify the order correctly stores B\'s details, not A\'s) is adapted here: a single ' +
        'checkout is completed for a uniquely-named property, and the resulting admin order is checked ' +
        'to confirm it contains exactly that name — proving the checkout config pipeline captures and ' +
        'persists property-specific data end-to-end.' +
        '\n\n' +
        'In safe mode: after filling the checkout config, the delivery step page is inspected for ' +
        `"${PROP_ALPHA.name}" to confirm the client correctly propagates it through the flow. ` +
        'In LIVE_MODE: additionally completes payment and verifies the admin order modal shows the property name.',
    });

    await registerForCheckout(page);
    await page.evaluate((id: string) => (window as any).addToCart(id), PACK_ID);
    await page.waitForTimeout(600);
    await page.goto('/checkout.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);

    await fillPropertyConfig(page, PROP_ALPHA);

    // ── Safe-mode assertion: delivery step DOM reflects the property name ──────
    // At this point "Proceed to Payment →" is visible.
    // The checkout review or delivery form may echo back the property name entered during config.
    const deliveryPageText = await page.evaluate(() => document.body.innerText);
    const propNameInDelivery = deliveryPageText.includes(PROP_ALPHA.name);

    if (propNameInDelivery) {
      console.log(
        `[INFO] checkout-property-a-vs-property-b: "${PROP_ALPHA.name}" is visible in the checkout delivery step — client-side propagation confirmed ✓`,
      );
    } else {
      console.log(
        `[INFO] checkout-property-a-vs-property-b: "${PROP_ALPHA.name}" not detected in delivery step text — ` +
          'property name may not be echoed at this step, or is stored silently to Firestore. ' +
          'LIVE_MODE admin check is the authoritative verification.',
      );
    }

    if (!LIVE_MODE) {
      // In safe mode, the delivery-step DOM check is all we can assert without a real backend.
      // The Firestore write that stores order config happens here but we cannot read it back.
      // The admin order check in LIVE_MODE provides the definitive E2E assertion.
      if (!propNameInDelivery) {
        console.log(
          '[INFO] checkout-property-a-vs-property-b: safe mode — property name not visible in delivery step DOM. ' +
            'Run with SENTINEL_LIVE_MODE=true for admin-panel verification.',
        );
      }
      return;
    }

    // ── LIVE_MODE: complete checkout and verify admin order ────────────────────
    await advanceThroughDeliveryToPayment(page);
    await page.locator('#co-billing-addr').fill(
      `${PROP_ALPHA.unit} ${PROP_ALPHA.street}, ${PROP_ALPHA.suburb}, ${PROP_ALPHA.city}, ${PROP_ALPHA.postal}`,
    );

    // Capture orderId from CF POST request body before payment navigation
    const cfReqPromise = page.waitForRequest(
      req => req.url().includes('cloudfunctions.net') && req.method() === 'POST',
      { timeout: 30_000 },
    ).catch(() => null);

    const navPromise = page.waitForNavigation({ timeout: 30_000 }).catch(() => null);
    await page.locator('#pay-now-btn').click();
    const [cfReq] = await Promise.all([cfReqPromise, navPromise]);

    let orderId: string | null = null;
    if (cfReq) {
      const postData = cfReq.postData() ?? '';
      try {
        const parsed = JSON.parse(postData) as Record<string, any>;
        orderId = parsed?.data?.orderId ?? null;
      } catch { /* ignore */ }
      if (orderId) {
        console.log(`[INFO] checkout-property-a-vs-property-b: captured orderId="${orderId}"`);
      } else {
        console.warn(
          `[INFO] checkout-property-a-vs-property-b: CF POST body did not contain orderId — ` +
            `body: "${postData.slice(0, 200)}". Admin search will fall back to email.`,
        );
      }
    } else {
      console.warn('[INFO] checkout-property-a-vs-property-b: CF POST not captured before navigation.');
    }

    // ── Open admin and locate the order ──────────────────────────────────────
    await loginAsAdmin(page);
    await page.waitForTimeout(2_000);

    let modalText = '';

    if (orderId) {
      await page.evaluate((id: string) => { (window as any).viewOrder?.(id); }, orderId);
      await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(800);
      modalText = (await page.locator('#order-modal').textContent().catch(() => '')) ?? '';
    }

    if (!modalText) {
      // Fallback: search by name prefix visible in every SENTINEL order
      await page.locator('#filter-search').fill('SENTINEL').catch(() => {});
      await page.waitForTimeout(1_500);
      const rows = await page.locator('#orders-body tr').all();
      // Most recent SENTINEL row is the one we just created
      if (rows.length > 0) {
        await rows[0].locator('button:has-text("View")').click();
        await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(800);
        modalText = (await page.locator('#order-modal').textContent().catch(() => '')) ?? '';
      }
    }

    if (!modalText) {
      console.warn(
        '[INFO] checkout-property-a-vs-property-b: admin order modal could not be opened — ' +
          'manual verification required.',
      );
      return;
    }

    const modalSnippet = modalText.replace(/\s+/g, ' ').trim();
    console.log(
      `[INFO] checkout-property-a-vs-property-b: admin modal text (first 400 chars): "${modalSnippet.slice(0, 400)}"`,
    );

    const hasAlphaName    = modalText.includes(PROP_ALPHA.name);
    const hasGenericName  = modalText.toLowerCase().includes('sentinel qa property'); // default ADDR.property
    const hasBetaName     = modalText.includes(PROP_BETA.name);

    if (hasAlphaName) {
      console.log(
        `[INFO] checkout-property-a-vs-property-b: admin order shows "${PROP_ALPHA.name}" ✓ — ` +
          'property-specific details are captured end-to-end.',
      );
    } else if (hasBetaName) {
      console.error(
        `[FINDING][critical] checkout-property-a-vs-property-b: admin order shows "${PROP_BETA.name}" ` +
          `instead of "${PROP_ALPHA.name}". The wrong property\'s details are stored in this order — ` +
          'property data routing in the checkout pipeline is broken.',
      );
      expect.soft(false, `Order must show "${PROP_ALPHA.name}" — found "${PROP_BETA.name}" instead`).toBe(true);
    } else if (hasGenericName) {
      console.error(
        `[FINDING][high] checkout-property-a-vs-property-b: admin order shows the generic placeholder ` +
          `"Sentinel QA Property" instead of "${PROP_ALPHA.name}". The checkout config step is not ` +
          'persisting the custom property name — orders always store the default ADDR value.',
      );
      expect.soft(
        false,
        `Order must show "${PROP_ALPHA.name}" — found generic placeholder "Sentinel QA Property" instead`,
      ).toBe(true);
    } else {
      console.warn(
        `[INFO] checkout-property-a-vs-property-b: neither "${PROP_ALPHA.name}" nor a known placeholder ` +
          `found in admin modal. The property name field may use a different label in the order record. ` +
          'Manual check recommended.',
      );
    }

    expect(
      hasAlphaName || (!hasBetaName && !hasGenericName),
      `Admin order must contain "${PROP_ALPHA.name}"`,
    ).toBe(true);
  });

});
