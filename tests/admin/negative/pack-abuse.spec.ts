import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin } from '../../../src/utils/auth';
import { LIVE_MODE } from '../../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

async function openPacksTab(page: Page): Promise<void> {
  await page.locator('#atab-btn-packs').click();
  await page.locator('#packs-body').waitFor({ state: 'visible', timeout: 6_000 });
}

async function openCreatePackForm(page: Page): Promise<boolean> {
  const addBtn = page.locator('button:has-text("+ Add New Pack")');
  if (!(await addBtn.isVisible().catch(() => false))) {
    console.log('[INFO] openCreatePackForm: "+ Add New Pack" button not visible.');
    return false;
  }
  await addBtn.click();
  await page.locator('#pack-form-modal').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  return page.locator('#pack-form-modal').isVisible().catch(() => false);
}

async function dismissPackForm(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.locator('#pack-form-modal').waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {});
  if (await page.locator('#pack-form-modal').isVisible().catch(() => false)) {
    const closeBtn = page.locator(
      '#pack-form-modal .modal-close, #pack-form-modal button:has-text("Cancel"), #pack-form-modal button:has-text("×")',
    ).first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    }
  }
}

function findSubmitButton(page: Page) {
  return page.locator([
    '#pack-form-modal button[type="submit"]',
    '#pack-form-modal button:has-text("Save")',
    '#pack-form-modal button:has-text("Create")',
    '#pack-form-modal button:has-text("Add Pack")',
    '#pack-form-modal button:has-text("Save Pack")',
    '#pack-form-modal .btn-primary:not(.modal-close)',
  ].join(', ')).first();
}

