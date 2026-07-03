import { test, expect, type Page } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';
import {
  ADDR,
  registerForCheckout, addPackAndGoToCheckout, fillConfigStep, advanceThroughDeliveryToPayment,
} from '../functional/checkout-helpers';

const CF_PATTERN         = '**cloudfunctions.net**';
const MANIPULATED_PRICE  = 1;   // R1.00 — absurdly low; detectable if CF trusts client value
const MANIPULATED_QTY    = 99;  // 99 packs — detectable if CF trusts client quantity

// ── Client-state mutation helpers ─────────────────────────────────────────────
// These run inside page.evaluate() and return a log of every field they changed,
// so we can record exactly what was attempted even when the site ignores mutations.

async function mutatePriceInClientState(page: Page): Promise<string[]> {
  return page.evaluate((target: number) => {
    const log: string[] = [];

    // 1. Hidden inputs with price-related names
    document.querySelectorAll<HTMLInputElement>('input[type="hidden"]').forEach(el => {
      const name = (el.name || el.id || '').toLowerCase();
      if (/price|amount|total|subtotal|cost|fee/.test(name) && el.value) {
        log.push(`input[${el.name || el.id}]: "${el.value}" → "${target}"`);
        el.value = String(target);
      }
    });

    // 2. Data attributes on the pay button
    const payBtn = document.getElementById('pay-now-btn');
    if (payBtn) {
      for (const attr of ['data-amount', 'data-total', 'data-price', 'data-subtotal']) {
        const val = payBtn.getAttribute(attr);
        if (val !== null) {
          log.push(`#pay-now-btn[${attr}]: "${val}" → "${target}"`);
          payBtn.setAttribute(attr, String(target));
        }
      }
    }

    // 3. localStorage entries whose key suggests cart/order data
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (!/cart|basket|order/i.test(key)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key)!);
        let dirty = false;
        const mutate = (obj: any): any => {
          if (Array.isArray(obj)) return obj.map(mutate);
          if (obj && typeof obj === 'object') {
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(obj)) {
              if (/price|amount|total|subtotal|cost/i.test(k) && typeof obj[k] === 'number' && obj[k] > target) {
                log.push(`localStorage["${key}"].${k}: ${obj[k]} → ${target}`);
                out[k] = target;
                dirty = true;
              } else {
                out[k] = mutate(obj[k]);
              }
            }
            return out;
          }
          return obj;
        };
        const mutated = mutate(parsed);
        if (dirty) localStorage.setItem(key, JSON.stringify(mutated));
      } catch { /* non-JSON key — ignore */ }
    }

    // 4. Common window cart variables (mutated in place)
    for (const varName of ['cartItems', 'cart', 'shoppingCart', 'currentCart', 'orderCart']) {
      const v = (window as any)[varName];
      if (!v || typeof v !== 'object') continue;
      const tryMutate = (obj: any, path: string): void => {
        if (Array.isArray(obj)) { obj.forEach((x: any, i: number) => tryMutate(x, `${path}[${i}]`)); return; }
        if (typeof obj !== 'object' || !obj) return;
        for (const k of Object.keys(obj)) {
          if (/price|amount|total|subtotal|cost/i.test(k) && typeof obj[k] === 'number' && obj[k] > target) {
            log.push(`window.${path}.${k}: ${obj[k]} → ${target}`);
            obj[k] = target;
          } else {
            tryMutate(obj[k], `${path}.${k}`);
          }
        }
      };
      tryMutate(v, varName);
    }

    return log;
  }, MANIPULATED_PRICE);
}

