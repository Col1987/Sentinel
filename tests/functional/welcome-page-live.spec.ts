import { test, expect, type Page } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';
import { PACK_LABEL, ADDR, GUEST, runCheckoutFlow } from './checkout-helpers';

// Collection address must never be exposed to guests — reuse pattern from
// tests/security/welcome-page.spec.ts
const COLLECTION_ADDRESS = '56 Robberg Road';

// Wi-Fi credentials used in the wifi-configured test
const WIFI_SSID = 'SentinelTestNet';
const WIFI_PW   = 'TestWifi123!';

// ── Admin helpers (minimal subset needed for this test) ───────────────────────

async function openOrderModal(page: Page, orderId: string): Promise<void> {
  await page.evaluate((id: string) => {
    if ((window as any).viewOrder) (window as any).viewOrder(id);
  }, orderId);
  await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 });
  await page.waitForTimeout(800);
}

async function closeOrderModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('order-modal')?.classList.remove('active');
  });
  await page.waitForTimeout(500);
}

async function getModalOrderId(page: Page): Promise<string | null> {
  const inputId = await page
    .locator('#order-modal input[id^="waybill-input-"]')
    .getAttribute('id')
    .catch(() => null);
  return inputId ? inputId.replace('waybill-input-', '') : null;
}

