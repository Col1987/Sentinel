# Sentinel - AI-Powered Website Testing Framework

## What This Is
An AI-augmented testing framework that runs against any website to identify risks, defects, workflow gaps, accessibility issues, and visual regressions. Built with Playwright + TypeScript. Currently targeting https://www.juelhaus.co.za as the first test subject (explicit owner permission granted).

## Tech Stack
- **Runtime**: Node.js 20+, TypeScript 5+
- **Test framework**: Playwright Test
- **Package manager**: npm (not yarn, not pnpm)
- **Reporting**: Custom HTML report generation
- **CI/CD**: GitHub Actions
- **Linting**: ESLint + Prettier

## Project Structure
```
sentinel/
├── src/
│   ├── auditors/          # Individual audit modules (a11y, links, forms, seo, performance)
│   ├── config/            # Site config and test targets
│   ├── reports/           # Report generation and templates
│   └── utils/             # Shared helpers (browser, selectors, logging)
├── tests/
│   ├── smoke/             # Quick health checks
│   ├── functional/        # User workflow tests
│   └── regression/        # Full regression suite
├── reports/               # Generated report output (gitignored)
├── .github/workflows/     # GitHub Actions pipelines
├── playwright.config.ts
├── tsconfig.json
└── package.json
```

## Commands
- `npm install` - install dependencies
- `npx playwright test` - run all tests
- `npx playwright test --project=smoke` - run smoke tests only
- `npx playwright test --reporter=html` - run with HTML report
- `npm run lint` - run ESLint
- `npm run format` - run Prettier
- `npm run audit` - run the full AI audit pipeline against the configured target site

## Conventions

### Consistency check before adding any new convention or reusable pattern

Before adding any new rule, convention, or "known-working pattern" to this file, check it against every existing rule already written. A new addition must never silently contradict an established convention (e.g. do not add a reusable pattern that relies on a fixed waitForTimeout() if there is an existing rule against fixed timeouts, do not add a "just skip on failure" pattern if there is an existing rule requiring hard failures on missing elements).

If a new situation genuinely requires deviating from an existing rule, do not add it as a silent exception. Instead: state explicitly which existing rule is being deviated from, why the deviation is justified for this specific case, and scope the deviation as narrowly as possible rather than weakening the general rule. Flag this deviation to Colin for confirmation before treating it as an accepted convention.

This file should read as internally consistent at all times. A contradiction between two conventions is itself a bug in this file and should be resolved (by removing, narrowing, or explicitly reconciling one of them) rather than left to coexist.

### Known-working patterns — check before debugging

Before writing a new fix for a recurring category of problem, check whether this codebase already has a proven, working solution to the same underlying issue elsewhere. Search existing test files for similar problems before inventing a new approach.

- **Clearing Firebase auth/session state reliably**: Do NOT call the site's own window.logout() function and wait for its navigation — its async timing is unreliable across contexts and has caused page-context-teardown races. Instead, directly clear localStorage, sessionStorage, and delete the known Firebase IndexedDB databases (firebaseLocalStorageDb, firebase-installations-database, firebase-heartbeat-database) via page.evaluate(), then navigate once. See the pattern in tests/admin/negative/access-control.spec.ts (expired-session-handling).

- **Awaiting a promise-returning function inside page.evaluate()**: always explicitly `return` the function call — omitting `return` on an async call inside evaluate() causes Playwright to resolve before the browser-side promise settles, which can cause page-context races if a subsequent navigation depends on that promise having completed.

- **Route interception on pages that need a response to render**: Use route.fulfill() with a minimal valid response, never route.abort(), for any page whose JS depends on a Cloud Function response before DOMContentLoaded fires. Aborting the request can hang page.goto() indefinitely since the load event never fires. See the welcome-page.spec.ts fix (CF_EMPTY_RESPONSE pattern). Note: the Live Mode section's code example comment says "intercept / abort / fulfill as needed" — that permissive comment applies to endpoints whose absence does not block page load. This entry is a scoped narrowing for CF-dependent pages only, not a contradiction of the general pattern.

