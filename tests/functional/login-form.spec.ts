import { test } from '@playwright/test';
import { runJourney } from '../../src/runners/journey-runner';
import { journeys } from '../../src/config/journeys';

const find = (id: string) => journeys.find(j => j.id === id)!;

const emptySubmit    = find('login-empty-submit');
const invalidEmail   = find('login-invalid-email');
const passwordToggle = find('login-password-toggle');
const rememberMe     = find('login-remember-me');
const toRegister     = find('login-to-register');
const toForgot       = find('login-to-forgot');

// Firebase Auth sign-in endpoint
const SIGN_IN_URL = '**/accounts:signInWithPassword**';

test.describe('Login form', { tag: ['@functional'] }, () => {

  // ─── Validation ───────────────────────────────────────────────────────────

  test('empty submit — validation blocks with no fields filled', async ({ page }) => {
    // No route setup needed — browser required-field validation fires before any network call
    await page.goto('/');
    await runJourney(emptySubmit, page);
  });

  test('invalid email — type="email" must reject non-email format', async ({ page }) => {
    let signInAttempted = false;

    await page.route(SIGN_IN_URL, async (route) => {
      signInAttempted = true;
      await route.abort();
    });

    await page.goto('/');
    await runJourney(invalidEmail, page);

    if (signInAttempted) {
      console.error(
        '[FINDING][high] login-invalid-email: form submitted a signInWithPassword request with ' +
          '"notanemail" as the email value. The email field is missing type="email" or custom validation.',
      );
    }
  });

  // ─── Interactive controls ─────────────────────────────────────────────────

  test('password toggle — show/hide switches input type between "password" and "text"', async ({ page }) => {
    await page.goto('/');
    await runJourney(passwordToggle, page);
  });

  test('remember me — checkbox is present and interactive', async ({ page }) => {
    await page.goto('/');
    await runJourney(rememberMe, page);
  });

  // ─── Navigation links ─────────────────────────────────────────────────────

  test('login → register — Register link opens registration form', async ({ page }) => {
    await page.goto('/');
    await runJourney(toRegister, page);
  });

  test('login → forgot — Forgot password link opens forgot password form', async ({ page }) => {
    await page.goto('/');
    await runJourney(toForgot, page);
  });

});
