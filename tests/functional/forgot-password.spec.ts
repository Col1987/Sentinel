import { test, expect } from '@playwright/test';
import { runJourney } from '../../src/runners/journey-runner';
import { journeys } from '../../src/config/journeys';
import { LIVE_MODE, testEmail } from '../../src/config/sites';

const find = (id: string) => journeys.find(j => j.id === id)!;

const emptySubmit  = find('forgot-empty-submit');
const invalidEmail = find('forgot-invalid-email');
const happyPath    = find('forgot-happy-path');
const backToLogin  = find('forgot-back-to-login');

// Firebase callable Cloud Function for password reset (not Firebase Auth's sendOobCode)
const SEND_OOB_URL = '**/sendPasswordReset**';

test.describe('Forgot password form', { tag: ['@functional'] }, () => {

  // ─── Validation ───────────────────────────────────────────────────────────

  test('empty submit — validation blocks with no email filled', async ({ page }) => {
    await page.goto('/');
    await runJourney(emptySubmit, page);
  });

  test('invalid email — type="email" must reject non-email format', async ({ page }) => {
    if (LIVE_MODE) test.slow();
    let sendOobAttempted = false;

    if (!LIVE_MODE) {
      await page.route(SEND_OOB_URL, async (route) => {
        sendOobAttempted = true;
        await route.abort();
      });
    }

    await page.goto('/');
    await runJourney(invalidEmail, page);

    if (sendOobAttempted) {
      console.error(
        '[FINDING][high] forgot-invalid-email: form submitted a sendOobCode request with ' +
          '"notanemail" as the email. The email field is missing type="email" or custom validation.',
      );
    }
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  test('happy path — valid email triggers a Firebase Auth password-reset request', async ({ page }) => {
    if (LIVE_MODE) test.slow();
    // Block the actual request to prevent sending a real reset email.
    // waitForRequest resolves when the request is dispatched, before the abort takes effect.
    if (!LIVE_MODE) await page.route(SEND_OOB_URL, route => route.abort());

    const resetRequest = page.waitForRequest(
      req => req.url().includes('sendPasswordReset') && req.method() === 'POST',
      { timeout: 10_000 },
    );

    await page.goto('/');
    await runJourney(happyPath, page);

    const req = await resetRequest;
    const body = JSON.parse(req.postData() ?? '{}');

    expect(body.data?.email, 'sendPasswordReset request must include the submitted email').toBe(testEmail('pw01'));
  });

  // ─── Navigation ───────────────────────────────────────────────────────────

  test('back to login — Back link restores the login form', async ({ page }) => {
    await page.goto('/');
    await runJourney(backToLogin, page);
  });

});