// Locates the test order in the admin dashboard and opens its detail modal.
// Returns the orderId read from the modal DOM (which is always authoritative),
// or null if the order cannot be found within the timeout.
async function findAndOpenOrderInAdmin(
  page: Page,
  checkoutEmail: string,
  cfOrderId: string | null,
): Promise<string | null> {
  await page.waitForTimeout(2_000);

  if (cfOrderId) {
    await openOrderModal(page, cfOrderId);
    const modalOrderId = await getModalOrderId(page);
    if (modalOrderId) return modalOrderId;
    await closeOrderModal(page);
  }

  // Fallback: search by customer name, scan rows for the checkout email
  await page.locator('#filter-search').fill('SENTINEL CHECKOUT');
  await page.waitForTimeout(1_500);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rows = await page.locator('#orders-body tr').all();
    for (const row of rows) {
      const rowText = await row.textContent().catch(() => '');
      if (rowText?.includes(checkoutEmail)) {
        await row.locator('button:has-text("View")').click();
        await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 });
        await page.waitForTimeout(800);
        return getModalOrderId(page);
      }
    }
    await page.locator('#orders-refresh-btn').click();
    await page.waitForTimeout(2_000);
  }

  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Welcome page with real order data (LIVE_MODE only)', { tag: ['@functional'] }, () => {

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires real backend — set SENTINEL_LIVE_MODE=true to run');
  });

  test('welcome-page-shows-real-order-data — guest welcome page displays the correct order details', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Creates a fresh order via the sandbox checkout flow, logs in as admin, opens the order ' +
        'detail modal, and navigates to the Guest Welcome Page linked from the modal. ' +
        'Verifies the page loads cleanly (no JS exceptions), the correct guest name and brand/property ' +
        'name are displayed, the pack name is present in the page source, the collection address ' +
        '(56 Robberg Road) is not exposed anywhere in the page, and no console errors fire during load. ' +
        'Any data mismatch between what was entered at checkout and what the page displays is a ' +
        'high-severity finding — guests would see incorrect or missing personalisation.',
    });

    // ── 1. Create order ───────────────────────────────────────────────────────
    const { checkoutEmail, orderId: cfOrderId } = await runCheckoutFlow(page);
    console.log(`[INFO] welcome-page-shows-real-order-data: checkout complete for ${checkoutEmail}`);

    // ── 2. Log in as admin and open the order modal ───────────────────────────
    await loginAsAdmin(page);

    const orderId = await findAndOpenOrderInAdmin(page, checkoutEmail, cfOrderId);
    if (!orderId) {
      console.error(
        `[FINDING][critical] welcome-page-shows-real-order-data: order for ${checkoutEmail} ` +
          'not found in admin dashboard within 30 s of checkout.',
      );
      return;
    }
    console.log(`[INFO] welcome-page-shows-real-order-data: orderId=${orderId}`);

    // ── 3. Extract the welcome page URL from the modal ────────────────────────
    // Discovery confirmed: #order-modal a with text "→ View Guest Welcome Page"
    // href format: https://juelhaus.co.za/welcome/{uuid}  (Firebase Hosting domain)
    const welcomeHref = await page
      .locator('#order-modal a')
      .filter({ hasText: 'Welcome Page' })
      .getAttribute('href')
      .catch(() => null);

    if (!welcomeHref) {
      console.error(
        '[FINDING][high] welcome-page-shows-real-order-data: "View Guest Welcome Page" link not ' +
          'found in the order detail modal — admin may have no way to review what the guest sees.',
      );
      return;
    }
    console.log(`[INFO] welcome-page URL: ${welcomeHref}`);

    // ── 4. Set up error listeners before navigation ───────────────────────────
    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // ── 5. Navigate to welcome page ───────────────────────────────────────────
    // Use absolute URL — the welcome page is on juelhaus.co.za (Firebase Hosting),
    // not www.juelhaus.co.za (the primary Playwright baseURL).
    const response = await page.goto(welcomeHref, { waitUntil: 'load' }).catch(() => null);
    await page.waitForTimeout(4_000); // allow async Firestore data fetch

    // ── 6. HTTP status ────────────────────────────────────────────────────────
    const httpStatus = response?.status() ?? 0;
    if (httpStatus >= 400) {
      console.error(
        `[FINDING][high] welcome-page-shows-real-order-data: welcome page returned HTTP ${httpStatus}`,
      );
    } else {
      console.log(`[INFO] welcome page HTTP ${httpStatus} ✓`);
    }

    // ── 7. Gather page content ────────────────────────────────────────────────
    const visibleText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const rawHtml = await page.content().catch(() => '');

    // ── 8. Guest name ─────────────────────────────────────────────────────────
    // Discovery confirmed: "Welcome, SENTINEL TEST GUEST" in visible text
    if (!visibleText.includes(GUEST)) {
      console.error(
        `[FINDING][high] welcome-page-shows-real-order-data: guest name "${GUEST}" not found in ` +
          'visible page text — the welcome page is not displaying the correct guest personalisation.',
      );
    } else {
      console.log(`[INFO] guest name "${GUEST}" visible ✓`);
    }

    // ── 9. Brand / property name ──────────────────────────────────────────────
    // Discovery confirmed: the branding sub-step brand name ("Sentinel QA") is shown in the
    // page header, not the property name from the delivery step ("Sentinel QA Property").
    // Checking for "Sentinel QA" covers both.
    if (!visibleText.includes('Sentinel QA')) {
      console.error(
        `[FINDING][high] welcome-page-shows-real-order-data: brand/property name "Sentinel QA" ` +
          'not found in visible page text — the welcome page may not be loading the correct branding.',
      );
    } else {
      console.log(`[INFO] brand/property "Sentinel QA" visible ✓`);
    }

    // ── 10. Pack name ─────────────────────────────────────────────────────────
    // The welcome page is guest-facing so the pack name may appear in the source
    // without being prominent in visible text. Check rawHtml as a looser fallback.
    if (!rawHtml.includes(PACK_LABEL)) {
      console.warn(
        `[FINDING][medium] welcome-page-shows-real-order-data: pack name "${PACK_LABEL}" not found ` +
          'anywhere in the welcome page source — the guest has no way to identify which welcome ' +
          'pack they ordered.',
      );
    } else {
      console.log(`[INFO] pack name "${PACK_LABEL}" found in page source ✓`);
    }

    // ── 11. Wi-Fi box ─────────────────────────────────────────────────────────
    // Wi-Fi was skipped at checkout — the .wifi-box div should NOT appear.
    // Source review confirmed: the welcome page has no QR codes. The "Wi-Fi QR"
    // and "Welcome QR" shown in the admin order modal are print-only artifacts;
    // they are not rendered on this guest-facing page. Wi-Fi credentials are
    // displayed as plain text (SSID + password) inside .wifi-box when configured.
    const wifiBoxVisible = await page.locator('.wifi-box').isVisible().catch(() => false);
    if (wifiBoxVisible) {
      console.warn(
        '[FINDING][medium] welcome-page-shows-real-order-data: .wifi-box is visible on the welcome ' +
          'page even though Wi-Fi was skipped at checkout — stale or incorrect data may be rendering.',
      );
    } else {
      console.log('[INFO] no Wi-Fi box rendered (Wi-Fi was skipped at checkout) ✓');
    }

    // ── 12. Collection address must NOT be exposed ────────────────────────────
    // Hard assertion — exposing the collection address to guests is a data-leak defect.
    const addrInVisible = visibleText.includes(COLLECTION_ADDRESS);
    const addrInHtml    = rawHtml.includes(COLLECTION_ADDRESS);
    if (addrInVisible || addrInHtml) {
      console.error(
        `[FINDING][critical] welcome-page-shows-real-order-data: collection address ` +
          `"${COLLECTION_ADDRESS}" is present on the guest welcome page (visible=${addrInVisible}, ` +
          `inHtml=${addrInHtml}) — this leaks the internal dispatch address to end customers.`,
      );
    }
    expect(addrInVisible, `"${COLLECTION_ADDRESS}" must not appear in visible text`).toBe(false);
    expect(addrInHtml,    `"${COLLECTION_ADDRESS}" must not appear in raw HTML`).toBe(false);

    // ── 13. Console errors ────────────────────────────────────────────────────
    if (consoleErrors.length > 0) {
      console.warn(
        `[FINDING][medium] welcome-page-shows-real-order-data: ${consoleErrors.length} browser ` +
          `console error(s) fired during page load: ${consoleErrors.join(' | ')}`,
      );
    } else {
      console.log('[INFO] no console errors ✓');
    }

    // ── 14. Unhandled JS exceptions ───────────────────────────────────────────
    // Hard assertion — unhandled exceptions indicate broken page scripts.
    if (pageErrors.length > 0) {
      console.error(
        `[FINDING][high] welcome-page-shows-real-order-data: ${pageErrors.length} unhandled JS ` +
          `exception(s): ${pageErrors.join(' | ')}`,
      );
    } else {
      console.log('[INFO] no unhandled JS exceptions ✓');
    }
    expect(pageErrors, 'welcome page must not throw unhandled JS exceptions').toHaveLength(0);
  });

  // ── Wi-Fi credentials appear as text when configured ─────────────────────────

  test('checkout-with-wifi-configured — welcome page shows Wi-Fi SSID and password when Wi-Fi was set up at checkout', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Creates a fresh order via the sandbox checkout, this time filling in Wi-Fi network ' +
        'name and password instead of skipping the Wi-Fi step. Logs in as admin, navigates to ' +
        'the Guest Welcome Page, and verifies: the .wifi-box section is present, the correct ' +
        'SSID is visible as text, and the correct password is visible as text. ' +
        'Source review confirmed the welcome page has no QR codes — Wi-Fi credentials are ' +
        'rendered as plain text inside .wifi-box, not as a scannable QR code. ' +
        'An absent .wifi-box when Wi-Fi was configured is a high-severity finding.',
    });

    // ── 1. Create order with Wi-Fi configured ─────────────────────────────────
    const { checkoutEmail, orderId: cfOrderId } = await runCheckoutFlow(page, {
      wifiConfig: { ssid: WIFI_SSID, password: WIFI_PW },
    });
    console.log(`[INFO] checkout-with-wifi-configured: checkout complete for ${checkoutEmail}`);

    // ── 2. Log in as admin and open the order modal ───────────────────────────
    await loginAsAdmin(page);

    const orderId = await findAndOpenOrderInAdmin(page, checkoutEmail, cfOrderId);
    if (!orderId) {
      console.error(
        `[FINDING][critical] checkout-with-wifi-configured: order for ${checkoutEmail} ` +
          'not found in admin dashboard within 30 s of checkout.',
      );
      return;
    }
    console.log(`[INFO] checkout-with-wifi-configured: orderId=${orderId}`);

    // ── 3. Extract welcome page URL ───────────────────────────────────────────
    const welcomeHref = await page
      .locator('#order-modal a')
      .filter({ hasText: 'Welcome Page' })
      .getAttribute('href')
      .catch(() => null);

    if (!welcomeHref) {
      console.error(
        '[FINDING][high] checkout-with-wifi-configured: "View Guest Welcome Page" link not ' +
          'found in the order detail modal.',
      );
      return;
    }
    console.log(`[INFO] welcome-page URL: ${welcomeHref}`);

    // ── 4. Navigate to welcome page ───────────────────────────────────────────
    const wifiPageErrors: string[] = [];
    page.on('pageerror', err => wifiPageErrors.push(err.message));

    await page.goto(welcomeHref, { waitUntil: 'load' });
    await page.waitForTimeout(4_000);

    // ── 5. Wi-Fi box present ──────────────────────────────────────────────────
    const wifiBox = page.locator('.wifi-box');
    const wifiBoxVisible = await wifiBox.isVisible().catch(() => false);

    if (!wifiBoxVisible) {
      console.error(
        `[FINDING][high] checkout-with-wifi-configured: .wifi-box not visible on the welcome page ` +
          `despite Wi-Fi being configured at checkout (SSID: "${WIFI_SSID}"). ` +
          'Guests have no way to connect to Wi-Fi.',
      );
      return;
    }
    console.log('[INFO] .wifi-box is visible ✓');

    const wifiText = ((await wifiBox.textContent().catch(() => '')) ?? '').trim();

    // ── 6. SSID visible ───────────────────────────────────────────────────────
    if (!wifiText.includes(WIFI_SSID)) {
      console.error(
        `[FINDING][high] checkout-with-wifi-configured: SSID "${WIFI_SSID}" not found in .wifi-box ` +
          `text ("${wifiText.slice(0, 120)}") — wrong or missing network name shown to guest.`,
      );
    } else {
      console.log(`[INFO] SSID "${WIFI_SSID}" visible in Wi-Fi box ✓`);
    }

    // ── 7. Password visible ───────────────────────────────────────────────────
    if (!wifiText.includes(WIFI_PW)) {
      console.error(
        `[FINDING][high] checkout-with-wifi-configured: password "${WIFI_PW}" not found in .wifi-box ` +
          `text — guest cannot connect to Wi-Fi without the password.`,
      );
    } else {
      console.log(`[INFO] Wi-Fi password visible in Wi-Fi box ✓`);
    }

    // ── 8. No JS exceptions ───────────────────────────────────────────────────
    expect(wifiPageErrors, 'welcome page must not throw unhandled JS exceptions').toHaveLength(0);
  });

});
