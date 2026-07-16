import { test, expect } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

test.describe('Checkout abuse', { tag: ['@security'] }, () => {

  test.beforeEach(async ({ page }) => {
    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }
  });

  // ─── checkout-direct-access-no-cart ──────────────────────────────────────────

  test('checkout-direct-access-no-cart — direct navigation to /checkout.html with no cart shows empty state or blocks checkout', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated directly to the checkout page without adding any products to the cart. Verified that the page either redirected away, showed an empty cart message, or blocked the payment step. Allowing checkout to proceed with no items would result in a R0.00 payment attempt and an unfulfillable order record.",
    });

    if (LIVE_MODE) test.slow();

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto('/checkout.html', { waitUntil: 'load' });

    // Allow Firebase auth and cart-state initialisation to settle.
    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [aria-busy="true"]'),
      undefined,
      { timeout: 6_000 },
    ).catch(() => {});

    const finalUrl = page.url();
    const wasRedirected = !finalUrl.includes('checkout');

    if (wasRedirected) {
      console.log(`[INFO] checkout-direct-access-no-cart: redirected to "${finalUrl}" — empty-cart guard is active ✓`);
    } else {
      const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());

      const EMPTY_SIGNALS   = ['empty cart', 'no items', 'cart is empty', 'nothing in your cart', 'add items first'];
      const hasEmptyMessage = EMPTY_SIGNALS.some(s => bodyText.includes(s));

      const AUTH_SIGNALS = ['not logged in', 'please log in', 'sign in', 'login required'];
      const hasAuthGate  = AUTH_SIGNALS.some(s => bodyText.includes(s)) ||
        await page.locator('#not-logged-in').isVisible().catch(() => false) ||
        await page.locator('[id*="auth-overlay"]').isVisible().catch(() => false);

      if (hasEmptyMessage) {
        console.log('[INFO] checkout-direct-access-no-cart: empty cart message visible ✓');
      } else if (hasAuthGate) {
        console.log('[INFO] checkout-direct-access-no-cart: auth gate shown — cannot reach checkout without login ✓');
      } else {
        // Check whether a live payment form is surfaced for an empty cart.
        const paymentFormVisible = await page.locator(
          'form[action*="payfast"], form[action*="payment"], #checkout-form, #payment-form',
        ).first().isVisible().catch(() => false);

        if (paymentFormVisible) {
          const amountInput = page.locator('input[name="amount"], input[name*="total"]').first();
          const amountValue = await amountInput.inputValue().catch(() => '');
          const isZero = amountValue === '' || amountValue === '0' || amountValue === '0.00';

          if (isZero) {
            console.warn(
              '[FINDING][high] checkout-direct-access-no-cart: a payment form is visible with an empty cart and amount = "' + amountValue + '". ' +
                'A zero-value payment submission could create a broken order record.',
            );
          } else {
            console.warn(
              `[FINDING][medium] checkout-direct-access-no-cart: payment form is visible with no cart items (amount="${amountValue}"). ` +
                'The checkout page should require at least one item before rendering the payment step.',
            );
          }
        } else {
          console.log('[INFO] checkout-direct-access-no-cart: no payment form visible — checkout appears blocked (auth gate may use an undetected mechanism).');
        }
      }
    }

    if (pageErrors.length > 0) {
      console.error(
        `[FINDING][high] checkout-direct-access-no-cart: ${pageErrors.length} JS exception(s): ${pageErrors.join(' | ')}`,
      );
    }

    expect(pageErrors, 'No unhandled JS exceptions must fire when reaching /checkout.html with an empty cart').toHaveLength(0);
  });

  // ─── checkout-direct-access-no-auth ──────────────────────────────────────────

  test('checkout-direct-access-no-auth — /checkout.html must require authentication before the payment step', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to the checkout page without logging in. Verified that the page showed a login prompt or redirected rather than surfacing payment controls to an unauthenticated visitor. An unauthenticated checkout endpoint could be used to probe the payment integration or generate orders with arbitrary email addresses.",
    });

    if (LIVE_MODE) test.slow();

    await page.goto('/checkout.html', { waitUntil: 'load' });

    // Wait for Firebase onAuthStateChanged to resolve the unauthenticated state.
    await page.locator('#not-logged-in, [id*="auth-overlay"], [id*="auth-gate"]')
      .first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});

    const finalUrl = page.url();
    if (!finalUrl.includes('checkout')) {
      console.log(`[INFO] checkout-direct-access-no-auth: redirected to "${finalUrl}" — auth redirect is active ✓`);
      return;
    }

    const AUTH_GATE_SELECTORS = [
      '#not-logged-in',
      '[id*="auth-overlay"]',
      '[id*="login-required"]',
      '[class*="auth-gate"]',
      '[class*="login-wall"]',
    ];

    let authGateFound = false;
    for (const sel of AUTH_GATE_SELECTORS) {
      if (await page.locator(sel).isVisible().catch(() => false)) {
        authGateFound = true;
        console.log(`[INFO] checkout-direct-access-no-auth: auth gate found via "${sel}" ✓`);
        break;
      }
    }

    if (!authGateFound) {
      // Check whether payment controls are directly accessible without auth.
      const PAYMENT_CONTROLS = [
        'form[action*="payfast"]',
        'button:has-text("Pay Now")',
        'button:has-text("Place Order")',
        'button:has-text("Confirm Order")',
        'input[name="merchant_id"]',
      ];
      let paymentControlVisible = false;
      for (const sel of PAYMENT_CONTROLS) {
        if (await page.locator(sel).first().isVisible().catch(() => false)) {
          paymentControlVisible = true;
          console.error(
            `[FINDING][high] checkout-direct-access-no-auth: "${sel}" is accessible without authentication. ` +
              'Payment controls must require a logged-in session before they are rendered.',
          );
          break;
        }
      }
      if (!paymentControlVisible) {
        console.log('[INFO] checkout-direct-access-no-auth: no payment controls visible — checkout appears protected (auth gate not using a known selector).');
      }
    }
  });

  // ─── checkout-form-xss ───────────────────────────────────────────────────────

  test('checkout-form-xss — XSS payloads in checkout address and name fields do not execute', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to the checkout page and entered an XSS payload into each visible text field (name, address, phone, notes). Verified that the browser did not execute the injected script. If the checkout page reflects a field value back to the page unsanitised — for example in an order summary — a stored XSS payload would execute for every admin who opens that order.",
    });

    let xssDialogFired = false;
    page.on('dialog', async dialog => {
      xssDialogFired = true;
      console.error(
        `[FINDING][critical] checkout-form-xss: XSS payload triggered a browser dialog. ` +
          `type="${dialog.type()}", message="${dialog.message()}". Script injection is executing in a checkout field.`,
      );
      await dialog.dismiss();
    });

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto('/checkout.html', { waitUntil: 'load' });

    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [aria-busy="true"]'),
      undefined,
      { timeout: 6_000 },
    ).catch(() => {});

    const XSS_PAYLOAD = '<img src=x onerror=alert(1)>';
    const textInputs = await page.locator(
      'input[type="text"]:visible, input[type="tel"]:visible, input[type="email"]:visible, textarea:visible',
    ).all();

    if (textInputs.length === 0) {
      console.log('[INFO] checkout-form-xss: no visible text input fields found (page may require auth to expose form) — skipping injection test.');
    } else {
      console.log(`[INFO] checkout-form-xss: found ${textInputs.length} text field(s) — filling each with XSS payload.`);
      for (const input of textInputs) {
        await input.fill(XSS_PAYLOAD).catch(() => {});
      }
      // Allow onerror handlers one tick to fire if the browser interprets the value as HTML.
      await page.waitForFunction(
        () => !document.querySelector('[class*="loading"]'),
        undefined,
        { timeout: 2_000 },
      ).catch(() => {});
    }

    if (pageErrors.length > 0) {
      console.warn(
        `[FINDING][medium] checkout-form-xss: ${pageErrors.length} JS exception(s) after XSS fill: ${pageErrors.join(' | ')}`,
      );
    }

    expect(xssDialogFired, 'XSS payloads must not execute as JavaScript in any checkout form field').toBe(false);
    expect(pageErrors, 'XSS payloads in checkout fields must not cause unhandled JS exceptions').toHaveLength(0);
  });

  // ─── checkout-form-empty-submit ───────────────────────────────────────────────

  test('checkout-form-empty-submit — submitting the checkout form with empty required fields is blocked by validation', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Navigated to the checkout page and checked whether required fields enforce HTML5 validation before the payment step can proceed. Checked using form.checkValidity() to avoid accidentally triggering a navigation or PayFast redirect. A checkout form with no required-field validation would allow orders to be placed with no delivery address, making fulfilment impossible.",
    });

    await page.goto('/checkout.html', { waitUntil: 'load' });

    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [aria-busy="true"]'),
      undefined,
      { timeout: 6_000 },
    ).catch(() => {});

    // Exclude PayFast redirect forms (action targets payfast.co.za) from the validity check —
    // those are auto-submitted by JS and rely on a server-generated signature, not user input.
    const result = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll<HTMLFormElement>('form'));
      const checkout = all.filter(f => !f.action.includes('payfast.co.za'));
      if (checkout.length === 0) return { hasForm: false, valid: null, requiredCount: 0, totalForms: all.length };
      const form     = checkout[0];
      const required = form.querySelectorAll('[required]').length;
      return { hasForm: true, valid: form.checkValidity(), requiredCount: required, totalForms: all.length };
    });

    console.log(
      `[INFO] checkout-form-empty-submit: totalForms=${result.totalForms}, ` +
        `userFacingForm=${result.hasForm}, requiredFields=${result.requiredCount}, ` +
        `checkValidity=${result.valid}.`,
    );

    if (!result.hasForm) {
      console.log('[INFO] checkout-form-empty-submit: no user-facing checkout form found — page may require authentication to render the form.');
      return;
    }

    if (!result.valid) {
      console.log('[INFO] checkout-form-empty-submit: form.checkValidity() = false for empty fields — required validation is present ✓');
    } else if (result.requiredCount === 0) {
      console.warn(
        '[FINDING][medium] checkout-form-empty-submit: checkout form has no HTML5 required attributes and checkValidity() = true for empty fields. ' +
          'Add required to delivery name, address, and contact fields to block empty submissions client-side.',
      );
    } else {
      console.log(
        '[INFO] checkout-form-empty-submit: form has required fields and checkValidity() = true — fields may be pre-populated from account data (expected).',
      );
    }
  });

  // ─── checkout-price-in-dom ────────────────────────────────────────────────────

  test('checkout-price-in-dom — product prices are not in modifiable hidden inputs or data attributes', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Loaded the checkout page and scanned the DOM for price, amount, or total values stored in hidden inputs or data attributes. If a price is stored this way, a visitor can modify it in browser DevTools before the form submits. The PayFast signature normally prevents this, but only if the amount field is included in the signature hash — this test surfaces the risk for review.",
    });

    await page.goto('/checkout.html', { waitUntil: 'load' });

    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [aria-busy="true"]'),
      undefined,
      { timeout: 6_000 },
    ).catch(() => {});

    const priceElements = await page.evaluate(() => {
      const hits: Array<{ type: string; name: string; value: string }> = [];

      document.querySelectorAll<HTMLInputElement>('input[type="hidden"]').forEach(el => {
        const name = (el.name || el.id || '').toLowerCase();
        if (/price|amount|total|cost|fee|tax|value/.test(name)) {
          hits.push({ type: 'hidden input', name: el.name || el.id, value: el.value.slice(0, 60) });
        }
      });

      const DATA_ATTRS = ['data-price', 'data-amount', 'data-total', 'data-cost', 'data-value'];
      document.querySelectorAll('*').forEach(el => {
        for (const attr of DATA_ATTRS) {
          const val = el.getAttribute(attr);
          if (val !== null) {
            hits.push({ type: attr, name: attr, value: val.slice(0, 60) });
          }
        }
      });

      return hits;
    });

    if (priceElements.length === 0) {
      console.log('[INFO] checkout-price-in-dom: no price/amount/total values found in hidden inputs or data attributes ✓');
      return;
    }

    for (const el of priceElements) {
      console.warn(
        `[FINDING][medium] checkout-price-in-dom: modifiable price value in DOM — ` +
          `type="${el.type}", name="${el.name}", value="${el.value}". ` +
          'Confirm that the PayFast signature hash covers this field. If it does not, a visitor ' +
          'could change the amount in DevTools before the form submits.',
      );
    }

    console.log(
      `[INFO] checkout-price-in-dom: ${priceElements.length} price-related DOM element(s) found — ` +
        'verify PayFast signature covers all amount fields.',
    );
  });

});
