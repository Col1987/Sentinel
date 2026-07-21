import { test, expect, type Page } from '@playwright/test';
import { LIVE_MODE } from '../../src/config/sites';
import { loginAsAdmin } from '../../src/utils/auth';
import {
  ADDR, PACK_ID,
  registerForCheckout, addPackAndGoToCheckout, fillConfigStep, advanceThroughDeliveryToPayment,
} from '../functional/checkout-helpers';
import { waitForOrdersTableToSettle } from '../functional/order-lifecycle-helpers';

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

// Mutates the last character of an order ID so the resulting ID is invalid in Firestore.
// The 20-char random alphanumeric space makes a collision with a real order negligible.
function modifyOrderId(id: string): string {
  if (!id || id.length < 2) return `${id}X`;
  const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const last  = id[id.length - 1];
  const pos   = CHARS.indexOf(last);
  const next  = pos >= 0 ? CHARS[(pos + 1) % CHARS.length] : 'X';
  return id.slice(0, -1) + next;
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
    // Fallback: filter down by name BEFORE scanning (#filter-search matches customer name,
    // not email — comment corrected). Requires the table's real (async-loaded) data to
    // have settled first, or the filter is a silent no-op — see waitForOrdersTableToSettle.
    await waitForOrdersTableToSettle(page);
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

    // Fewer order IDs than CF calls — verify admin to see actual records.
    // Settle-wait before filtering, same as verifyAdminOrderTotal above — #filter-search
    // is a silent no-op against the table's async-loaded placeholder data.
    await loginAsAdmin(page);
    await waitForOrdersTableToSettle(page);
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

  // ── 4. Concurrent-session cart conflict ───────────────────────────────────

  test('concurrent-session-cart-conflict — two sessions for the same account adding different packs do not corrupt each other\'s cart', async ({ page, browser }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Registers a fresh account then opens two browser contexts authenticated as the same user. ' +
        'Context A adds one pack to its cart; Context B adds a different pack. Context A then reloads ' +
        'to trigger any Firestore cart subscription. We inspect Context A\'s localStorage cart for its pack. ' +
        '\n\n' +
        'In safe mode: contexts use independent localStorage with no server sync — isolation is expected. ' +
        'In LIVE_MODE: if the app syncs cart state via Firestore, a subscription callback on reload could ' +
        'overwrite Context A\'s cart with what Context B wrote last. ' +
        'Overwrite (data loss) = [FINDING][high]. Additive merge or full isolation = [INFO] pass.',
    });

    await registerForCheckout(page);
    const storageState = await page.context().storageState();

    // Enumerate pack IDs on the homepage to find a second pack for Context B.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);

    const allPackIds = await page.evaluate((): string[] => {
      const ids = new Set<string>();
      document.querySelectorAll<HTMLElement>('[onclick*="addToCart"]').forEach(el => {
        const m = (el.getAttribute('onclick') ?? '').match(/addToCart\(['"]([^'"]+)['"]\)/);
        if (m?.[1]) ids.add(m[1]);
      });
      document.querySelectorAll<HTMLElement>('[data-pack-id]').forEach(el => {
        const id = el.getAttribute('data-pack-id');
        if (id) ids.add(id);
      });
      return [...ids];
    });

    const PACK_A   = PACK_ID;
    const PACK_B   = allPackIds.find(id => id !== PACK_A) ?? PACK_A;
    const samePack = PACK_A === PACK_B;
    console.log(
      `[INFO] concurrent-session-cart-conflict: ${allPackIds.length} pack(s) found. ` +
        `Pack A="${PACK_A}", Pack B="${PACK_B}" (${samePack ? 'same — only one available' : 'different packs'}).`,
    );

    const ctxB  = await browser.newContext({ storageState });
    const pageB = await ctxB.newPage();

    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await pageB.goto('/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1_500);
      await pageB.waitForTimeout(1_500);

      // Context A: add Pack A
      await page.evaluate((id: string) => (window as any).addToCart(id), PACK_A);
      await page.waitForTimeout(600);

      // Context B: add Pack B
      await pageB.evaluate((id: string) => (window as any).addToCart(id), PACK_B);
      await pageB.waitForTimeout(600);

      // Allow Firestore cart sync to propagate (LIVE_MODE only — safe mode has no server sync)
      if (LIVE_MODE) await page.waitForTimeout(4_000);

      // Context A reloads — triggers any Firestore subscription that might overwrite localStorage
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2_500);

      const cartARaw = await page.evaluate(() => localStorage.getItem('bh_cart') ?? '');
      const cartBRaw = await pageB.evaluate(() => localStorage.getItem('bh_cart') ?? '');

      console.log(`[INFO] concurrent-session-cart-conflict: Cart A (bh_cart): ${cartARaw.slice(0, 200) || '(empty)'}`);
      console.log(`[INFO] concurrent-session-cart-conflict: Cart B (bh_cart): ${cartBRaw.slice(0, 200) || '(empty)'}`);

      if (!samePack) {
        const cartAHasA    = cartARaw.includes(PACK_A);
        const cartAHasBOnly = !cartAHasA && cartARaw.includes(PACK_B);

        if (cartAHasBOnly) {
          console.error(
            `[FINDING][high] concurrent-session-cart-conflict: Context A's cart was silently overwritten by Context B — ` +
              `Pack A ("${PACK_A}") is gone; only Pack B ("${PACK_B}") remains. ` +
              'A Firestore cart subscription is destructively replacing local cart state across concurrent sessions ' +
              'for the same account. A guest with two browser tabs open would lose one tab\'s cart on reload.',
          );
          expect.soft(false, 'Context A cart must not be overwritten by Context B for the same account').toBe(true);
        } else if (cartAHasA && cartARaw.includes(PACK_B)) {
          console.log(
            '[INFO] concurrent-session-cart-conflict: Context A cart contains both packs after reload — ' +
              'Firestore sync performs an additive merge (no data loss) ✓',
          );
        } else if (cartAHasA) {
          console.log(
            `[INFO] concurrent-session-cart-conflict: Context A retains Pack A ("${PACK_A}") after reload ` +
              '— sessions are isolated from each other ✓',
          );
        } else if (!cartARaw) {
          console.warn(
            '[INFO] concurrent-session-cart-conflict: Context A cart is empty after reload — ' +
              'bh_cart may have been cleared by the page load cycle. Not a data-loss finding; check manually.',
          );
        } else {
          console.warn(
            `[INFO] concurrent-session-cart-conflict: Cart A content after reload: "${cartARaw.slice(0, 150)}". ` +
              `Pack A ("${PACK_A}") not detected by string match — inspect structure manually.`,
          );
        }
      } else {
        console.log(
          '[INFO] concurrent-session-cart-conflict: only one pack available — both contexts used the same pack. ' +
            `Cart A after reload: "${cartARaw.slice(0, 150) || '(empty)'}".`,
        );
      }
    } finally {
      await ctxB.close();
    }
  });

  // ── 5. Order ID enumeration ───────────────────────────────────────────────

  test('order-id-enumeration — probing the tracking page with a modified order ID must not return real customer data', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description:
        'Tests whether the order tracking page leaks customer data when given a plausible but non-existent order ID. ' +
        '\n\n' +
        'In LIVE_MODE: creates a real Firestore order via the checkout flow, captures the 20-character random ' +
        'order ID from the Cloud Function response, mutates its last character to produce an ID that cannot ' +
        'exist in Firestore, then navigates to /track.html?id=<modified>. CF and Firestore responses are ' +
        'scanned for customer PII. Any real data = [FINDING][critical]. ' +
        '\n\n' +
        'In safe mode: uses a synthetic probe ID. All Firestore and CF requests from the tracking page are ' +
        'intercepted and aborted. We confirm the page makes an outbound lookup and does not crash or display ' +
        'unexpected content when the backend is unavailable.',
    });

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    let probeId: string;

    if (LIVE_MODE) {
      // The orderId is CLIENT-GENERATED and sent in the CF POST request body as data.orderId.
      // Capturing from the request (not the response) is more reliable — the request fires
      // synchronously before any page navigation, so there is no race with the PayFast redirect.
      // IMPORTANT: set up waitForRequest AFTER advanceThroughDeliveryToPayment — a shipping-rate
      // CF call fires during that step and would otherwise be captured first.
      await registerForCheckout(page);
      await addPackAndGoToCheckout(page);
      await fillConfigStep(page);
      await advanceThroughDeliveryToPayment(page);
      await page.locator('#co-billing-addr').fill(ADDR.billing);

      const cfReqPromise = page.waitForRequest(
        req => req.url().includes('cloudfunctions.net') && req.method() === 'POST',
        { timeout: 30_000 },
      ).catch(() => null);

      const navPromise = page.waitForNavigation({ timeout: 30_000 }).catch(() => null);
      await page.locator('#pay-now-btn').click();

      // Await both so we hold the page context long enough for the request to settle
      const [cfReq] = await Promise.all([cfReqPromise, navPromise]);

      let realOrderId: string | null = null;
      if (cfReq) {
        const postData = cfReq.postData() ?? '';
        console.log(`[INFO] order-id-enumeration: CF POST request body: ${postData.slice(0, 400)}`);
        try {
          const parsed = JSON.parse(postData) as Record<string, any>;
          realOrderId = parsed?.data?.orderId ?? null;
        } catch { /* non-JSON body */ }
      } else {
        console.warn('[INFO] order-id-enumeration: waitForRequest timed out — CF POST not observed before navigation.');
      }

      if (realOrderId) {
        probeId = modifyOrderId(realOrderId);
        console.log(`[INFO] order-id-enumeration: real orderId="${realOrderId}" → probe="${probeId}"`);
      } else {
        probeId = modifyOrderId('q1VXWrGM80XUpLfbWIXR');
        console.warn(`[INFO] order-id-enumeration: orderId not captured from request — using modified synthetic "${probeId}"`);
      }
    } else {
      probeId = 'SENTINEL00000PROBE001';
      console.log(`[INFO] order-id-enumeration: safe mode — probing with synthetic ID "${probeId}"`);
    }

    // Capture outbound lookups the tracking page makes, and collect response bodies in LIVE_MODE.
    const trackingRequests: Array<{ url: string; method: string }> = [];
    const cfResponseBodies: string[] = [];

    if (!LIVE_MODE) {
      await page.route('**firestore.googleapis.com**', async route => {
        trackingRequests.push({ url: route.request().url().slice(0, 100), method: route.request().method() });
        await route.abort();
      });
      await page.route(CF_PATTERN, async route => {
        trackingRequests.push({ url: route.request().url(), method: route.request().method() });
        await route.abort();
      });
    } else {
      page.on('response', async res => {
        if (/firestore\.googleapis\.com|cloudfunctions\.net/i.test(res.url())) {
          const text = await res.text().catch(() => '');
          if (text) cfResponseBodies.push(text.slice(0, 600));
        }
      });
    }

    await page.goto(`/track.html?id=${encodeURIComponent(probeId)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4_000); // allow Firestore lookup to settle

    const bodyText   = await page.evaluate(() => document.body.innerText.toLowerCase());
    const rawHtml    = await page.content();
    const allContent = [bodyText, rawHtml, ...cfResponseBodies].join('\n');

    // ── Scan for personal data in every layer of the response ────────────────
    const LEAK_PATTERNS: Array<{ label: string; pattern: RegExp; severity: string }> = [
      { label: 'customer email address',             pattern: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i,              severity: 'critical' },
      { label: 'South African phone number',         pattern: /\b(?:\+27|0)[6-8]\d[\s-]?\d{3}[\s-]?\d{4}\b/,             severity: 'critical' },
      { label: 'delivery street address',            pattern: /\b\d+\s+\w+\s+(?:street|road|ave|drive|rd|lane|close)\b/i, severity: 'high'     },
      { label: 'firstName/lastName in JSON response', pattern: /"(?:first|last)Name"\s*:\s*"[A-Za-z]{2,}"/i,              severity: 'high'     },
    ];

    let dataLeakFound = false;
    for (const { label, pattern, severity } of LEAK_PATTERNS) {
      if (pattern.test(allContent)) {
        dataLeakFound = true;
        console.error(
          `[FINDING][${severity}] order-id-enumeration: tracking response exposes "${label}" for probe ID "${probeId}". ` +
            'The tracking endpoint must return a generic not-found response for unknown IDs without leaking any ' +
            'customer data. Verify Firestore security rules on the orders collection and any server-side lookup function.',
        );
      }
    }

    if (!dataLeakFound) {
      const GRACEFUL_SIGNALS = ['not found', 'no order', 'could not find', 'invalid', 'does not exist', 'no results'];
      const hasGraceful      = GRACEFUL_SIGNALS.some(s => bodyText.includes(s));

      if (hasGraceful) {
        console.log(
          `[INFO] order-id-enumeration: tracking page shows graceful not-found for probe ID "${probeId}" — no data leakage ✓`,
        );
      } else if (!LIVE_MODE) {
        if (trackingRequests.length > 0) {
          console.log(
            `[INFO] order-id-enumeration: safe mode — ${trackingRequests.length} Firestore/CF request(s) intercepted from tracking page. ` +
              `No customer data in DOM for probe ID "${probeId}" ✓`,
          );
        } else {
          console.warn(
            '[INFO] order-id-enumeration: safe mode — no Firestore or CF request observed from /track.html. ' +
              'The page may not query the backend when the ID is supplied via URL parameter, or uses a different pattern.',
          );
        }
      } else {
        console.warn(
          `[FINDING][low] order-id-enumeration: LIVE_MODE — tracking page shows no clear "not found" message for probe ID "${probeId}". ` +
            'Guests should receive explicit feedback when an order ID is not recognised.',
        );
      }
    }

    if (LIVE_MODE && cfResponseBodies.length > 0) {
      console.log(`[INFO] order-id-enumeration: ${cfResponseBodies.length} CF/Firestore response(s) received for probe ID.`);
    }

    if (pageErrors.length > 0) {
      console.warn(
        `[FINDING][medium] order-id-enumeration: ${pageErrors.length} JS exception(s) on tracking page with probe ID "${probeId}": ${pageErrors.join(' | ')}`,
      );
    }

    expect(dataLeakFound, 'Order tracking must not return customer data for a non-existent order ID').toBe(false);
    expect(pageErrors,    'No unhandled JS exceptions must occur on the tracking page with an unknown order ID').toHaveLength(0);
  });

});
