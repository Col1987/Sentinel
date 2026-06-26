import { test, type Page } from '@playwright/test';
import { loginAsAdmin } from '../../src/utils/auth';
import { LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';

// The Users management tab may not yet be implemented in the admin portal.
// From page inspection, only Orders (#atab-btn-orders) and Welcome Packs (#atab-btn-packs)
// tabs are confirmed present. All three tests in this file are written to pass gracefully
// when the feature is absent — they log observations as [INFO] findings rather than failing hard.

async function openUsersTab(page: Page): Promise<boolean> {
  const TAB_SELECTORS = [
    '#atab-btn-users',
    'button.admin-tab-btn:has-text("Users")',
    'button:has-text("Users")',
    'a.admin-tab-btn:has-text("Users")',
  ];

  for (const sel of TAB_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      console.log(`[INFO] users tab found via "${sel}" and clicked.`);
      return true;
    }
  }

  console.log('[INFO] openUsersTab: no Users tab found — feature may not yet be implemented.');
  return false;
}

async function openFirstUserDetail(page: Page): Promise<boolean> {
  const USER_TARGETS = [
    '#users-body button:has-text("View")',
    '#users-body tr:not(:first-child)',
    '#user-list .user-row',
    '[class*="user-list"] [class*="user-item"]',
  ];

  for (const sel of USER_TARGETS) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      await page.waitForFunction(
        () => !!document.querySelector('[id*="user-modal"], [id*="user-detail"], [class*="user-detail"]'),
        { timeout: 4_000 },
      ).catch(() => {});
      console.log(`[INFO] openFirstUserDetail: clicked first user item via "${sel}".`);
      return true;
    }
  }

  console.log('[INFO] openFirstUserDetail: no clickable user rows found.');
  return false;
}

test.describe('Admin user management', { tag: ['@admin'] }, () => {

  test.beforeEach(() => { test.slow(); });

  // ─── users-list-loads ─────────────────────────────────────────────────────

  test('users-list-loads — Users tab shows a list of registered accounts', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin and navigated to the Users tab. Checked that a list of registered user accounts is displayed. In safe test mode, user data may load via a Cloud Function that is blocked, so an empty list is logged as informational rather than a failure. If the Users tab does not exist in the current portal version, the test is skipped gracefully.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    const tabFound = await openUsersTab(page);
    if (!tabFound) {
      console.log('[INFO] users-list-loads: Users tab not present — skipping user list assertions.');
      return;
    }

    const USER_BODY_SELECTORS = ['#users-body', '#user-list', '[id*="users-body"]', '[class*="user-list"]'];
    let usersBodySelector = '';
    for (const sel of USER_BODY_SELECTORS) {
      if (await page.locator(sel).isVisible().catch(() => false)) {
        usersBodySelector = sel;
        break;
      }
    }

    if (!usersBodySelector) {
      console.log('[INFO] users-list-loads: Users tab exists but no recognisable user list container found.');
      return;
    }

    const userItemCount = await page.locator(
      `${usersBodySelector} tr:not(:first-child), ${usersBodySelector} .user-row, ${usersBodySelector} [class*="user-item"]`,
    ).count();

    console.log(`[INFO] users-list-loads: ${userItemCount} user row(s) in "${usersBodySelector}".`);

    if (userItemCount === 0 && !LIVE_MODE) {
      console.log('[INFO] users-list-loads: user list is empty — CF likely blocked in safe mode.');
    } else if (userItemCount === 0 && LIVE_MODE) {
      console.warn(
        '[FINDING][low] users-list-loads: user list is empty in LIVE_MODE. ' +
          'At least the admin account should appear in the user list.',
      );
    } else {
      console.log('[INFO] users-list-loads: user list contains entries ✓');
    }
  });

  // ─── user-detail-opens ────────────────────────────────────────────────────

  test('user-detail-opens — clicking a user row opens a detail panel with account information', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, navigated to the Users tab, and clicked the first user in the list. Checked that a detail panel or modal appeared showing the user's account information. Admins need to view individual user details to manage accounts and investigate issues. If the Users tab or user rows are not present, the test is skipped gracefully.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    const tabFound = await openUsersTab(page);
    if (!tabFound) {
      console.log('[INFO] user-detail-opens: Users tab not present — skipping.');
      return;
    }

    const rowClicked = await openFirstUserDetail(page);
    if (!rowClicked) {
      console.log('[INFO] user-detail-opens: no user rows to click — skipping detail-view assertion.');
      return;
    }

    const DETAIL_SELECTORS = ['[id*="user-modal"]', '[id*="user-detail"]', '[class*="user-detail"]'];
    let detailVisible = false;

    for (const sel of DETAIL_SELECTORS) {
      if (await page.locator(sel).first().isVisible().catch(() => false)) {
        detailVisible = true;
        console.log(`[INFO] user-detail-opens: user detail panel found via "${sel}" ✓`);
        break;
      }
    }

    if (!detailVisible) {
      console.warn(
        '[FINDING][medium] user-detail-opens: clicked a user row but no recognisable detail panel appeared. ' +
          'Admins need to view individual user details to manage accounts.',
      );
    }
  });

  // ─── user-role-visible ────────────────────────────────────────────────────

  test('user-role-visible — user detail panel displays the account role or admin status', async ({ page }) => {
    test.info().annotations.push({
      type: 'description',
      description: "Logged in as admin, opened a user's detail view, and checked whether the account role (admin / standard user) or admin flag is displayed. Without role visibility, admins cannot identify which accounts have elevated privileges — important for auditing access and revoking admin rights when staff leave. If the Users tab or detail panel is absent, the test is skipped gracefully.",
    });

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.abort());
    }

    await loginAsAdmin(page);

    const tabFound = await openUsersTab(page);
    if (!tabFound) {
      console.log('[INFO] user-role-visible: Users tab not present — skipping.');
      return;
    }

    const rowClicked = await openFirstUserDetail(page);
    if (!rowClicked) {
      console.log('[INFO] user-role-visible: no user rows to click — skipping role visibility check.');
      return;
    }

    const detailText = await page.evaluate(() => {
      const detail =
        document.querySelector<HTMLElement>('[id*="user-modal"]') ??
        document.querySelector<HTMLElement>('[id*="user-detail"]') ??
        document.querySelector<HTMLElement>('[class*="user-detail"]');
      return detail ? detail.innerText.toLowerCase() : '';
    }).catch(() => '');

    if (!detailText) {
      console.log('[INFO] user-role-visible: no detail panel text readable — skipping role check.');
      return;
    }

    const ROLE_SIGNALS = ['admin', 'role', 'permission', 'standard', 'user type', 'account type'];
    const hasRoleInfo = ROLE_SIGNALS.some(s => detailText.includes(s));

    if (!hasRoleInfo) {
      console.warn(
        '[FINDING][low] user-role-visible: the user detail panel does not appear to display role or admin status. ' +
          'Admins should be able to identify elevated-privilege accounts at a glance.',
      );
    } else {
      console.log('[INFO] user-role-visible: role or permission information detected in user detail ✓');
    }
  });

});
