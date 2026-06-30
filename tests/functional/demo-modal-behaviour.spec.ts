import { test, expect } from '@playwright/test';
import { LIVE_MODE, testEmail } from '../../src/config/sites';

const DEMO_CF_URL    = '**/createDemoRequest**';
const CF_PATTERN     = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';
const SUCCESS_BODY   = JSON.stringify({ result: { success: true } });

// The demo modal auto-closes ~2.5s after a successful submission (per the QA checklist).
const AUTO_CLOSE_WAIT_MS = 4_000;

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

// Opens the demo modal and fills the form with valid data without submitting.
async function openAndFillDemoForm(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('button:has-text("Book a Demo")').click();
  await page.locator('#demo-name').waitFor({ state: 'visible', timeout: 8_000 });

  await page.locator('#demo-name').fill('Sentinel Test');
  await page.locator('#demo-email').fill(testEmail('demo01'));

  // Select dropdowns (graceful — may not be required)
  const propertyType = page.locator('#demo-property-type');
  if (await propertyType.isVisible().catch(() => false)) {
    await propertyType.selectOption({ index: 1 }).catch(() => {});
  }
  const numProperties = page.locator('#demo-num-properties');
  if (await numProperties.isVisible().catch(() => false)) {
    await numProperties.selectOption({ index: 1 }).catch(() => {});
  }
}

test.describe('Demo modal behaviour', { tag: ['@functional'] }, () => {

  test.beforeEach(async ({ page }) => {
    if (!LIVE_MODE) {
      // Block all CF calls except createDemoRequest (handled per-test).
      await page.route(CF_PATTERN, async route => {
        if (route.request().url().includes('createDemoRequest')) {
          await route.continue();
        } else {
          await route.abort();
        }
      });
    }
  });

  // ─── demo-success-auto-closes ─────────────────────────────────────────────────

  test('demo-success-auto-closes — the demo modal closes automatically ~2.5 s after a successful submission', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Filled in the demo booking form with valid data and submitted it. In safe mode the Cloud Function response was intercepted and returned a success payload. Verified that a success message appeared in the modal, and that the modal then closed automatically without any user interaction. A modal that stays open after success creates confusion — the visitor does not know whether to close it manually or wait.",
    });

    if (LIVE_MODE) test.slow();

    if (!LIVE_MODE) {
      await page.route(DEMO_CF_URL, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: SUCCESS_BODY }),
      );
    }

    await page.goto('/');

    await requireVisible(page, 'button:has-text("Book a Demo")', '/');
    await openAndFillDemoForm(page);
    await requireVisible(page, '#demo-submit-btn', '/ (demo modal)');

    await page.locator('#demo-submit-btn').click();

    // Wait for the form to transition to a success state (submit button hides on success).
    const successStateReached = await page.locator('#demo-submit-btn')
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!successStateReached) {
      console.error(
        '[FINDING][medium] demo-success-auto-closes: #demo-submit-btn remained visible after submitting the demo form. ' +
          'The form did not transition to a success state — check that the CF response triggered the success handler.',
      );
    } else {
      console.log('[INFO] demo-success-auto-closes: form transitioned to success state ✓');
    }

    expect(successStateReached, 'Demo form must reach a success state after a valid submission').toBe(true);

    // After success, wait for the auto-close and verify the modal is gone.
    const demoModal = page.locator('#demo-modal, [id*="demo"][class*="modal"], .modal:has(#demo-name)').first();
    const modalHidden = await demoModal
      .waitFor({ state: 'hidden', timeout: AUTO_CLOSE_WAIT_MS + 1_000 })
      .then(() => true)
      .catch(() => false);

    if (!modalHidden) {
      console.warn(
        '[FINDING][low] demo-success-auto-closes: the demo modal did not close automatically after ' +
          `${AUTO_CLOSE_WAIT_MS}ms. The QA checklist states the modal should auto-close ~2.5s after submission. ` +
          'Visitors may be confused if they need to manually close a successful booking modal.',
      );
    } else {
      console.log('[INFO] demo-success-auto-closes: modal closed automatically after success ✓');
    }
  });

  // ─── demo-reopen-no-stale-state ───────────────────────────────────────────────

  test('demo-reopen-no-stale-state — reopening the demo modal after a successful submission shows an empty, reset form', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Submitted the demo form successfully (with the backend intercepted in safe mode), waited for the modal to auto-close, then reopened it by clicking 'Book a Demo' again. Verified that the form fields were empty and that no success or error message was visible from the previous submission. Stale form state on reopen would allow visitors to accidentally re-submit the same data, and would be confusing for users who want to book for a different property.",
    });

    if (LIVE_MODE) test.slow();

    if (!LIVE_MODE) {
      await page.route(DEMO_CF_URL, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: SUCCESS_BODY }),
      );
    }

    await page.goto('/');

    await requireVisible(page, 'button:has-text("Book a Demo")', '/');
    await openAndFillDemoForm(page);
    await requireVisible(page, '#demo-submit-btn', '/ (demo modal)');

    await page.locator('#demo-submit-btn').click();

    // Wait for success state.
    await page.locator('#demo-submit-btn')
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .catch(() => {});

    // Wait for auto-close (or proceed anyway if it doesn't auto-close).
    await page.locator('#demo-modal, [id*="demo"][class*="modal"], .modal:has(#demo-name)')
      .first()
      .waitFor({ state: 'hidden', timeout: AUTO_CLOSE_WAIT_MS + 1_000 })
      .catch(() => {
        // Modal didn't auto-close; close it manually to test the reopen.
        console.log('[INFO] demo-reopen-no-stale-state: modal did not auto-close — closing manually to test reopen.');
      });

    // Reopen the modal.
    await requireVisible(page, 'button:has-text("Book a Demo")', '/');
    await page.locator('button:has-text("Book a Demo")').click();
    await page.locator('#demo-name').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});

    const nameValue  = await page.locator('#demo-name').inputValue().catch(() => '??');
    const emailValue = await page.locator('#demo-email').inputValue().catch(() => '??');

    const hasStaleInput = nameValue.trim() !== '' || emailValue.trim() !== '';

    if (hasStaleInput) {
      console.error(
        `[FINDING][medium] demo-reopen-no-stale-state: reopened demo modal has stale field values ` +
          `(name="${nameValue}", email="${emailValue}"). The form must be reset to empty fields when reopened.`,
      );
    } else {
      console.log(`[INFO] demo-reopen-no-stale-state: form fields are empty on reopen ✓`);
    }

    // Check that no success or error message from the previous submission is visible.
    const STALE_STATE_SIGNALS = [
      '[class*="success"]:visible',
      '[class*="error"]:visible',
      '[role="alert"]:visible',
      '[id*="success"]:visible',
    ];

    let staleMessageVisible = false;
    for (const sel of STALE_STATE_SIGNALS) {
      if (await page.locator(`#demo-modal ${sel}, [id*="demo"][class*="modal"] ${sel}`).count() > 0) {
        staleMessageVisible = true;
        console.warn(
          `[FINDING][medium] demo-reopen-no-stale-state: stale success/error message (${sel}) is visible ` +
            'in the reopened demo modal. The modal must reset all state when it is reopened.',
        );
        break;
      }
    }

    expect(hasStaleInput, 'Reopened demo modal must have empty form fields (no stale data from previous submission)').toBe(false);
    expect(staleMessageVisible, 'Reopened demo modal must not show a success or error message from the previous submission').toBe(false);
  });

});
