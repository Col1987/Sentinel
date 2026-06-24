import { test } from '@playwright/test';
import { runJourney } from '../../src/runners/journey-runner';
import { journeys } from '../../src/config/journeys';

const happyPath = journeys.find(j => j.id === 'demo-happy-path')!;
const emptySubmit = journeys.find(j => j.id === 'demo-empty-submit')!;

test.describe('Demo booking form', { tag: ['@functional'] }, () => {
  test('happy path — fills all fields and submits', async ({ page }) => {
    // Intercept only the Cloud Function endpoint that handles demo form submissions.
    // The callable function SDK wraps responses in {"result": ...} — that exact
    // shape is required for the form JS to recognise the call as successful.
    // All other requests (Firestore, assets) are allowed through normally.
    await page.route('**/createDemoRequest', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ result: { success: true } }),
      });
    });

    await page.goto('/');
    await runJourney(happyPath, page);
  });

  test('empty submit — form should not reach a success state without data', async ({ page }) => {
    let postAttempted = false;

    // Block any POST that bypasses client-side validation to prevent real submission.
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

    // Probe validation state after the failed submit attempt.
    const nativeInvalidCount = await page.locator('#demo-form :invalid').count();
    const customErrorCount = await page
      .locator('#demo-form [class*="error"]:visible, #demo-form [role="alert"]:visible')
      .count();

    if (postAttempted && nativeInvalidCount === 0 && customErrorCount === 0) {
      // The form sent a POST with no data and no validation errors were shown.
      // The journey still passed (submit button remained visible), but this is a
      // quality finding that the auditor should capture.
      console.error(
        '[FINDING][high] demo-empty-submit: form submitted a POST request with no filled ' +
          'fields and no visible client-side validation. Request was blocked by Sentinel.',
      );
    }
  });
});