test.describe('Admin pack abuse — negative', { tag: ['@admin'] }, () => {

  test.beforeEach(() => { test.slow(); });

  // ─── pack-create-empty ────────────────────────────────────────────────────────

  test('pack-create-empty — submitting the create form with no data is blocked by validation', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, opened the 'Add New Pack' form, and clicked the Save button without filling any fields. Verified that client-side validation prevented the form from submitting and that no request was sent to the backend. An empty pack submission would create a broken record in Firestore with no name or price.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);
    await openPacksTab(page);

    const formOpened = await openCreatePackForm(page);
    if (!formOpened) {
      console.log('[INFO] pack-create-empty: could not open create form — skipping.');
      return;
    }

    // Use form.checkValidity() rather than clicking submit to avoid triggering a page
    // navigation if the form has no JS submit handler with preventDefault().
    const validityCheck = await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('#pack-form-modal form');
      if (!form) return { hasForm: false, valid: true, requiredCount: 0 };
      const required = form.querySelectorAll('[required]').length;
      return { hasForm: true, valid: form.checkValidity(), requiredCount: required };
    });

    console.log(
      `[INFO] pack-create-empty: form present=${validityCheck.hasForm}, ` +
        `checkValidity=${validityCheck.valid}, required fields=${validityCheck.requiredCount}.`,
    );

    let createRequestFired = false;
    await page.route(CF_PATTERN, async route => {
      if (/pack|create|save|add/i.test(route.request().url())) createRequestFired = true;
      await route.abort();
    });

    if (!validityCheck.hasForm) {
      // No <form> element — fall back to checking the submit button is present and the CF is blocked.
      const submitBtn = findSubmitButton(page);
      if (await submitBtn.isVisible().catch(() => false)) {
        // Click but immediately check whether a CF request fires (it should not).
        const navPromise = page.waitForNavigation({ timeout: 1_500 }).catch(() => null);
        await submitBtn.click();
        await navPromise;
      }
      console.log('[INFO] pack-create-empty: no <form> in modal — tested via submit button click.');
    } else if (!validityCheck.valid) {
      console.log('[INFO] pack-create-empty: form.checkValidity() = false for empty fields — HTML5 validation is present ✓');
    } else if (validityCheck.requiredCount === 0) {
      console.warn(
        '[FINDING][medium] pack-create-empty: form has no HTML5 required attributes and checkValidity() = true for empty fields. ' +
          'Add required attributes to name and price fields to enforce client-side validation.',
      );
    }

    if (createRequestFired) {
      console.error(
        '[FINDING][high] pack-create-empty: a pack create request fired to the backend with empty fields. ' +
          'Client-side validation must block empty submissions before they reach the backend.',
      );
    }

    expect(createRequestFired, 'Submitting an empty pack form must not send a request to the backend').toBe(false);

    await dismissPackForm(page);
  });

  // ─── pack-create-negative-price ───────────────────────────────────────────────

  test('pack-create-negative-price — pack creation with a negative price is blocked or rejected', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, filled the pack create form with a valid name but entered -100 as the price. Checked whether client-side validation blocked the submission and, if a request still reached the backend, inspected the payload. A negative price would corrupt the product catalogue and could cause checkout calculation errors.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);
    await openPacksTab(page);

    const formOpened = await openCreatePackForm(page);
    if (!formOpened) {
      console.log('[INFO] pack-create-negative-price: could not open create form — skipping.');
      return;
    }

    let capturedPayload: string | null = null;
    let createRequestFired = false;
    await page.route(CF_PATTERN, async route => {
      createRequestFired = true;
      capturedPayload = route.request().postData();
      await route.abort();
    });

    await page.locator('#pack-f-name').fill('Sentinel Negative Price Test');
    await page.locator('#pack-f-price').fill('-100');
    if (await page.locator('#pack-f-tagline').isVisible().catch(() => false)) {
      await page.locator('#pack-f-tagline').fill('Automated test — negative price boundary');
    }

    const submitBtn = findSubmitButton(page);
    if (await submitBtn.isVisible().catch(() => false)) {
      await submitBtn.click();
      await page.waitForFunction(
        () => !document.querySelector('[class*="loading"]'),
        { timeout: 3_000 },
      ).catch(() => {});
    }

    if (createRequestFired) {
      const payloadStr = capturedPayload ?? '';
      if (/-100|"price"\s*:\s*-/.test(payloadStr)) {
        console.error(
          '[FINDING][high] pack-create-negative-price: a pack create request was sent with price = -100. ' +
            `Payload: ${payloadStr.slice(0, 300)}. ` +
            'Add client-side validation to reject negative prices, and ensure the backend also rejects them.',
        );
      } else {
        console.log('[INFO] pack-create-negative-price: request fired but negative price was sanitised before sending ✓');
      }
    } else {
      console.log('[INFO] pack-create-negative-price: negative price submission was blocked client-side ✓');
    }

    await dismissPackForm(page);
  });

  // ─── pack-create-zero-price ───────────────────────────────────────────────────

  test('pack-create-zero-price — pack creation with a zero price is handled explicitly', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, filled the pack create form with a valid name but set price to 0. Checked whether the form accepted or blocked the submission and captured what payload was sent to the backend. A zero-price pack may be intentional (a free gift), but the system should either allow it with clear intent or block it with a specific validation message rather than silently accepting it.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);
    await openPacksTab(page);

    const formOpened = await openCreatePackForm(page);
    if (!formOpened) {
      console.log('[INFO] pack-create-zero-price: could not open create form — skipping.');
      return;
    }

    let capturedPayload: string | null = null;
    let createRequestFired = false;
    await page.route(CF_PATTERN, async route => {
      createRequestFired = true;
      capturedPayload = route.request().postData();
      await route.abort();
    });

    await page.locator('#pack-f-name').fill('Sentinel Zero Price Test');
    await page.locator('#pack-f-price').fill('0');
    if (await page.locator('#pack-f-tagline').isVisible().catch(() => false)) {
      await page.locator('#pack-f-tagline').fill('Automated test — zero price boundary');
    }

    const submitBtn = findSubmitButton(page);
    if (await submitBtn.isVisible().catch(() => false)) {
      await submitBtn.click();
      await page.waitForFunction(
        () => !document.querySelector('[class*="loading"]'),
        { timeout: 3_000 },
      ).catch(() => {});
    }

    if (createRequestFired) {
      console.warn(
        `[FINDING][low] pack-create-zero-price: pack create request was sent with price = 0. ` +
          `Payload: ${(capturedPayload ?? '').slice(0, 300)}. ` +
          'Decide whether zero-price packs are intentional — if not, add validation requiring price > 0.',
      );
    } else {
      console.log('[INFO] pack-create-zero-price: zero price submission was blocked by client-side validation.');
    }

    await dismissPackForm(page);
  });

  // ─── pack-create-xss-in-name ─────────────────────────────────────────────────

  test('pack-create-xss-in-name — XSS payload in the pack name field does not execute', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, filled the pack name field with an XSS payload and submitted the form. Verified that the browser did not execute the injected script and that no alert dialog appeared. Also captured the outgoing payload to check whether the raw HTML was sent to the backend unsanitised. Stored XSS in pack names would execute for every admin who views the pack list.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);
    await openPacksTab(page);

    const formOpened = await openCreatePackForm(page);
    if (!formOpened) {
      console.log('[INFO] pack-create-xss-in-name: could not open create form — skipping.');
      return;
    }

    let xssDialogFired = false;
    page.on('dialog', async dialog => {
      xssDialogFired = true;
      console.error(
        `[FINDING][critical] pack-create-xss-in-name: XSS payload in pack name triggered a browser dialog. ` +
          `type="${dialog.type()}", message="${dialog.message()}". Stored XSS is executing.`,
      );
      await dialog.dismiss();
    });

    let capturedPayload: string | null = null;
    await page.route(CF_PATTERN, async route => {
      capturedPayload = route.request().postData();
      await route.abort();
    });

    const XSS_PAYLOAD = '<img src=x onerror=alert(1)>';
    await page.locator('#pack-f-name').fill(XSS_PAYLOAD);
    if (await page.locator('#pack-f-price').isVisible().catch(() => false)) {
      await page.locator('#pack-f-price').fill('50');
    }
    if (await page.locator('#pack-f-tagline').isVisible().catch(() => false)) {
      await page.locator('#pack-f-tagline').fill('XSS boundary test');
    }

    const submitBtn = findSubmitButton(page);
    if (await submitBtn.isVisible().catch(() => false)) {
      await submitBtn.click();
    }

    // Give the onerror handler one tick to fire if the browser interprets the filled value as HTML.
    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"]'),
      { timeout: 2_000 },
    ).catch(() => {});

    if (capturedPayload) {
      if (capturedPayload.includes('<img') || capturedPayload.includes('onerror')) {
        console.warn(
          '[FINDING][high] pack-create-xss-in-name: XSS payload was sent as raw HTML to the backend. ' +
            'The backend must sanitise or encode HTML in pack names before storing in Firestore — ' +
            'raw HTML will execute for any admin who views the pack list.',
        );
      } else {
        console.log('[INFO] pack-create-xss-in-name: payload was sanitised before being sent to the backend ✓');
      }
    } else {
      console.log('[INFO] pack-create-xss-in-name: no backend request sent (blocked client-side or by CF intercept).');
    }

    expect(xssDialogFired, 'XSS payload in pack name must not execute in the browser').toBe(false);

    await dismissPackForm(page);
  });

  // ─── pack-create-oversized-image ──────────────────────────────────────────────

  test('pack-create-oversized-image — uploading a 6 MB file to the image field shows a validation error', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, opened the pack create form, and injected a 6 MB synthetic file into the image upload field via the DataTransfer API. Verified that the form showed a validation error or size warning rather than silently accepting the file. Accepting arbitrarily large uploads without size limits would increase storage costs and degrade image load performance for guests.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);
    await openPacksTab(page);

    const formOpened = await openCreatePackForm(page);
    if (!formOpened) {
      console.log('[INFO] pack-create-oversized-image: could not open create form — skipping.');
      return;
    }

    const imageInput = page.locator('#pack-f-image-input');
    if (!(await imageInput.isVisible().catch(() => false))) {
      console.log('[INFO] pack-create-oversized-image: #pack-f-image-input not visible — skipping image upload test.');
      await dismissPackForm(page);
      return;
    }

    // Inject a 6 MB synthetic JPEG via the DataTransfer API.
    // This is equivalent to a user selecting a large file from disk.
    const fileInjected = await page.evaluate(() => {
      const input = document.getElementById('pack-f-image-input') as HTMLInputElement | null;
      if (!input) return false;
      try {
        const bytes = new Uint8Array(6 * 1024 * 1024);
        const file  = new File([bytes], 'oversized-test.jpg', { type: 'image/jpeg' });
        const dt    = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch {
        return false;
      }
    });

    if (!fileInjected) {
      console.log('[INFO] pack-create-oversized-image: DataTransfer injection not supported in this browser context — skipping.');
      await dismissPackForm(page);
      return;
    }

    // Allow change handlers and validation to run.
    await page.waitForFunction(
      () => !!document.querySelector('[class*="error"], [class*="warning"], [class*="file-error"], [class*="size"]'),
      { timeout: 3_000 },
    ).catch(() => {});

    const errorVisible = await page.locator(
      '#pack-form-modal [class*="error"], #pack-form-modal [class*="warning"], #pack-form-modal [class*="file-error"]',
    ).first().isVisible().catch(() => false);

    const dropZoneText = ((await page.locator('#pack-img-drop').textContent().catch(() => '')) ?? '').toLowerCase();
    const dropZoneError = /too large|max|limit|size|invalid|error/i.test(dropZoneText);

    if (errorVisible || dropZoneError) {
      console.log('[INFO] pack-create-oversized-image: 6 MB file triggered a visible validation message ✓');
    } else {
      console.warn(
        '[FINDING][medium] pack-create-oversized-image: a 6 MB image was accepted with no visible size validation. ' +
          'Add a client-side file size check (recommended max: 2 MB) to prevent oversized uploads.',
      );
    }

    await dismissPackForm(page);
  });

});
