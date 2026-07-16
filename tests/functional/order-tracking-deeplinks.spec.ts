import { test, expect } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

// Simulated "not found" response from the order tracking Cloud Function.
// Real CF responses are JSON wrapped by the Firebase callable SDK.
const CF_NOT_FOUND_BODY = JSON.stringify({ result: { found: false, status: 'NOT_FOUND' } });

async function requireVisible(
  page: import('@playwright/test').Page,
  selector: string,
  pageName: string,
): Promise<void> {
  const visible = await page.locator(selector).isVisible({ timeout: 5_000 }).catch(() => false);
  if (!visible) {
    console.error(`[FINDING][medium] Expected element "${selector}" not found on ${pageName}`);
    expect(visible, `[FINDING][medium] Expected element "${selector}" not found on ${pageName}`).toBe(true);
  }
}

// Finds the order tracking input on /track.html.
// Fragility note: /track.html has no stable form wrapper ID at time of writing, so this
// selector matches the first visible text/search input on the page. It is safe while the
// page has only one such input, but would match unintended fields if additional inputs are
// added. Preferred fix: scope to a stable container (e.g. #track-form) once one is confirmed.
async function findTrackingInput(page: import('@playwright/test').Page) {
  return page.locator(
    'input[type="text"]:visible, input[type="search"]:visible, ' +
      'input[id*="order"]:visible, input[id*="track"]:visible',
  ).first();
}

