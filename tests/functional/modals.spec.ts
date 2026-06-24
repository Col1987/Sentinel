import { test } from '@playwright/test';
import { runJourney } from '../../src/runners/journey-runner';
import { journeys } from '../../src/config/journeys';

const find = (id: string) => journeys.find(j => j.id === id)!;

const loginOpens      = find('modal-login-opens');
const loginClosesX    = find('modal-login-closes-x');
const loginToRegister = find('modal-login-to-register');
const registerToLogin = find('modal-register-to-login');
const loginToForgot   = find('modal-login-to-forgot');
const demoOpens       = find('modal-demo-opens');
const demoClosesX     = find('modal-demo-closes-x');
const cartOpens       = find('modal-cart-opens');
const cartCloses      = find('modal-cart-closes');

test.describe('Modals and overlays', { tag: ['@functional'] }, () => {

  // ─── Auth modal ──────────────────────────────────────────────────────────────

  test('login modal opens when login button is clicked', async ({ page }) => {
    await page.goto('/');
    await runJourney(loginOpens, page);
  });

  test('login modal closes when × button is clicked', async ({ page }) => {
    await page.goto('/');
    await runJourney(loginClosesX, page);
  });

  test('login modal → register form via Register link', async ({ page }) => {
    await page.goto('/');
    await runJourney(loginToRegister, page);
  });

  test('register form → login modal via Login link', async ({ page }) => {
    await page.goto('/');
    await runJourney(registerToLogin, page);
  });

  test('login modal → forgot password form via Forgot link', async ({ page }) => {
    await page.goto('/');
    await runJourney(loginToForgot, page);
  });

  // ─── Demo modal ──────────────────────────────────────────────────────────────

  test('demo modal opens when Book a Demo button is clicked', async ({ page }) => {
    await page.goto('/');
    await runJourney(demoOpens, page);
  });

  test('demo modal closes when × button is clicked', async ({ page }) => {
    await page.goto('/');
    await runJourney(demoClosesX, page);
  });

  // ─── Cart drawer ─────────────────────────────────────────────────────────────

  test('cart drawer opens when cart button is clicked', async ({ page }) => {
    await page.goto('/');
    await runJourney(cartOpens, page);
  });

  test('cart drawer closes when × button is clicked', async ({ page }) => {
    await page.goto('/');
    await runJourney(cartCloses, page);
  });

});