- **Elements sharing the same selector/aria-label across a page**: When multiple elements share generic attributes (e.g. several password-toggle buttons all labeled "Show password", or multiple "Back" links in different modals), scope the locator to its specific parent container rather than using a bare text/aria selector. See login-form.spec.ts and forgot-password.spec.ts fixes.

- **Testing whether a UI element's protection is backend-enforced vs UI-only**: Use locator.click({ force: true }) to click through a disabled/overlaid element, then check whether the actual backend request succeeds or fails. This distinguishes "blocked by CSS/overlay only" from "genuinely protected by Firestore rules/Cloud Function auth checks."

- **Broken link / page-availability checks on JS-rendered pages**: A raw HTTP HEAD/GET request can report a page as broken when it actually renders fine via full browser navigation (client-side routing/rendering). Always fall back to a full page.goto() before concluding a page is genuinely broken.

- **Test data that creates real accounts/records**: Use a per-run unique identifier (e.g. testEmail(`tag-${Date.now()}`)) for any test that CREATES a real account or record and later needs to verify a fresh/unregistered state. Use a FIXED identifier only for tests that merely check an outgoing request payload, or that intentionally rely on a known non-existent/existing account. Mixing these up either creates unnecessary duplicate data or silently tests stale state instead of the intended fresh scenario.

