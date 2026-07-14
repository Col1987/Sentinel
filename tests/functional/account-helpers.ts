import { type Page } from '@playwright/test';
import { getLatestVerificationEmail } from '../../src/utils/gmail';
import { ADDR, registerForCheckout } from './checkout-helpers';

// Shared by tests/functional/my-account-live.spec.ts and any other file needing a
// verified account or a saved property (e.g. wifi-multi-property-live.spec.ts) — kept in
// a plain module rather than a .spec.ts file, since importing from a .spec.ts file would
// re-execute its top-level test.describe() and double-register those tests.

// Registers a fresh account and verifies its email via the proven Gmail-polling pattern —
// account.html will not render its authenticated tabs for an unverified account.
export async function registerVerifiedAccount(page: Page): Promise<string> {
  const sentAfter = new Date();
  const checkoutEmail = await registerForCheckout(page);
  const verificationLink = await getLatestVerificationEmail(sentAfter);
  if (!verificationLink) {
    throw new Error('registerVerifiedAccount: verification email did not arrive within 30s — cannot proceed with an unverified account.');
  }
  await page.goto(verificationLink, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  return checkoutEmail;
}

// Creates one saved property via My Properties' "+ Add Property" form, under whatever
// account is currently authenticated on this page. Assumes the My Properties tab is
// already active (caller must click #tab-btn-properties first) and the "+ Add Property"
// button is visible. Fills the minimum set of fields saveProperty() requires — discovered
// live, not documented anywhere: name, address, Host Contact (collapsed accordion), at
// least one restaurant and one activity (manual-entry fallback — this address is known to
// return zero real nearby results), and Business/Brand name (also a collapsed accordion).
export async function createSavedProperty(
  page: Page,
  propName: string,
  opts: { restaurantName?: string; activityName?: string } = {},
): Promise<void> {
  const restaurantName = opts.restaurantName ?? 'Sentinel Test Restaurant';
  const activityName   = opts.activityName   ?? 'Sentinel Test Activity';
  await page.locator('button:has-text("+ Add Property")').click();
  await page.locator('#property-form-wrap').waitFor({ state: 'visible', timeout: 5_000 });

  await page.locator('#pf-name').fill(propName);
  await page.locator('#pf-address').fill(`${ADDR.unit} ${ADDR.street}, ${ADDR.suburb}, ${ADDR.city}`);
  // Toggle panels like this one work for the first form instance in a session but can
  // silently fail to open for a later one (see CLAUDE.md "Toggle/panel controls that
  // don't respond for later form instances") — createSavedProperty is called twice in a
  // row by wifi-multi-property-live.spec.ts, hitting exactly that case on the second call.
  // Detect the failure and fall back to setting the hidden inputs directly via
  // page.evaluate(), the same proven pattern fillConfigStep uses for #cfg-addr-*.
  const streetAlreadyVisible = await page.locator('#pf-addr-street').isVisible({ timeout: 500 }).catch(() => false);
  let addrPanelOpen = streetAlreadyVisible;
  if (!streetAlreadyVisible) {
    await page.locator('#pf-addr-breakdown-btn').click();
    addrPanelOpen = await page.locator('#pf-addr-street')
      .waitFor({ state: 'visible', timeout: 6_000 })
      .then(() => true)
      .catch(() => false);
  }
  if (addrPanelOpen) {
    await page.locator('#pf-addr-unit').fill(ADDR.unit);
    await page.locator('#pf-addr-street').fill(ADDR.street);
    await page.locator('#pf-addr-suburb').fill(ADDR.suburb);
    await page.locator('#pf-addr-city').fill(ADDR.city);
    await page.locator('#pf-addr-province').fill(ADDR.province);
    await page.locator('#pf-addr-postal').fill(ADDR.postal);
  } else {
    await page.evaluate(
      ({ unit, street, suburb, city, province, postal }: Record<string, string>) => {
        const setVal = (id: string, val: string) => {
          const el = document.getElementById(id) as HTMLInputElement | null;
          if (!el) return;
          el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setVal('pf-addr-unit',     unit);
        setVal('pf-addr-street',   street);
        setVal('pf-addr-suburb',   suburb);
        setVal('pf-addr-city',     city);
        setVal('pf-addr-province', province);
        setVal('pf-addr-postal',   postal);
      },
      { unit: ADDR.unit, street: ADDR.street, suburb: ADDR.suburb, city: ADDR.city, province: ADDR.province, postal: ADDR.postal },
    );
  }
  await page.locator('#pf-addr-postal').fill(ADDR.postal).catch(() => {});

  // Host Contact lives inside a collapsed accordion section (#acc-host) — only the
  // Property Details section (#acc-basic) is open by default. Expand it before filling.
  const hostFieldVisible = await page.locator('#pf-host-name').isVisible({ timeout: 500 }).catch(() => false);
  if (!hostFieldVisible) {
    await page.locator('#acc-host .acc-btn').click();
    await page.locator('#pf-host-name').waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {});
  }
  await page.locator('#pf-host-name').fill('SENTINEL HOST');
  await page.locator('#pf-host-phone-num').fill('821234567');

  // pfUpdateSaveBtn() also requires at least one restaurant AND one activity before Save
  // enables (this exact test address is already known, from discovery, to return zero
  // real nearby results). Use the manual-entry fallback directly rather than depending on
  // a live external geocoding search (OpenStreetMap/Overpass) in a test.
  await page.locator('#acc-restaurants .acc-btn').click();
  await page.evaluate(() => (window as any).pfToggleManualPanel('rest', true));
  await page.locator('#pf-new-rest-name').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#pf-new-rest-name').fill(restaurantName);
  await page.locator('button:has-text("Add Restaurant")').click();

  await page.locator('#acc-activities .acc-btn').click();
  await page.evaluate(() => (window as any).pfToggleManualPanel('act', true));
  await page.locator('#pf-new-act-name').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#pf-new-act-name').fill(activityName);
  await page.locator('button:has-text("Add Activity")').click();

  // saveProperty() also requires a Business / Brand name — lives inside the collapsed
  // Brand accordion section (#acc-brand), same pattern as Host Contact above.
  const brandFieldVisible = await page.locator('#pf-brand').isVisible({ timeout: 500 }).catch(() => false);
  if (!brandFieldVisible) {
    await page.locator('#acc-brand .acc-btn').click();
    await page.locator('#pf-brand').waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {});
  }
  await page.locator('#pf-brand').fill('Sentinel Test Brand');

  await page.locator('#pf-save-btn').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#pf-save-btn:not([disabled])').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  await page.locator('#pf-save-btn').click();
  await page.waitForTimeout(2_000);
}
