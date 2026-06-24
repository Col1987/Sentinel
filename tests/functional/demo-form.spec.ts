import { test } from '@playwright/test';
import { runJourney } from '../../src/runners/journey-runner';
import { journeys } from '../../src/config/journeys';

const find = (id: string) => journeys.find(j => j.id === id)!;

const happyPath     = find('demo-happy-path');
const emptySubmit   = find('demo-empty-submit');
const invalidEmail  = find('demo-invalid-email');
const missingName   = find('demo-missing-name');
const missingEmail  = find('demo-missing-email');
const longInput     = find('demo-long-input');
const specialChars  = find('demo-special-chars');
const doubleSubmit  = find('demo-double-submit');

const SUCCESS_BODY = JSON.stringify({ result: { success: true } });

test.describe('Demo booking form', { tag: ['@functional'] }, () => {

  // ─── Positive flow ───────────────────────────────────────────────────────────

  test('happy path — fills all fields and submits', async ({ page }) => {
    // Intercept only the Cloud Function endpoint. Firebase callable SDK wraps
    // responses in {"result":...} — that exact shape triggers the success state.
    await page.route('**/createDemoRequest', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: SUCCESS_BODY });
    });

    await page.goto('/');
    await runJourney(happyPath, page);
  });

  // ─── Validation — required fields ────────────────────────────────────────────

  test('empty submit — form should not reach a success state without data', async ({ page }) => {
    let postAttempted = false;

    await page.route('**/*', async (route) => {
      if (route.request().method() === 'POST') {
        postAttempted = true;
        await route.abort();
      } else {
        await route.continue();
      }
    });

    await page.goto('/');
    await runJourney(emptySubmit, page);

    const nativeInvalidCount = await page.locator('#demo-form :invalid').count();
    const customErrorCount = await page
      .locator('#demo-form [class*="error"]:visible, #demo-form [role="alert"]:visible')
      .count();

    if (postAttempted && nativeInvalidCount === 0 && customErrorCount === 0) {
      console.error(
        '[FINDING][high] demo-empty-submit: form submitted a POST with no filled fields ' +
          'and no visible client-side validation. Request was blocked by Sentinel.',
      );
    }
  });

  test('missing name — validation should block submission without name', async ({ page }) => {
    let postFired = false;

    await page.route('**/createDemoRequest', async (route) => {
      postFired = true;
      await route.abort();
    });

    await page.goto('/');
    await runJourney(missingName, page);

    if (postFired) {
      console.error(
        '[FINDING][high] demo-missing-name: form submitted a POST with an empty name field. ' +
          'Name field either lacks a required attribute or custom validation is absent.',
      );
    }
  });

  test('missing email — validation should block submission without email', async ({ page }) => {
    let postFired = false;

    await page.route('**/createDemoRequest', async (route) => {
      postFired = true;
      await route.abort();
    });

    await page.goto('/');
    await runJourney(missingEmail, page);

    if (postFired) {
      console.error(
        '[FINDING][high] demo-missing-email: form submitted a POST with an empty email field. ' +
          'Email field either lacks a required attribute or custom validation is absent.',
      );
    }
  });

  // ─── Validation — input format ────────────────────────────────────────────────

  test('invalid email — browser validation should reject non-email format', async ({ page }) => {
    let postFired = false;

    await page.route('**/createDemoRequest', async (route) => {
      postFired = true;
      await route.abort();
    });

    await page.goto('/');
    await runJourney(invalidEmail, page);

    if (postFired) {
      console.error(
        '[FINDING][high] demo-invalid-email: form submitted a POST with "not-an-email" as the ' +
          'email value. The email field is missing type="email" or input validation.',
      );
    }
  });

  // ─── Boundary / robustness ───────────────────────────────────────────────────

  test('long input — 2000-char name should not break the form', async ({ page }) => {
    let sentNameLength = -1;

    await page.route('**/createDemoRequest', async (route) => {
      try {
        const body = JSON.parse(route.request().postData() ?? '{}');
        sentNameLength = (body?.data?.name ?? '').length;
      } catch { /* ignore parse errors */ }
      await route.fulfill({ status: 200, contentType: 'application/json', body: SUCCESS_BODY });
    });

    await page.goto('/');
    await runJourney(longInput, page);

    if (sentNameLength >= 0 && sentNameLength < 2000) {
      console.warn(
        `[FINDING][info] demo-long-input: name was truncated to ${sentNameLength} chars ` +
          'before reaching the backend (maxlength or JS sanitisation is active).',
      );
    } else if (sentNameLength === 2000) {
      console.warn(
        '[FINDING][info] demo-long-input: full 2000-char name reached the backend with no ' +
          'client-side length limit. Backend must enforce its own size constraints.',
      );
    }
  });

  test('special chars — XSS payload in name must not execute as code', async ({ page }) => {
    let xssAlertFired = false;

    page.on('dialog', async (dialog) => {
      xssAlertFired = true;
      await dialog.dismiss();
    });

    await page.route('**/createDemoRequest', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: SUCCESS_BODY });
    });

    await page.goto('/');
    await runJourney(specialChars, page);

    if (xssAlertFired) {
      throw new Error(
        '[CRITICAL] demo-special-chars: JavaScript executed via name field — XSS vulnerability confirmed.',
      );
    }
  });

  // ─── Concurrency ─────────────────────────────────────────────────────────────

  test('double submit — concurrent clicks should fire only one request', async ({ page }) => {
    let requestCount = 0;

    await page.route('**/createDemoRequest', async (route) => {
      requestCount++;
      // Hold the response briefly so both clicks have a chance to fire before
      // the first one resolves and the success state hides the button.
      await new Promise<void>(r => setTimeout(r, 150));
      await route.fulfill({ status: 200, contentType: 'application/json', body: SUCCESS_BODY });
    });

    await page.goto('/');
    await runJourney(doubleSubmit, page);

    if (requestCount > 1) {
      console.error(
        `[FINDING][high] demo-double-submit: ${requestCount} requests reached the backend from ` +
          'a double-click. The form lacks submit deduplication — backend idempotency required.',
      );
    }
  });

});
