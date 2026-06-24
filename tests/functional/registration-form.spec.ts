import { test, expect } from '@playwright/test';
import { runJourney } from '../../src/runners/journey-runner';
import { journeys } from '../../src/config/journeys';

const find = (id: string) => journeys.find(j => j.id === id)!;

const emptySubmit     = find('reg-empty-submit');
const pwMismatch      = find('reg-password-mismatch');
const weakPassword    = find('reg-weak-password');
const invalidEmail    = find('reg-invalid-email');
const termsUnchecked  = find('reg-terms-unchecked');
const invalidPhone    = find('reg-invalid-phone');
const countryDefault  = find('reg-country-code-default');
const happyPath       = find('reg-happy-path');

// Firebase Auth signUp endpoint — the only call that would create a real account
const SIGN_UP_URL = '**/accounts:signUp**';

test.describe('Registration form', { tag: ['@functional'] }, () => {

  // ─── Required field validation ────────────────────────────────────────────

  test('empty submit — all required fields must be filled', async ({ page }) => {
    await page.route(SIGN_UP_URL, route => route.abort());
    await page.goto('/');
    await runJourney(emptySubmit, page);
  });

  // ─── Password validation ──────────────────────────────────────────────────

  test('password mismatch — confirm must match password', async ({ page }) => {
    let signUpAttempted = false;

    await page.route(SIGN_UP_URL, async (route) => {
      signUpAttempted = true;
      await route.abort();
    });

    await page.goto('/');
    await runJourney(pwMismatch, page);

    if (signUpAttempted) {
      console.error(
        '[FINDING][high] reg-password-mismatch: form submitted a signUp request despite ' +
          'password/confirm mismatch. Client-side password comparison check is absent.',
      );
    }
  });

  test('weak password — "123" must be rejected before reaching the backend', async ({ page }) => {
    let signUpAttempted = false;

    await page.route(SIGN_UP_URL, async (route) => {
      signUpAttempted = true;
      await route.abort();
    });

    await page.goto('/');
    await runJourney(weakPassword, page);

    if (signUpAttempted) {
      // Firebase enforces a 6-char minimum server-side, but no client-side gate caught it first.
      console.warn(
        '[FINDING][medium] reg-weak-password: password "123" bypassed client-side validation ' +
          'and reached the backend. Firebase will reject it, but a frontend strength check ' +
          'would give the user earlier feedback.',
      );
    }
  });

  // ─── Input format validation ──────────────────────────────────────────────

  test('invalid email — type="email" must reject non-email format', async ({ page }) => {
    let signUpAttempted = false;

    await page.route(SIGN_UP_URL, async (route) => {
      signUpAttempted = true;
      await route.abort();
    });

    await page.goto('/');
    await runJourney(invalidEmail, page);

    if (signUpAttempted) {
      console.error(
        '[FINDING][high] reg-invalid-email: form submitted a signUp request with "notanemail" ' +
          'as the email value. The email field is missing type="email" or custom validation.',
      );
    }
  });

  test('terms unchecked — required checkbox must block submission', async ({ page }) => {
    let signUpAttempted = false;

    await page.route(SIGN_UP_URL, async (route) => {
      signUpAttempted = true;
      await route.abort();
    });

    await page.goto('/');
    await runJourney(termsUnchecked, page);

    if (signUpAttempted) {
      console.error(
        '[FINDING][high] reg-terms-unchecked: form submitted a signUp request with the terms ' +
          'checkbox unchecked. The checkbox is missing required attribute or custom validation.',
      );
    }
  });

  test('invalid phone — "abc" as mobile number: check if format validation exists', async ({ page }) => {
    let signUpAttempted = false;

    await page.route(SIGN_UP_URL, async (route) => {
      signUpAttempted = true;
      await route.abort();
    });

    await page.goto('/');
    await runJourney(invalidPhone, page);

    // tel inputs have no built-in browser format validation, so a request firing here
    // is expected if the form has no custom phone check. It's a finding but lower severity.
    if (signUpAttempted) {
      console.warn(
        '[FINDING][low] reg-invalid-phone: "abc" bypassed validation and a signUp request ' +
          'was attempted. type="tel" does not enforce numeric format — custom validation or ' +
          'a pattern attribute is needed.',
      );
    } else {
      console.log('[INFO] reg-invalid-phone: custom phone validation blocked "abc" before reaching the backend.');
    }
  });

  // ─── Default state ────────────────────────────────────────────────────────

  test('country code default — select should pre-select South Africa (+27)', async ({ page }) => {
    await page.goto('/');
    await runJourney(countryDefault, page);

    // Check the visible text of the selected option — value attribute format varies
    // (+27, 27, ZA) but the display text should always contain "+27" or "27"
    const selectedText = await page
      .locator('#reg-mobile-cc option:checked')
      .textContent() ?? '';

    const selectedValue = await page.locator('#reg-mobile-cc').inputValue();

    const isDefaultSA =
      selectedText.includes('27') || selectedValue.includes('27');

    if (!isDefaultSA) {
      console.error(
        `[FINDING][medium] reg-country-code-default: country code does not default to +27. ` +
          `Selected value: "${selectedValue}", display text: "${selectedText.trim()}". ` +
          'South African business should default to the local dial code.',
      );
    }

    expect(isDefaultSA, `Expected +27 default, got value="${selectedValue}" text="${selectedText.trim()}"`).toBe(true);
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  test('happy path — valid data causes a Firebase Auth signUp request', async ({ page }) => {
    // Block the actual signUp to prevent creating a real account.
    // waitForRequest resolves as soon as the request is dispatched, before the abort fires.
    await page.route(SIGN_UP_URL, route => route.abort());

    const signUpRequest = page.waitForRequest(
      req => req.url().includes('accounts:signUp') && req.method() === 'POST',
      { timeout: 10_000 },
    );

    await page.goto('/');
    await runJourney(happyPath, page);

    // Verify the form sent a signUp request with the expected payload shape
    const req = await signUpRequest;
    const body = JSON.parse(req.postData() ?? '{}');

    expect(body.email, 'signUp request should include the email').toBe('sentinel-test@sentinel.dev');
    expect(body.password, 'signUp request should include a password').toBeTruthy();
  });

});