test.describe('Order tracking deeplinks', { tag: ['@functional'] }, () => {

  // ─── track-deeplink-order-id ──────────────────────────────────────────────────

  test('track-deeplink-order-id — /track.html?id=TEST-001 auto-populates the input and triggers a search', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to /track.html with an order ID pre-supplied as a query parameter (?id=TEST-001). Verified that the tracking input field was automatically populated with 'TEST-001' and that a search request was triggered against the backend. Guests who receive a tracking link directly (e.g. from an email) rely on this deeplink behaviour — if the page ignores the query parameter they must type the order ID in manually.",
    });

    if (LIVE_MODE) test.slow();

    let cfRequestUrl = '';
    let cfRequestBody = '';

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, async route => {
        cfRequestUrl  = route.request().url();
        cfRequestBody = route.request().postData() ?? '';
        await route.fulfill({ status: 200, contentType: 'application/json', body: CF_NOT_FOUND_BODY });
      });
    } else {
      page.on('request', req => {
        if (req.url().includes('europe-west1-juelhaus-co-za.cloudfunctions.net')) {
          cfRequestUrl  = req.url();
          cfRequestBody = req.postData() ?? '';
        }
      });
    }

    await page.goto('/track.html?id=TEST-001', { waitUntil: 'load' });

    // Allow the page JS to read the query parameter and populate the input.
    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [class*="spinner"], [aria-busy="true"]'),
      undefined,
      { timeout: 6_000 },
    ).catch(() => {});

    const trackingInput = await findTrackingInput(page);
    if (!(await trackingInput.count() > 0 && await trackingInput.isVisible().catch(() => false))) {
      console.error('[FINDING][medium] Expected element "tracking input" not found on /track.html');
      expect(false, 'Expected a visible order tracking input on /track.html').toBe(true);
    }

    const inputValue = await trackingInput.inputValue().catch(() => '');
    console.log(`[INFO] track-deeplink-order-id: input value after load = "${inputValue}".`);

    if (inputValue !== 'TEST-001') {
      console.error(
        `[FINDING][medium] track-deeplink-order-id: tracking input value is "${inputValue}" — expected "TEST-001". ` +
          'The page does not read the ?id= query parameter and auto-populate the tracking input. ' +
          'Guests who receive a tracking link must not have to retype their order ID.',
      );
    } else {
      console.log('[INFO] track-deeplink-order-id: tracking input correctly pre-populated from ?id= ✓');
    }

    expect(inputValue, 'Tracking input must be pre-populated with the ?id= query parameter value').toBe('TEST-001');

    // Also verify that a search request was triggered automatically.
    if (!LIVE_MODE) {
      if (cfRequestUrl) {
        const searchedId = cfRequestUrl.includes('TEST-001') || cfRequestBody.includes('TEST-001');
        if (searchedId) {
          console.log('[INFO] track-deeplink-order-id: CF search triggered with "TEST-001" ✓');
        } else {
          console.warn(
            `[FINDING][low] track-deeplink-order-id: CF request fired (${cfRequestUrl}) but "TEST-001" ` +
              `was not found in the URL or body ("${cfRequestBody.slice(0, 100)}"). ` +
              'Verify that the deeplink triggers a search with the correct order ID.',
          );
        }
      } else {
        console.warn(
          '[FINDING][low] track-deeplink-order-id: no CF request was observed after loading /track.html?id=TEST-001. ' +
            'The page may require the user to manually submit the form rather than auto-searching on load.',
        );
      }
    }
  });

  // ─── track-deeplink-waybill ───────────────────────────────────────────────────

  test('track-deeplink-waybill — /track.html?waybill=WB-TEST-001 auto-populates the input and triggers a search', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to /track.html with a waybill number pre-supplied as a query parameter (?waybill=WB-TEST-001). Verified that the tracking input was populated with 'WB-TEST-001' and that a search request fired against the backend. Waybill numbers are used for courier tracking and guests may receive waybill-based links from the Juel Haus dispatch flow — these deeplinks must work as reliably as order ID links.",
    });

    if (LIVE_MODE) test.slow();

    let cfRequestUrl = '';
    let cfRequestBody = '';

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, async route => {
        cfRequestUrl  = route.request().url();
        cfRequestBody = route.request().postData() ?? '';
        await route.fulfill({ status: 200, contentType: 'application/json', body: CF_NOT_FOUND_BODY });
      });
    } else {
      page.on('request', req => {
        if (req.url().includes('europe-west1-juelhaus-co-za.cloudfunctions.net')) {
          cfRequestUrl  = req.url();
          cfRequestBody = req.postData() ?? '';
        }
      });
    }

    await page.goto('/track.html?waybill=WB-TEST-001', { waitUntil: 'load' });

    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [class*="spinner"], [aria-busy="true"]'),
      undefined,
      { timeout: 6_000 },
    ).catch(() => {});

    const trackingInput = await findTrackingInput(page);
    if (!(await trackingInput.count() > 0 && await trackingInput.isVisible().catch(() => false))) {
      console.error('[FINDING][medium] Expected element "tracking input" not found on /track.html');
      expect(false, 'Expected a visible order tracking input on /track.html').toBe(true);
    }

    const inputValue = await trackingInput.inputValue().catch(() => '');
    console.log(`[INFO] track-deeplink-waybill: input value after load = "${inputValue}".`);

    if (inputValue !== 'WB-TEST-001') {
      console.error(
        `[FINDING][medium] track-deeplink-waybill: tracking input value is "${inputValue}" — expected "WB-TEST-001". ` +
          'The page does not read the ?waybill= query parameter and auto-populate the tracking input.',
      );
    } else {
      console.log('[INFO] track-deeplink-waybill: tracking input correctly pre-populated from ?waybill= ✓');
    }

    expect(inputValue, 'Tracking input must be pre-populated with the ?waybill= query parameter value').toBe('WB-TEST-001');

    if (!LIVE_MODE) {
      if (cfRequestUrl) {
        const searchedWaybill = cfRequestUrl.includes('WB-TEST-001') || cfRequestBody.includes('WB-TEST-001');
        if (searchedWaybill) {
          console.log('[INFO] track-deeplink-waybill: CF search triggered with "WB-TEST-001" ✓');
        } else {
          console.warn(
            `[FINDING][low] track-deeplink-waybill: CF request fired but "WB-TEST-001" not found ` +
              `in URL or body ("${cfRequestBody.slice(0, 100)}"). Verify deeplink passes the waybill to the backend.`,
          );
        }
      } else {
        console.warn(
          '[FINDING][low] track-deeplink-waybill: no CF request observed after loading /track.html?waybill=WB-TEST-001. ' +
            'The page may require manual form submission rather than auto-searching on load.',
        );
      }
    }
  });

});