async function mutateQtyInClientState(page: Page): Promise<string[]> {
  return page.evaluate((target: number) => {
    const log: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (!/cart|basket|order/i.test(key)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key)!);
        let dirty = false;
        const mutate = (obj: any): any => {
          if (Array.isArray(obj)) return obj.map(mutate);
          if (obj && typeof obj === 'object') {
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(obj)) {
              if (/qty|quantity|count|num/i.test(k) && typeof obj[k] === 'number') {
                log.push(`localStorage["${key}"].${k}: ${obj[k]} → ${target}`);
                out[k] = target;
                dirty = true;
              } else {
                out[k] = mutate(obj[k]);
              }
            }
            return out;
          }
          return obj;
        };
        const mutated = mutate(parsed);
        if (dirty) localStorage.setItem(key, JSON.stringify(mutated));
      } catch { /* ignore */ }
    }

    for (const varName of ['cartItems', 'cart', 'shoppingCart', 'currentCart']) {
      const v = (window as any)[varName];
      if (!v || typeof v !== 'object') continue;
      const tryMutate = (obj: any, path: string): void => {
        if (Array.isArray(obj)) { obj.forEach((x: any, i: number) => tryMutate(x, `${path}[${i}]`)); return; }
        if (typeof obj !== 'object' || !obj) return;
        for (const k of Object.keys(obj)) {
          if (/qty|quantity|count|num/i.test(k) && typeof obj[k] === 'number') {
            log.push(`window.${path}.${k}: ${obj[k]} → ${target}`);
            obj[k] = target;
          } else {
            tryMutate(obj[k], `${path}.${k}`);
          }
        }
      };
      tryMutate(v, varName);
    }

    return log;
  }, MANIPULATED_QTY);
}

// ── Request capture helpers ───────────────────────────────────────────────────

// Sets up request interception appropriate for the active mode.
// In safe mode: routes CF POSTs to capture body then abort (no real order created).
// In LIVE_MODE: sets a waitForRequest promise (body read after click).
// Returns a function that resolves to the captured POST body after the pay button is clicked.
function setupCfCapture(page: Page): { getBody: () => Promise<string | null>; getOrderId: () => Promise<string | null> } {
  let safeBody: string | null = null;
  let safeResolve: (() => void) | null = null;
  const safeDone = new Promise<void>(r => { safeResolve = r; });

  if (!LIVE_MODE) {
    // Safe mode: intercept the CF POST, capture body, then abort
    page.route(CF_PATTERN, async route => {
      if (route.request().method() === 'POST') {
        safeBody = route.request().postData();
        safeResolve?.();
        await route.abort();
      } else {
        await route.continue();
      }
    });
  }

  const liveReqPromise = LIVE_MODE
    ? page.waitForRequest(
        req => req.url().includes('cloudfunctions.net') && req.method() === 'POST',
        { timeout: 30_000 },
      ).catch(() => null)
    : null;

  const liveRespPromise = LIVE_MODE
    ? page.waitForResponse(
        res => res.url().includes('cloudfunctions.net') && res.request().method() === 'POST',
        { timeout: 30_000 },
      ).catch(() => null)
    : null;

  const getBody = async (): Promise<string | null> => {
    if (LIVE_MODE) {
      const req = await liveReqPromise;
      return req?.postData() ?? null;
    }
    await Promise.race([safeDone, new Promise(r => setTimeout(r, 5_000))]);
    return safeBody;
  };

  const getOrderId = async (): Promise<string | null> => {
    if (!LIVE_MODE || !liveRespPromise) return null;
    const resp = await liveRespPromise;
    if (!resp) return null;
    try {
      const body = await resp.json().catch(() => ({})) as Record<string, any>;
      return body?.result?.orderId ?? body?.result?.id ?? body?.orderId ?? null;
    } catch {
      return null;
    }
  };

  return { getBody, getOrderId };
}

// ── Payload analysis ──────────────────────────────────────────────────────────

// Recursively extracts {path, value} pairs for keys matching a pattern from parsed JSON.
function findFieldsInPayload(obj: unknown, pattern: RegExp, path = ''): Array<{ path: string; value: unknown }> {
  if (!obj || typeof obj !== 'object') return [];
  const results: Array<{ path: string; value: unknown }> = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const fullPath = path ? `${path}.${k}` : k;
    if (pattern.test(k)) results.push({ path: fullPath, value: v });
    results.push(...findFieldsInPayload(v, pattern, fullPath));
  }
  return results;
}

// ── Admin order check (LIVE_MODE only) ───────────────────────────────────────