- **Diagnosing "test appears to hang"**: Before assuming a genuine infrastructure issue, check for: (a) a page.evaluate() calling an async function without return, (b) a .catch(() => {}) silently swallowing a real failure inside a retry loop, (c) an unguarded page-level JS call (e.g. calling a site's own function directly) that may block the event loop or trigger an untracked navigation. These three account for the majority of "mystery hangs" encountered in this project so far.

- **Journey/flow test failures**: The journey runner (src/runners/journey-runner.ts) automatically screenshots on step failure. Check reports/screenshots/{journey-id}-step-{N}.png before assuming a selector or timing issue — the screenshot often shows the actual page state immediately.

- **Auditor severity/status conventions**: Findings-only auditors (discovery, SEO, code-quality) should show as "Review" with an amber badge in the report, never "Fail" with a red badge — reserve hard fail/red status for tests with a genuine pass/fail assertion.

- **Report generation must reflect the actual environment mode at generation time**: Do not import a mode flag (like LIVE_MODE) at module load time if dotenv may not have finished loading yet — read process.env directly at the point of use (e.g. when naming the report file) rather than relying on a cached import.

- **CI worker configuration**: This project intentionally runs with workers: 1 in CI (see playwright.config.ts) to avoid resource contention on shared runners. Do not assume local multi-worker timing behavior will match CI.

- **Selector discovery for a new site or new page**: Always run the discovery auditor against a new target page before writing selectors by hand.

- **Test data resembling real customer information**: Any test data that could resemble real customer information (names, emails, phone numbers) must use the TEST_NAME_PREFIX / testEmail() / TEST_PHONE conventions from src/config/sites.ts, never ad-hoc realistic-looking fake data.

- **Verifying a security control is real vs. cosmetic**: Don't trust a UI-level restriction (a hidden button, a disabled field, a client-side redirect) as proof of actual protection. Always attempt to reach the underlying request/endpoint directly to confirm the backend itself enforces the restriction, not just the UI. Use locator.click({ force: true }) as the practical technique to bypass UI-level guards and reach the underlying request.

- **Toggle/panel controls that don't respond for later form instances**: When a click-to-toggle panel (e.g. address breakdown) works for a first form instance but silently fails for the second (item 2+ in a multi-item cart), don't increase the waitFor timeout — the panel genuinely isn't opening. Use a .then(() => true).catch(() => false) pattern to detect the failure, then fall back to setting the hidden inputs directly via page.evaluate() (el.value + dispatchEvent input+change), the same pattern setDateField uses for date fields. See fillConfigStep in checkout-helpers.ts (addrPanelOpen fallback).

- **Storage-clearing helpers must verify page origin first**: page.evaluate() targets the current page's origin. If the browser may be on an external domain (e.g. PayFast after payment redirect), navigate to the target origin before calling the storage-clear evaluate, or the clear will target the wrong domain's storage. Check page.url() and call page.goto('/') if needed. See signOutCurrentUser in cart-combinations-live.spec.ts.

Add new entries to this list whenever a genuinely reusable fix is found for a category of problem (not a one-off), so future debugging starts from what's already known to work rather than rediscovering it live.

### Debugging circuit breaker

If a single test has required more than 2 consecutive live-debugging fixes in one session (patch → run → still broken → patch again) without reaching a clean pass, STOP immediately. Do not attempt a third patch. Instead:

1. Revert the file(s) to the last known-good commit: `git checkout HEAD~1 -- <file>`
2. State clearly that the debugging attempt is being abandoned for this session, and why.
3. Do NOT re-run the test again in this session. Wait for explicit instruction to resume.

This rule exists because repeated live-patching under pressure has previously caused runaway token/session consumption chasing hangs one at a time, each fix plausible in isolation but the cumulative cost unacceptable. Two attempts is the limit. A third attempt is never worth it in the moment — reverting and rewriting fresh in the next session is always cheaper than continuing to chase a hang live.

This rule overrides any instruction to "keep trying" or "just one more fix" given in the heat of a debugging session. If the person insists on continuing past 2 failed attempts, state this rule explicitly back to them before proceeding, so the decision to continue is made knowingly, not by momentum.

Additionally: any test expected to take longer than 60 seconds must have that duration explicitly justified in a code comment before it is built, not discovered afterward. If a test's actual runtime exceeds its stated justification by more than 2×, that is itself a signal to stop and investigate before adding more timeout budget.

### Code
- Page Object Model for all page interactions. Every page gets a class in `src/pages/`
- No hardcoded URLs. All target sites configured in `src/config/sites.ts`
- No hardcoded selectors in test files. Selectors live in page objects
- Async/await everywhere. No .then() chains
- All test data in `src/config/` or `.env` files. Never inline

### Tests
- One test file = one feature area or workflow
- Test names describe the expected behaviour, not the steps: `should display error for invalid email` not `test login form`
- Use `test.describe()` blocks to group related tests
- Tag tests: `@smoke`, `@regression`, `@a11y`, `@visual`
- No test interdependencies. Every test stands alone

### Git
- Branch naming: `feature/short-description`, `fix/short-description`, `audit/short-description`
- Commit messages: imperative mood, max 72 chars. e.g. `add broken link auditor module`
- Never commit to main directly. PR workflow only
- `reports/` and `.env` are gitignored

### Live Mode

`LIVE_MODE` is exported from `src/config/sites.ts` and driven by the `SENTINEL_LIVE_MODE` env var:

```
SENTINEL_LIVE_MODE=true npx playwright test --project=functional
```

Default is `false` (safe mode — all outbound requests are intercepted and aborted).

Every test that uses `page.route()` must follow this pattern:

```typescript
import { LIVE_MODE } from '../../src/config/sites';

test('...', async ({ page }) => {
  if (LIVE_MODE) test.slow();         // real network calls take longer

  if (!LIVE_MODE) {
    await page.route('**/endpoint', async (route) => {
      // intercept / abort / fulfill as needed
    });
  }

  // all test logic and assertions unchanged
});
```

When LIVE_MODE is true a warning is printed at the start of the run via `globalSetup`. Only enable LIVE_MODE when intentional end-to-end verification against real backends is needed.

### Mode-agnostic test design

Every test should work in BOTH safe mode and LIVE_MODE by default, asserting whatever it can prove in the active mode rather than being written exclusively for one mode.

- **Safe mode:** intercept the outgoing request and assert on what the CLIENT sends (payload shape, whether validation fired before the request, whether manipulated/malicious data appears in the request body).
- **LIVE_MODE:** let the request through and add ADDITIONAL assertions on what the SERVER actually did (response status, database state, whether admin shows the record, whether manipulated data was accepted and stored).

Use `if (LIVE_MODE) { ...extra assertions... }` to layer on deeper checks, not `test.skip(!LIVE_MODE)` to gate the whole test.

Reserve `test.skip(!LIVE_MODE, 'reason')` ONLY for tests that are structurally impossible to verify without a real backend — for example, race-condition/idempotency tests that require two real concurrent requests hitting real infrastructure. Document the specific reason in the skip message every time this exception is used.

When a test fails, determine whether the failure is caused by the environment (safe mode correctly blocking a mocked request) or a genuine system defect before logging a finding. A safe-mode test that "fails" only because a request was intercepted is not a finding — that is expected mock behavior.

### Test cost awareness

Before writing any test that repeats an expensive operation (full checkout flow, full registration, multi-step form completion) across multiple variations (multiple packs, multiple properties, multiple accounts), stop and ask:

1. Does this variation actually need the FULL expensive flow, or just the DATA to be correct? Prefer cheap direct verification (checking Firestore/admin data, API responses, DOM state) over repeating an expensive UI flow when the flow itself is identical and only the data differs.

2. If the full flow genuinely must be repeated, is a representative sample sufficient (e.g. first + last item, or 2-3 out of N) rather than exhaustively repeating for every single variation?

3. Before defaulting to parallel execution as a speed fix, consider whether parallel load introduces real risk: rate limiting on the target backend, resource exhaustion in CI (which runs on `workers: 1`), or flakiness from shared state/race conditions. Parallel is not automatically "smarter" than sequential — it trades one cost for another and must be a deliberate choice, not a default.

4. Any test with an expected runtime beyond 2-3 minutes should be flagged explicitly to Colin before being built, with the reasoning for why that cost is necessary. Do not silently build long-running tests without surfacing the tradeoff first.

5. Never use `.catch(() => {})` to silently swallow a failure inside a loop or retry mechanism without logging what was caught. Silent failure swallowing has previously caused a test to retry a broken action for 10 minutes before the real defect was found. Always log caught errors, even when the test is designed to continue past them.

The goal: maximum real coverage at minimum execution cost, with any necessary tradeoff made visible and deliberate rather than accidental.

General principle: when a fix or test design has an obvious "fast/easy" version and a "correct/considered" version, default to the considered one. Speed and low effort are not the goal — genuine coverage at justified cost is. If a shortcut is taken for time or token budget reasons, say so explicitly rather than presenting it as the best solution.

### Reporting
- Reports output to `reports/` as self-contained HTML files
- Each report includes: timestamp, target URL, pass/fail summary, categorised findings with severity (critical/high/medium/low/info), screenshots where relevant
- Reports must be viewable standalone (no external dependencies in the HTML)

## Hard Rules
- This framework must work against ANY website, not just Juel Haus. Never hardcode assumptions about a specific site's structure into core modules
- Do not install unnecessary dependencies. Check if Playwright's built-in APIs cover the need first
- Do not create test accounts or submit real forms on target sites unless explicitly told to
- No AI-sounding variable names or comments. Keep it technical and direct
- When adding a new auditor module, follow the pattern in existing modules. Check `src/auditors/` first

## Target Site Context (Juel Haus)
- URL: https://www.juelhaus.co.za
- Type: Hospitality tech platform (QR-powered guest welcome hubs for Airbnb/rental hosts)
- Key pages: Landing page, login/register modals, account page, cart, demo booking form
- Stack appears to be static HTML/CSS/JS with client-side auth
- South African business, ZAR currency, .co.za domain
- Owner has granted explicit testing permission
