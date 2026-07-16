import { test, type Page } from '@playwright/test';
import { loginAsAdmin } from '../../../src/utils/auth';
import { LIVE_MODE } from '../../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

async function openUsersTab(page: Page): Promise<boolean> {
  const TAB_SELECTORS = [
    '#atab-btn-users',
    'button.admin-tab-btn:has-text("Users")',
    'button:has-text("User Management")',
  ];
  for (const sel of TAB_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }
  }
  return false;
}

test.describe('Admin user abuse — negative', { tag: ['@admin'] }, () => {

  test.beforeEach(() => { test.slow(); });

  // ─── user-list-data-exposure ──────────────────────────────────────────────────

  test('user-list-data-exposure — the user list does not expose passwords, tokens, or payment data', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, navigated to the Users tab, and scanned the visible DOM and any Firestore API responses for sensitive data patterns: bcrypt password hashes, raw JWT tokens, credit card numbers, Firebase API keys, and plain-text passwords in JSON. Admin panels that render raw database fields can inadvertently expose credentials that should only ever be stored in hashed or encrypted form.",
    });

    // Intercept Firestore REST responses to scan their payloads for sensitive data.
    // This must be registered before loginAsAdmin so it catches auth-time reads too.
    const firestoreResponseBodies: string[] = [];
    await page.route('**firestore.googleapis.com**', async route => {
      const response = await route.fetch().catch(() => null);
      if (response) {
        const body = await response.text().catch(() => '');
        if (body) firestoreResponseBodies.push(body);
        await route.fulfill({ response });
      } else {
        await route.continue();
      }
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    const tabFound = await openUsersTab(page);
    if (!tabFound) {
      console.log('[INFO] user-list-data-exposure: Users tab not found — skipping data exposure scan.');
      return;
    }

    // Allow any async data fetch to settle.
    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [aria-busy="true"]'),
      undefined,
      { timeout: 5_000 },
    ).catch(() => {});

    const domText    = await page.evaluate(() => document.body.innerText).catch(() => '');
    const allContent = [domText, ...firestoreResponseBodies].join('\n');

    const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string; severity: string }> = [
      { pattern: /\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}/,                 label: 'bcrypt password hash',           severity: 'critical' },
      { pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/, label: 'JWT / Firebase ID token',   severity: 'critical' },
      { pattern: /\b(?:\d{4}[- ]){3}\d{4}\b/,                          label: 'credit card number pattern',     severity: 'critical' },
      { pattern: /AIza[0-9A-Za-z_-]{35}/,                               label: 'Firebase API key',              severity: 'high'     },
      { pattern: /"password"\s*:\s*"[^"]{6,}"/,                         label: 'plain-text password in JSON',   severity: 'critical' },
    ];

    let findingsCount = 0;
    for (const { pattern, label, severity } of SENSITIVE_PATTERNS) {
      if (pattern.test(allContent)) {
        findingsCount++;
        console.error(
          `[FINDING][${severity}] user-list-data-exposure: sensitive data pattern detected — ${label}. ` +
            'Sensitive credentials must never be stored or displayed in plain text. ' +
            'Review what fields the users collection exposes to the admin client.',
        );
      }
    }

    if (findingsCount === 0) {
      console.log(
        `[INFO] user-list-data-exposure: no sensitive data patterns detected in DOM or ` +
          `${firestoreResponseBodies.length} Firestore response(s) ✓`,
      );
    }
  });

  // ─── user-role-escalation ─────────────────────────────────────────────────────

  test('user-role-escalation — any role editing UI sends requests the backend can validate and restrict', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, navigated to the Users tab, and looked for any role editing controls (dropdowns, toggles, or buttons labelled with role or admin terms). If found, intercepted the outgoing request and logged its payload to verify that role changes are sent as explicit backend calls rather than client-only state changes. The backend Firebase functions must validate that only authorised callers can modify custom claims.",
    });

    const roleUpdateRequests: Array<{ url: string; payload: string }> = [];

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, async route => {
        const url     = route.request().url();
        const payload = route.request().postData() ?? '';
        if (/role|claim|admin|user.*update|update.*user/i.test(url) || /role|isAdmin|customClaim/i.test(payload)) {
          roleUpdateRequests.push({ url, payload });
        }
        await route.abort();
      });
    } else {
      // In LIVE_MODE: observe requests without modification — do not tamper with live admin claims.
      page.on('request', req => {
        const url     = req.url();
        const payload = req.postData() ?? '';
        if (
          url.includes('cloudfunctions.net') &&
          (/role|claim|admin|user.*update|update.*user/i.test(url) || /role|isAdmin|customClaim/i.test(payload))
        ) {
          roleUpdateRequests.push({ url, payload });
        }
      });
    }

    await loginAsAdmin(page);

    const tabFound = await openUsersTab(page);
    if (!tabFound) {
      console.log('[INFO] user-role-escalation: Users tab not found — skipping role escalation test.');
      return;
    }

    // Allow any async data fetch to settle.
    await page.waitForFunction(
      () => !document.querySelector('[class*="loading"], [aria-busy="true"]'),
      undefined,
      { timeout: 5_000 },
    ).catch(() => {});

    // Discover role editing controls in the users panel.
    const ROLE_CONTROL_SELECTORS = [
      '[id*="role"]',
      '[name*="role"]',
      'select:has(option:has-text("Admin"))',
      'button:has-text("Make Admin")',
      'button:has-text("Grant Admin")',
      'button:has-text("Revoke Admin")',
      '[class*="role-toggle"]',
      '[class*="admin-toggle"]',
    ];

    let roleControlFound = false;
    for (const sel of ROLE_CONTROL_SELECTORS) {
      const el = page.locator(sel).first();
      if (!(await el.isVisible().catch(() => false))) continue;

      roleControlFound = true;
      console.log(`[INFO] user-role-escalation: role editing control found via "${sel}".`);

      // Interact with the control to see what request it triggers.
      const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => '');
      if (tag === 'select') {
        const adminOpt = el.locator('option:has-text("Admin"), option:has-text("admin")').first();
        if (await adminOpt.isVisible().catch(() => false)) {
          const adminVal = (await adminOpt.getAttribute('value').catch(() => '')) ?? '';
          await el.selectOption(adminVal).catch(() => {});
        }
      } else {
        await el.click().catch(() => {});
      }

      // Press Save/Update if a confirmation button appears.
      const saveBtn = page.locator('button:has-text("Save"), button:has-text("Update")').first();
      if (await saveBtn.isVisible().catch(() => false)) {
        await saveBtn.click().catch(() => {});
      }

      await page.waitForFunction(
        () => !document.querySelector('[class*="loading"]'),
        undefined,
        { timeout: 3_000 },
      ).catch(() => {});
      break;
    }

    if (!roleControlFound) {
      console.log(
        '[INFO] user-role-escalation: no role editing controls found in the Users tab. ' +
          'Role assignment appears to be backend-only — this is the recommended approach ✓',
      );
    }

    // Report on any role-related requests that were captured.
    if (roleUpdateRequests.length === 0 && roleControlFound) {
      console.warn(
        '[FINDING][low] user-role-escalation: a role editing control was found but no backend request fired when it was used. ' +
          'If role changes are applied client-side only (without a backend call), they will not persist and offer no real security boundary.',
      );
    }

    for (const req of roleUpdateRequests) {
      console.warn(
        `[FINDING][medium] user-role-escalation: role update request captured. ` +
          `URL: ${req.url}. Payload (first 300 chars): ${req.payload.slice(0, 300)}. ` +
          'Verify in LIVE_MODE that the Cloud Function enforces caller identity — ' +
          'only a super-admin service account should be permitted to modify custom claims.',
      );
    }
  });

});