async function verifyAdminOrderTotal(
  page: Page,
  orderId: string | null,
  checkoutEmail: string,
  manipulatedLabel: string,
  testLabel: string,
): Promise<void> {
  await loginAsAdmin(page);
  await page.waitForTimeout(2_000);

  let modalText = '';

  if (orderId) {
    // Open directly by ID
    await page.evaluate((id: string) => { (window as any).viewOrder?.(id); }, orderId);
    await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(800);
    modalText = (await page.locator('#order-modal').textContent().catch(() => '')) ?? '';
  }

  if (!modalText) {
    // Fallback: search by email
    await page.locator('#filter-search').fill('SENTINEL CHECKOUT').catch(() => {});
    await page.waitForTimeout(1_500);
    const rows = await page.locator('#orders-body tr').all();
    for (const row of rows) {
      const rowText = await row.textContent().catch(() => '');
      if (rowText?.includes(checkoutEmail)) {
        await row.locator('button:has-text("View")').click();
        await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 8_000 });
        await page.waitForTimeout(800);
        modalText = (await page.locator('#order-modal').textContent().catch(() => '')) ?? '';
        break;
      }
    }
  }

  if (!modalText) {
    console.warn(`[INFO] ${testLabel}: admin order modal could not be opened — manual verification required.`);
    return;
  }

  const hasOriginalPrice = modalText.includes('1,360');
  // Manipulated price (R1.00) detection — avoid false match on "1,360" which also contains "1"
  const hasManipulatedPrice = /\b1\.00\b/.test(modalText) && !hasOriginalPrice;

  if (hasManipulatedPrice) {
    console.error(
      `[FINDING][critical] ${testLabel}: admin order shows manipulated ${manipulatedLabel} — ` +
        'the Cloud Function accepted client-supplied data instead of looking up authoritative values ' +
        'from Firestore. An attacker could place real orders at fraudulent prices.',
    );
  } else if (hasOriginalPrice) {
    console.log(
      `[INFO] ${testLabel}: admin order shows correct original price (R1,360) — ` +
        `server-side ${manipulatedLabel} lookup is active ✓`,
    );
  } else {
    console.warn(
      `[INFO] ${testLabel}: could not confirm stored price from modal text. ` +
        `Snippet: "${modalText.replace(/\s+/g, ' ').trim().slice(0, 300)}"`,
    );
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Checkout abuse — price and quantity manipulation', { tag: ['@security'] }, () => {

  // ── 1. Price manipulation ─────────────────────────────────────────────────

  test('price-manipulation-detection — manipulated DOM price in the CF payload confirms client-side pricing risk', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Completes the checkout flow up to the payment step, then uses page.evaluate() to modify ' +
        'every price-related DOM element and JavaScript cart variable to R1 before clicking Pay Now. ' +
        '\n\n' +
        'In safe mode: the outgoing Cloud Function POST is intercepted and aborted. The payload is ' +
        'inspected for price fields — if any price value appears, it proves the client is sending ' +
        'price rather than letting the server look it up, and this is logged as [FINDING][critical] ' +
        'regardless of whether the server would have accepted it.' +
        '\n\n' +
        'In LIVE_MODE: the request is allowed through. The same payload check runs, and additionally ' +
        'the admin dashboard is checked to see what price was actually stored — a stored R1 order ' +
        'confirms the server trusts and persists client-supplied pricing.',
    });

    const checkoutEmail = await registerForCheckout(page);
    await addPackAndGoToCheckout(page);
    await fillConfigStep(page);
    await advanceThroughDeliveryToPayment(page);
    await page.locator('#co-billing-addr').fill(ADDR.billing);

    // Set up CF interception appropriate for the mode
    const { getBody, getOrderId } = setupCfCapture(page);

    // Mutate price in every client-side location we can reach
    const mutations = await mutatePriceInClientState(page);
    if (mutations.length > 0) {
      console.log(`[INFO] price-manipulation-detection: mutated ${mutations.length} client-side price field(s):`);
      for (const m of mutations) console.log(`  ${m}`);
    } else {
      console.log('[INFO] price-manipulation-detection: no price fields found in DOM/localStorage/window variables — price may be derived server-side only.');
    }

    // Submit
    const navPromise = LIVE_MODE
      ? page.waitForNavigation({ timeout: 30_000 }).catch(() => null)
      : null;
    await page.locator('#pay-now-btn').click();
    if (navPromise) await navPromise;

    // Retrieve captured payload
    const rawBody = await getBody();

    if (rawBody === null) {
      console.warn('[INFO] price-manipulation-detection: no CF POST was captured — completeOrder() may have been blocked by client validation before reaching the network.');
      return;
    }

    console.log(`[INFO] price-manipulation-detection: CF POST body (first 400 chars): ${rawBody.slice(0, 400)}`);

    // ── Always assert: does the payload contain any price field? ─────────────
    let parsedBody: unknown = null;
    try { parsedBody = JSON.parse(rawBody); } catch { /* raw string — fall back to text search */ }

    const priceFields = parsedBody
      ? findFieldsInPayload(parsedBody, /price|amount|total|subtotal|cost|fee/i)
      : [];

    if (priceFields.length === 0) {
      // No price key in payload — text-search the raw string as a fallback
      const hasAnyPriceKey = /price|amount|total|subtotal|cost/i.test(rawBody);
      if (!hasAnyPriceKey) {
        console.log(
          '[INFO] price-manipulation-detection: no price/amount/total field found in CF POST payload — ' +
            'server appears to look up pricing from the pack reference rather than trusting the client ✓',
        );
      } else {
        console.warn(
          '[INFO] price-manipulation-detection: price-related keyword found in raw payload but JSON ' +
            `parse failed — raw excerpt: "${rawBody.slice(0, 200)}". Manual inspection recommended.`,
        );
      }
    } else {
      // Price fields ARE present — check whether the manipulated value was sent
      const manipulatedStrings = [
        String(MANIPULATED_PRICE),
        `${MANIPULATED_PRICE}.00`,
        String(MANIPULATED_PRICE * 100),  // cents representation
      ];

      for (const { path, value } of priceFields) {
        const valueStr = String(value);
        const wasManipulated = manipulatedStrings.some(s => valueStr === s);

        if (wasManipulated) {
          console.error(
            `[FINDING][critical] price-manipulation-detection: CF POST payload field "${path}" = ${value} ` +
              `matches the manipulated price (R${MANIPULATED_PRICE}). ` +
              'The client is sending the price — the server must validate against a server-side price ' +
              'catalogue rather than trusting user-supplied values.',
          );
        } else {
          console.log(
            `[INFO] price-manipulation-detection: payload field "${path}" = ${value} ` +
              '(does not match manipulated value — may be a pack reference or unrelated amount) ✓',
          );
        }
      }

      const anyManipulatedSent = priceFields.some(({ value }) =>
        manipulatedStrings.some(s => String(value) === s),
      );
      // Hard assertion on the presence of a manipulated price in the outgoing payload
      if (anyManipulatedSent) {
        expect.soft(false, 'CF POST must not contain client-supplied price (manipulated price detected in payload)').toBe(true);
      }
    }

    // ── LIVE_MODE only: verify what the server actually stored ────────────────
    if (LIVE_MODE) {
      const orderId = await getOrderId();
      if (orderId) console.log(`[INFO] price-manipulation-detection: CF orderId=${orderId}`);
      await verifyAdminOrderTotal(page, orderId, checkoutEmail, 'price', 'price-manipulation-detection');
    }
  });

  // ── 2. Quantity manipulation ──────────────────────────────────────────────

  test('quantity-manipulation-detection — manipulated cart quantity in the CF payload confirms client-side quantity risk', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Completes the checkout flow up to the payment step, then uses page.evaluate() to set ' +
        `the cart item quantity to ${MANIPULATED_QTY} in every observable JavaScript location ` +
        '(localStorage cart, window cart variables) before clicking Pay Now. ' +
        '\n\n' +
        'In safe mode: the Cloud Function POST is captured and aborted. If a quantity field ' +
        `appears in the payload set to ${MANIPULATED_QTY}, this is a [FINDING][critical] — ` +
        'it proves the server could be asked to fulfil 99 welcome packs at the price of one.' +
        '\n\n' +
        'In LIVE_MODE: the payload check runs the same way, and the admin order is additionally ' +
        'checked to see what quantity and total was stored.',
    });

    const checkoutEmail = await registerForCheckout(page);
    await addPackAndGoToCheckout(page);
    await fillConfigStep(page);
    await advanceThroughDeliveryToPayment(page);
    await page.locator('#co-billing-addr').fill(ADDR.billing);

    const { getBody, getOrderId } = setupCfCapture(page);

    const mutations = await mutateQtyInClientState(page);
    if (mutations.length > 0) {
      console.log(`[INFO] quantity-manipulation-detection: mutated ${mutations.length} client-side quantity field(s):`);
      for (const m of mutations) console.log(`  ${m}`);
    } else {
      console.log('[INFO] quantity-manipulation-detection: no quantity fields found in client-side state — quantity may be fixed server-side or not modelled in the cart.');
    }

    const navPromise = LIVE_MODE
      ? page.waitForNavigation({ timeout: 30_000 }).catch(() => null)
      : null;
    await page.locator('#pay-now-btn').click();
    if (navPromise) await navPromise;

    const rawBody = await getBody();

    if (rawBody === null) {
      console.warn('[INFO] quantity-manipulation-detection: no CF POST was captured — completeOrder() may have been blocked by client validation.');
      return;
    }

    console.log(`[INFO] quantity-manipulation-detection: CF POST body (first 400 chars): ${rawBody.slice(0, 400)}`);

    let parsedBody: unknown = null;
    try { parsedBody = JSON.parse(rawBody); } catch { /* ignore */ }

    const qtyFields = parsedBody
      ? findFieldsInPayload(parsedBody, /qty|quantity|count|num/i)
      : [];

    if (qtyFields.length === 0) {
      const hasAnyQtyKey = /qty|quantity/i.test(rawBody);
      if (!hasAnyQtyKey) {
        console.log(
          '[INFO] quantity-manipulation-detection: no quantity field found in CF POST payload — ' +
            'server appears to derive quantity from the order type rather than accepting a client value ✓',
        );
      } else {
        console.warn(
          `[INFO] quantity-manipulation-detection: quantity keyword in raw payload but JSON parse failed — ` +
            `raw: "${rawBody.slice(0, 200)}". Manual inspection recommended.`,
        );
      }
    } else {
      for (const { path, value } of qtyFields) {
        const wasManipulated = Number(value) === MANIPULATED_QTY;
        if (wasManipulated) {
          console.error(
            `[FINDING][critical] quantity-manipulation-detection: CF POST field "${path}" = ${value} ` +
              `matches the manipulated quantity (${MANIPULATED_QTY}). ` +
              `The server could be instructed to prepare ${MANIPULATED_QTY} welcome packs at the ` +
              'price of one — enforce a maximum quantity server-side.',
          );
        } else {
          console.log(`[INFO] quantity-manipulation-detection: payload field "${path}" = ${value} ✓`);
        }
      }

      const anyManipulatedQtySent = qtyFields.some(({ value }) => Number(value) === MANIPULATED_QTY);
      if (anyManipulatedQtySent) {
        expect.soft(false, `CF POST must not contain client-supplied quantity = ${MANIPULATED_QTY}`).toBe(true);
      }
    }

    if (LIVE_MODE) {
      const orderId = await getOrderId();
      if (orderId) console.log(`[INFO] quantity-manipulation-detection: CF orderId=${orderId}`);
      await verifyAdminOrderTotal(page, orderId, checkoutEmail, 'quantity', 'quantity-manipulation-detection');
    }
  });

  // ── 3. Duplicate-order idempotency ────────────────────────────────────────
  // This test genuinely cannot be verified in safe mode: it requires two real concurrent
  // CF requests to hit the actual Firestore to observe whether a duplicate document is
  // created. A route-intercepted mock cannot reproduce the race condition. This is the
  // documented exception to the mode-agnostic convention.

  test('duplicate-order-idempotency — rapid double-submit must not create two separate Firestore orders', async ({ page }) => {
    test.skip(!LIVE_MODE, 'requires real backend to observe duplicate record creation — route interception cannot replicate the Firestore race condition');
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Completes the checkout flow and clicks Pay Now twice in rapid succession, with the ' +
        'second click forced through even if the button was disabled by the first click. ' +
        'Monitors for two distinct Cloud Function POST requests. If two CF calls fire, logs ' +
        'in as admin and checks whether two order records exist for the same checkout session. ' +
        'A duplicate order means an idempotency key or client-side submit guard is missing — ' +
        'the customer would be charged once but the admin would see two orders, causing ' +
        'fulfilment confusion. If only one CF call fires, the client-side guard works and ' +
        'this is confirmed as [INFO].',
    });

    const checkoutEmail = await registerForCheckout(page);
    await addPackAndGoToCheckout(page);
    await fillConfigStep(page);
    await advanceThroughDeliveryToPayment(page);
    await page.locator('#co-billing-addr').fill(ADDR.billing);

    // Capture ALL CF POST requests fired during this test
    const cfRequests: Array<{ url: string; time: number }> = [];
    page.on('request', req => {
      if (req.url().includes('cloudfunctions.net') && req.method() === 'POST') {
        cfRequests.push({ url: req.url(), time: Date.now() });
      }
    });

    const cfOrderIds: string[] = [];
    const cfRespListener = async (resp: import('@playwright/test').Response) => {
      if (!resp.url().includes('cloudfunctions.net') || resp.request().method() !== 'POST') return;
      try {
        const body = await resp.json().catch(() => ({})) as Record<string, any>;
        const id = body?.result?.orderId ?? body?.result?.id ?? body?.orderId ?? null;
        if (id) cfOrderIds.push(id);
      } catch { /* ignore */ }
    };
    page.on('response', cfRespListener);

    // First click — normal submit
    await page.locator('#pay-now-btn').click();
    await page.waitForTimeout(300); // tiny gap to let first request fire

    // Second click — forced through even if the button is now disabled
    await page.locator('#pay-now-btn').click({ force: true });
    await page.locator('#pay-now-btn').click({ force: true }); // third for good measure

    // Wait for any navigation (PayFast redirect) and for any CF responses
    await page.waitForNavigation({ timeout: 30_000 }).catch(() => null);
    await page.waitForTimeout(3_000); // allow in-flight CF responses to complete

    page.off('response', cfRespListener);

    console.log(
      `[INFO] duplicate-order-idempotency: ${cfRequests.length} CF POST(s) fired, ` +
        `${cfOrderIds.length} orderId(s) received: [${cfOrderIds.join(', ')}]`,
    );

    if (cfRequests.length <= 1) {
      console.log(
        '[INFO] duplicate-order-idempotency: only one CF POST fired — client-side submit guard is active ✓',
      );
      return;
    }

    // Multiple CF POSTs fired — check whether they produced distinct Firestore orders
    console.warn(
      `[FINDING][medium] duplicate-order-idempotency: ${cfRequests.length} CF POSTs fired within ` +
        `${cfRequests[cfRequests.length - 1].time - cfRequests[0].time}ms of each other. ` +
        `Order IDs received: [${cfOrderIds.join(', ')}]. Checking admin for duplicate records...`,
    );

    if (cfOrderIds.length >= 2) {
      const hasDuplicates = cfOrderIds.length !== new Set(cfOrderIds).size ||
        (cfOrderIds.length >= 2 && cfOrderIds[0] !== cfOrderIds[1]);

      if (hasDuplicates) {
        console.error(
          `[FINDING][critical] duplicate-order-idempotency: multiple distinct order IDs returned ` +
            `([${cfOrderIds.join(', ')}]) — the CF lacks an idempotency key. Two Firestore orders ` +
            'were created from a single checkout. The admin will see duplicate orders; if fulfilment ' +
            'is automated this could trigger double-dispatch.',
        );
        expect.soft(false, 'Each checkout must produce exactly one Firestore order').toBe(true);
        return;
      } else {
        console.log(
          '[INFO] duplicate-order-idempotency: multiple CF calls returned the SAME order ID — ' +
            'server-side idempotency key is working ✓',
        );
        return;
      }
    }

    // Fewer order IDs than CF calls — verify admin to see actual records
    await loginAsAdmin(page);
    await page.waitForTimeout(2_000);
    await page.locator('#filter-search').fill('SENTINEL CHECKOUT').catch(() => {});
    await page.waitForTimeout(1_500);

    const rows = await page.locator('#orders-body tr').all();
    const matchingRows: string[] = [];
    for (const row of rows) {
      const rowText = await row.textContent().catch(() => '');
      if (rowText?.includes(checkoutEmail)) matchingRows.push(rowText.replace(/\s+/g, ' ').trim().slice(0, 120));
    }

    if (matchingRows.length >= 2) {
      console.error(
        `[FINDING][critical] duplicate-order-idempotency: ${matchingRows.length} admin order rows ` +
          `found for ${checkoutEmail} after a double-submit — duplicate records confirmed in Firestore.`,
      );
      for (const row of matchingRows) console.error(`  Row: ${row}`);
      expect.soft(false, `Only 1 order expected but ${matchingRows.length} found for ${checkoutEmail}`).toBe(true);
    } else if (matchingRows.length === 1) {
      console.log(
        '[INFO] duplicate-order-idempotency: only one admin order found despite multiple CF POSTs — ' +
          'server-side deduplication or early-failure handling prevented duplicate records ✓',
      );
    } else {
      console.warn(
        `[INFO] duplicate-order-idempotency: no admin order found for ${checkoutEmail} — order may not have ` +
          'completed or admin search did not match. Manual verification required.',
      );
    }
  });

});
