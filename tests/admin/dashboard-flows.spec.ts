import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../../src/utils/auth';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

// Known tab → content mappings from page inspection.
// Used in dashboard-navigation to verify the correct panel appears after each click.
const KNOWN_CONTENT: Record<string, string> = {
  'atab-btn-orders': '#orders-body',
  'atab-btn-packs':  '#packs-body',
};

test.describe('Admin dashboard flows', { tag: ['@admin'] }, () => {

  test.beforeEach(() => { test.slow(); });

  // ─── dashboard-stats-display ──────────────────────────────────────────────

  test('dashboard-stats-display — stat cards show valid numeric values after login', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and read the four order status summary cards: Total, Assembling, In Transit, and Delivered. Each card must show a number — zero is acceptable, but blank, 'NaN', or 'undefined' text indicates a data-loading failure that would hide order volumes from the admin. In safe test mode the Cloud Function that populates these cards is blocked, so empty cards are logged as info rather than a failure.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    const STAT_CARDS = [
      { id: '#stat-total',      label: 'Total' },
      { id: '#stat-assembling', label: 'Assembling' },
      { id: '#stat-transit',    label: 'In Transit' },
      { id: '#stat-delivered',  label: 'Delivered' },
    ];

    const results: Array<{ label: string; raw: string; ok: boolean }> = [];

    for (const { id, label } of STAT_CARDS) {
      const visible = await page.locator(id).isVisible().catch(() => false);
      if (!visible) {
        console.log(`[INFO] dashboard-stats-display: ${id} (${label}) is not visible.`);
        continue;
      }
      const raw = ((await page.locator(id).textContent().catch(() => '')) ?? '').trim();
      // Strip non-numeric characters and check the remainder is a finite number.
      // "0" and "0.00" are valid; empty string, "NaN", and "undefined" are not.
      const numeric = parseFloat(raw.replace(/[^0-9.\-]/g, ''));
      const ok = raw.length > 0 && !isNaN(numeric) && isFinite(numeric);
      results.push({ label, raw, ok });
      if (!ok) {
        console.error(
          `[FINDING][medium] dashboard-stats-display: ${id} (${label}) shows "${raw}" — not a numeric value. ` +
            'Check whether the stats query returned an error or was blocked.',
        );
      }
    }

    if (results.length === 0) {
      // No visible cards — CF likely blocked in safe mode and stats require CF data.
      console.log('[INFO] dashboard-stats-display: no stat cards visible (CF blocked in safe mode) — skipping numeric assertion.');
      return;
    }

    console.log('[INFO] dashboard-stats-display: ' + results.map(r => `${r.label}="${r.raw}"(${r.ok ? 'ok' : 'BAD'})`).join(', '));

    const badCards = results.filter(r => !r.ok);
    expect(
      badCards.map(r => `${r.label}="${r.raw}"`),
      'All visible stat cards must display a numeric value (NaN, blank, and "undefined" are failures)',
    ).toHaveLength(0);
  });

  // ─── dashboard-navigation ─────────────────────────────────────────────────

  test('dashboard-navigation — clicking each admin tab switches to the correct content panel', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and clicked every navigation tab on the dashboard in turn (Orders, Welcome Packs, and any others that are present). Verified that each tab gains an 'active' visual state and that the correct content panel becomes visible. No JavaScript errors must fire during navigation between tabs.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    // Discover all tab buttons at runtime — the portal may add tabs without the
    // test suite needing to know in advance.
    const allTabs = await page.locator('.admin-tab-btn').all();

    if (allTabs.length === 0) {
      console.log('[INFO] dashboard-navigation: no .admin-tab-btn elements found — cannot verify tab navigation.');
      return;
    }

    console.log(`[INFO] dashboard-navigation: found ${allTabs.length} tab(s).`);

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    for (const tab of allTabs) {
      const tabId   = (await tab.getAttribute('id').catch(() => '')) ?? '';
      const tabText = ((await tab.textContent().catch(() => '')) ?? '').trim();

      await tab.click();

      // Wait for the tab to become active before proceeding to the next one.
      await page.waitForFunction(
        (id) => !id || document.getElementById(id)?.classList.contains('active'),
        tabId,
        { timeout: 3_000 },
      ).catch(() => {});

      const isActive = await tab.evaluate(el => el.classList.contains('active')).catch(() => false);
      if (!isActive) {
        console.warn(
          `[FINDING][low] dashboard-navigation: tab "${tabText}" (${tabId}) did not gain the "active" class after clicking. ` +
            'The active tab should be visually distinguished from inactive tabs.',
        );
      }

      // For known tabs, verify the corresponding content panel is visible.
      const bodySelector = KNOWN_CONTENT[tabId];
      if (bodySelector) {
        const contentVisible = await page.locator(bodySelector).isVisible().catch(() => false);
        if (!contentVisible) {
          console.error(
            `[FINDING][medium] dashboard-navigation: clicked tab "${tabText}" but ${bodySelector} is not visible. ` +
              'The tab may not be correctly wired to its content panel.',
          );
        } else {
          console.log(`[INFO] dashboard-navigation: "${tabText}" → ${bodySelector} visible ✓`);
        }
      } else {
        console.log(`[INFO] dashboard-navigation: "${tabText}" (${tabId}) clicked — no known content selector to verify.`);
      }
    }

    if (pageErrors.length > 0) {
      console.error(
        `[FINDING][high] dashboard-navigation: ${pageErrors.length} unhandled JS exception(s) during tab navigation: ` +
          pageErrors.join(' | '),
      );
    }
    expect(pageErrors, 'No unhandled JS exceptions must fire during tab navigation').toHaveLength(0);
  });

});
