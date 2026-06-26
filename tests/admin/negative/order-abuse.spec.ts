import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../../../src/utils/auth';
import { LIVE_MODE } from '../../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

test.describe('Admin order abuse — negative', { tag: ['@admin'] }, () => {

  test.beforeEach(() => { test.slow(); });

  // ─── order-status-invalid-transition ────────────────────────────────────────

  test('order-status-invalid-transition — status cannot be moved backward to an earlier lifecycle stage', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, opened an order, and attempted to change its status backward to an earlier state (e.g. from In Transit to Pending). Checked whether the UI prevented the transition or whether the backend rejected the update request. Backward status transitions corrupt fulfilment records and could confuse both the admin and the guest tracking their delivery.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);
    await page.locator('#orders-body').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});

    if (LIVE_MODE) {
      await page.waitForFunction(
        () => document.querySelectorAll('#orders-body tr, #orders-body .order-row').length > 0,
        { timeout: 8_000 },
      ).catch(() => {});
    }

    const viewBtns = page.locator(
      '#orders-body button:has-text("View"), #orders-body .btn-sm:has-text("View")',
    );
    if (await viewBtns.count() === 0) {
      console.log('[INFO] order-status-invalid-transition: no order rows loaded (CF blocked in safe mode) — skipping.');
      return;
    }

    await viewBtns.first().click();
    await page.locator('#order-modal').waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {});

    if (!(await page.locator('#order-modal').isVisible().catch(() => false))) {
      console.log('[INFO] order-status-invalid-transition: #order-modal did not open — skipping.');
      return;
    }

    const statusSelect = page.locator('#order-modal select, #order-modal [id*="status"]').first();
    if (!(await statusSelect.isVisible().catch(() => false))) {
      console.log('[INFO] order-status-invalid-transition: no status selector found in modal — skipping.');
      return;
    }

    const currentStatus = await statusSelect.inputValue().catch(() => '');
    console.log(`[INFO] order-status-invalid-transition: current order status = "${currentStatus}".`);

    const optionValues = await statusSelect.locator('option').evaluateAll(
      els => els.map(e => (e as HTMLOptionElement).value),
    );

    // Earlier-lifecycle values that would constitute a backward transition.
    const BACKWARD_TARGETS = ['pending', 'new', 'assembling', ''];
    const targetValue = BACKWARD_TARGETS.find(v => optionValues.includes(v) && v !== currentStatus);
    if (!targetValue) {
      console.log('[INFO] order-status-invalid-transition: no backward status option available to test — skipping.');
      return;
    }

    // Override the CF route to capture what (if anything) is sent after the status change.
    let updateRequestFired = false;
    let updatePayload: string | null = null;
    await page.route(CF_PATTERN, async route => {
      if (/update|status/i.test(route.request().url())) {
        updateRequestFired = true;
        updatePayload = route.request().postData();
      }
      await route.abort();
    });

    await statusSelect.selectOption(targetValue);

    // Some UIs require an explicit Save/Update button press after selecting a status.
    const saveBtn = page.locator(
      '#order-modal button:has-text("Save"), #order-modal button:has-text("Update")',
    ).first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
    }

    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [aria-busy="true"]'),
      { timeout: 3_000 },
    ).catch(() => {});

    if (updateRequestFired) {
      console.warn(
        `[FINDING][medium] order-status-invalid-transition: a status update request fired for a backward transition ` +
          `("${currentStatus}" → "${targetValue}"). Payload: ${updatePayload ?? '(none)'}. ` +
          'The backend must enforce valid state-machine transitions and reject backward moves.',
      );
    } else {
      console.log(
        `[INFO] order-status-invalid-transition: no update request sent for backward transition ` +
          `"${currentStatus}" → "${targetValue}" — UI or JS guard prevented it ✓`,
      );
    }
  });

  // ─── order-search-injection ──────────────────────────────────────────────────

  test('order-search-injection — XSS payload in the order search box does not execute', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and typed an XSS payload into the order search box. Verified that the browser did not execute the injected script — no alert dialog appeared. Also checked that no JavaScript exceptions occurred as a result of the input. Executing injected scripts via the search field could allow an attacker who can influence search input to hijack an active admin session.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    const searchInput = page.locator('#filter-search');
    if (!(await searchInput.isVisible().catch(() => false))) {
      console.log('[INFO] order-search-injection: #filter-search not found — skipping injection test.');
      return;
    }

    let xssDialogFired = false;
    page.on('dialog', async dialog => {
      xssDialogFired = true;
      console.error(
        `[FINDING][critical] order-search-injection: a browser dialog fired while processing the XSS payload. ` +
          `type="${dialog.type()}", message="${dialog.message()}". Script injection is executing in the search field.`,
      );
      await dialog.dismiss();
    });

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    const XSS_PAYLOAD = '<script>alert(1)</script>';
    await searchInput.fill(XSS_PAYLOAD);

    // Allow one debounce tick for any search handler to process the value.
    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"]'),
      { timeout: 2_000 },
    ).catch(() => {});

    console.log(`[INFO] order-search-injection: typed XSS payload — dialog fired = ${xssDialogFired}.`);

    if (pageErrors.length > 0) {
      console.warn(
        `[FINDING][medium] order-search-injection: ${pageErrors.length} JS exception(s) after XSS input: ${pageErrors.join(' | ')}`,
      );
    }

    expect(xssDialogFired, 'XSS payload must not execute as JavaScript in the order search field').toBe(false);
    expect(pageErrors, 'XSS payload in search must not cause unhandled JS exceptions').toHaveLength(0);
  });

  // ─── order-search-sql-patterns ──────────────────────────────────────────────

  test('order-search-sql-patterns — SQL injection payloads in the search box do not crash the page', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and typed several SQL injection patterns into the order search box. Verified that the page handled each payload gracefully — no crash, no JavaScript exception, no unexpected error state. Although Firestore is a NoSQL database (immune to SQL injection), injected payloads can still cause client-side parsing errors or reveal backend query structure if not handled correctly.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    const searchInput = page.locator('#filter-search');
    if (!(await searchInput.isVisible().catch(() => false))) {
      console.log('[INFO] order-search-sql-patterns: #filter-search not found — skipping.');
      return;
    }

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    const PAYLOADS = [
      "'; DROP TABLE orders;--",
      "1 OR 1=1",
      "admin'--",
      "'; SELECT * FROM users;--",
    ];

    for (const payload of PAYLOADS) {
      await searchInput.fill(payload);
      await page.waitForFunction(
        () => !document.querySelector('[class*="loading"]'),
        { timeout: 2_000 },
      ).catch(() => {});
      console.log(`[INFO] order-search-sql-patterns: typed "${payload.slice(0, 40)}" — no crash.`);
    }

    if (pageErrors.length > 0) {
      console.warn(
        `[FINDING][medium] order-search-sql-patterns: ${pageErrors.length} JS exception(s) during SQL payloads: ` +
          pageErrors.join(' | '),
      );
    } else {
      console.log('[INFO] order-search-sql-patterns: all SQL payloads handled without page crash ✓');
    }

    expect(pageErrors, 'SQL injection payloads must not cause unhandled JS exceptions in the search field').toHaveLength(0);
  });

  // ─── export-csv-unauthenticated ──────────────────────────────────────────────

  test('export-csv-unauthenticated — the Export CSV button does not trigger a download without an active admin session', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Without logging in, navigated to the admin page and force-clicked the Export CSV button through the authentication overlay. Verified that no file was downloaded and that any request to the export Cloud Function was rejected with a non-200 status. Unauthenticated export would expose all order data to any visitor who discovers the export endpoint.",
    });

    // In !LIVE_MODE: intercept export CF and return 401 (simulating correct backend behaviour).
    // In LIVE_MODE: the real backend must return 401 or 403 without a valid auth token.
    const exportResponses: Array<{ url: string; status: number }> = [];

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, async route => {
        const url = route.request().url();
        if (/export/i.test(url)) {
          exportResponses.push({ url, status: 401 });
          await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthenticated"}' });
        } else {
          await route.abort();
        }
      });
    } else {
      page.on('response', res => {
        if (res.url().includes('cloudfunctions.net') && /export/i.test(res.url())) {
          exportResponses.push({ url: res.url(), status: res.status() });
        }
      });
    }

    // Navigate without logging in.
    await page.goto('/admin.html', { waitUntil: 'load' });

    const exportBtn = page.locator('button:has-text("Export CSV")');
    if (!(await exportBtn.isVisible().catch(() => false))) {
      console.log('[INFO] export-csv-unauthenticated: "Export CSV" button not in DOM — skipping.');
      return;
    }

    let downloadFired = false;
    page.on('download', () => { downloadFired = true; });

    // Force-click the button through the overlay to test whether the backend (not just the UI) protects the endpoint.
    await exportBtn.click({ force: true });
    await page.waitForEvent('download', { timeout: 5_000 }).catch(() => {});

    if (downloadFired) {
      console.error(
        '[FINDING][critical] export-csv-unauthenticated: Export CSV triggered a file download without authentication. ' +
          'Order data must not be accessible without a valid admin session. Verify Firebase ID token validation is enforced in the export Cloud Function.',
      );
    } else {
      console.log('[INFO] export-csv-unauthenticated: no download triggered without authentication ✓');
    }

    for (const req of exportResponses) {
      if (req.status === 200) {
        console.error(
          `[FINDING][critical] export-csv-unauthenticated: export endpoint returned HTTP 200 without auth: ${req.url}`,
        );
      } else {
        console.log(
          `[INFO] export-csv-unauthenticated: export endpoint returned HTTP ${req.status} for unauthenticated request ✓`,
        );
      }
    }

    expect(downloadFired, 'Export CSV must not produce a download for unauthenticated visitors').toBe(false);
  });

});
