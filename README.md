# Sentinel

An AI-powered website testing framework that identifies risks, defects, accessibility issues, and workflow gaps. Built with Playwright and TypeScript.

Coverage today has two tiers:

- **Site-agnostic (works against any target now):** the auditor modules — accessibility, SEO, code quality, discovery, and broken links (`src/auditors/`) — run in safe mode against any site with no configuration beyond pointing `baseUrl` (`src/config/sites.ts`) at it. No selectors, no journey definitions, no site-specific setup.
- **JuelHaus-specific today:** the business-flow journey tests (checkout, admin, auth), the Firebase-specific known-working-patterns in `CLAUDE.md`, and the admin/checkout page object selectors are all built against juelhaus.co.za's actual DOM and backend. Pointing Sentinel's business-flow tests at a different site would require writing new selectors and journey configs for that site's specific pages and flows — the runner, reporter, and risk-mapping engine underneath are reusable, but the flow definitions themselves are not automatic.

Currently targeting [juelhaus.co.za](https://www.juelhaus.co.za) as the first test subject (owner permission granted).

## What it does

Sentinel combines automated auditing with targeted flow testing to produce a professional HTML report. One command runs the full suite and generates a branded, client-ready document with findings grouped by severity, plain-English explanations, and fix guidance.

The core engine — auditors, journey runner, reporter, risk mapping — is designed to work against any website, with site-specific configuration (URLs, selectors, journey definitions) kept separate from it. What that portability buys you today is exactly the site-agnostic tier above: the auditors run against a new target immediately, while business-flow journeys need new selectors and configs written for that target's actual pages before they can run.

## Architecture

```
sentinel/
  src/
    auditors/         Standalone audit modules (links, accessibility, discovery, SEO, code quality, API key exposure)
    config/           Site configuration, journey definitions, environment setup
    runners/          Journey runner that executes declarative flow tests
    reports/          Playwright reporters (findings report, test case report) and the risk-map config
    utils/            Shared helpers (auth, logging, Gmail API)
  tests/
    smoke/            Quick health checks (HTTP status, console errors, page title)
    functional/       User workflow tests (forms, navigation, modals, cart, auth)
    security/         Adversarial tests (XSS, injection, credential exposure, DOM bypass)
    audits/           Auditor-driven tests (accessibility, broken links, discovery)
    admin/            Admin portal tests (dashboard, orders, packs, users)
    admin/negative/   Admin security tests (access control bypass, data exposure)
    regression/       Curated LIVE_MODE subset built for unattended nightly CI execution
  scripts/            Manually-triggered developer tooling (post-debugging diff review)
  reports/            Generated report output (gitignored)
  .github/workflows/  CI pipelines (safe-mode audit on push/daily cron, LIVE_MODE regression nightly)
```

## Current test coverage

218 tests across 6 projects: 206 in safe mode (smoke, functional, security, audit, admin — no outbound requests reach real backends) plus a curated 12-test LIVE_MODE regression subset that exercises real backends (Firebase Auth, Cloud Functions, PayFast sandbox, Gmail) end-to-end and runs nightly via CI (see "Nightly regression" under CI/CD).

**Smoke (11 tests):** Page availability across all known routes, critical UI elements present, CSS/JS loaded correctly, no broken images, homepage load time threshold.

**Functional (106 tests):** Demo booking form, registration form (including international phone number formats), login form, forgot password, navigation and anchor scrolling (surfaced a real defect — see Key findings), modal open/close and cross-modal navigation, responsive/mobile including tablet boundary and horizontal overflow checks, storefront cart behaviour, demo modal lifecycle, auth flows including logout and session persistence, order tracking deeplinks, Watch Demo button content check.

**Security (45 tests):** Auth bypass, cart manipulation, console injection and DOM bypass, credential exposure scanning, security headers (HSTS, CSP, X-Frame-Options), checkout abuse including price/quantity manipulation via DevTools, welcome page XSS and data leak checks, order tracking XSS/SQL injection/enumeration, public page console error sweep, and an API key exposure auditor scanning page source and inline scripts for exposed Anthropic/OpenAI/Stripe/AWS/Supabase key patterns.

**Audit (5 tests):** Accessibility via axe-core across all known pages, broken link verification with browser fallback, interactive element discovery, SEO auditor (titles, meta descriptions, heading hierarchy, Open Graph, canonicals, alt text), and an 11-check code quality auditor purpose-built to catch AI-generated code failure patterns (duplicate IDs, orphaned event handlers, dead forms, phantom asset references, low-quality aria labels, duplicate meta tags, hardcoded localhost URLs, placeholder href links, excessive console.log, mixed content, hardcoded test data).

**Admin (39 tests):** Dashboard, order management, pack CRUD, user management, negative access control (DOM bypass, session expiry, unauthenticated export), negative order/pack/user abuse (XSS, SQL injection, role escalation probing).

**Regression (12 tests):** A curated LIVE_MODE subset built for unattended nightly execution rather than manual runs — auth happy paths (login/logout), representative single-pack checkout completion, order status progression with email trigger, verification email production-domain check, admin access control, and the safe-mode auditors (accessibility/SEO/code-quality/API-key-exposure) re-run against the live site. See "Nightly regression" under CI/CD.

**LIVE_MODE end-to-end:** Full checkout through real PayFast sandbox with order creation confirmed in admin, PayFast payment completion against the real sandbox with order status confirmation, payment-ownership enforcement (a customer cannot trigger payment for another customer's order), and double-charge protection (payment rejected for an already-paid order). Order lifecycle testing — status progression through all 6 stages (Pending → Assembling → Ready for Collection → In Transit → Delivered → Completed) with persistence verification, waybill entry and save. Welcome page rendering verified against real guest/property data from a real order, including content correctness — branding/font, house rules, restaurants and activities scoped to the right property, host contact name and WhatsApp link formatting. Full admin pack CRUD lifecycle (create → verify on storefront → edit → delete) against the real database. Admin gaps testing — Audit Log entries for admin actions (timestamp and acting admin identity), Support Tickets tab structure, and the Force/Override status control requiring explicit confirmation. My Account/My Orders (a customer only ever sees their own orders, Cancel only available while Pending, cancellation actually calls the backend) and My Properties (full create/edit/delete CRUD against saved properties — surfaced a genuine edit-flow defect, see Key findings). Premium Upgrades (selecting a paid upgrade updates the modal total live, persists correctly to the completed order, skipping preserves the base price, and the modal is correctly absent for packs with no upgrade categories enabled). Login lockout and session persistence testing, including Firebase's brute-force protection and the Remember Me persistence mechanism. Automated email verification testing via Gmail API — Sentinel reads the real inbox, extracts the real verification link, and follows it, with zero manual intervention. Price and quantity manipulation testing (confirmed server-side price lookup, no client-supplied price accepted). Duplicate-order idempotency under rapid double-submit, and concurrent-session cart isolation. Order ID enumeration testing against real order IDs. Cross-customer data boundary checks (welcome pages, admin order search, order tracking) confirming isolation per customer, surfacing one real finding — admin order search uses substring matching rather than exact-email scoping. Multi-property account management (confirmed working end-to-end — full create/edit/delete against saved properties, not single-property-per-account as earlier assumed) and international phone number registration testing.

Every LIVE_MODE test is written mode-agnostic by default: it asserts what it can prove from the intercepted request in safe mode, and layers additional server-side verification when running against the real backend. `test.skip(!LIVE_MODE)` is reserved only for tests that are structurally impossible to verify without a real backend (e.g. race-condition/idempotency checks).

## Key findings on juelhaus.co.za

**Security:**
- Demo form accepts empty name submission when the HTML `required` attribute is stripped via DevTools. No JS-level validation guard exists in the submit handler.
- 19 JavaScript functions exposed globally on `window` (addToCart, handleLogin, goToCheckout, etc). Callable from the browser console by any visitor.
- Admin dashboard HTML renders before Firebase auth resolves. Content is in the DOM behind the auth overlay before authentication completes.
- **Admin order search uses substring/prefix matching, not exact-email scoping.** Searching for one customer's full email address also returns another customer's order when both email addresses share a common base string (e.g. both using the same Gmail account with different `+tag` aliases). An admin filtering for a specific customer may inadvertently see unrelated customers' orders in the results set.

**Accessibility:**
- 24 WCAG AA colour contrast violations across the homepage.
- 15 form inputs with no accessible label (screen readers cannot identify them).
- 16 landmark/region violations (content outside semantic landmarks).
- Auth modal does not close on Escape key. Keyboard users cannot dismiss it.
- Mobile hamburger menu z-index blocks its own close button.

**Functional:**
- Cart total display does not reset after removing the last item. Badge shows 0 but price stays at R1,200.
- No confirmation prompt before pack deletion in admin portal.
- Welcome page does not display which pack the guest ordered.
- Storefront serves a cached version of pack data after an admin edit — changes don't reflect immediately.
- Failed login lockout (Firebase's brute-force protection) shows no message to the user. The form silently stops accepting the correct password with no explanation.
- **The platform drops one item when two different packs are added to cart and checked out together.** A cart with two packs produces an order for only one — confirmed via the real admin order total being short by exactly one pack's price plus its share of delivery. This is a revenue-affecting defect: a customer ordering multiple packs in one checkout may be charged for or receive fewer items than they ordered.
- **Wi-Fi configuration does not reach the welcome page in a multi-item cart.** Wi-Fi is architecturally per-order, not per-item — when Wi-Fi credentials are entered for one item in a two-item cart, the welcome page's Wi-Fi display does not appear for either item. Worth confirming with the site owner whether this is intended (one Wi-Fi config per order) or a gap, but as observed the entered credentials do not surface anywhere on the guest-facing page.
- The site reuses the same HTML element IDs across multiple cart items in the checkout config forms rather than generating unique IDs per item. Duplicate IDs violate the HTML spec and can cause unpredictable behaviour in form handling and accessibility tooling.
- **My Properties' edit flow does not repopulate a saved property's restaurants/activities when the edit form opens.** Even though the saved record already has both (confirmed via a raw Firestore read at creation time), the form's Save button stays disabled until the user manually re-adds an entry that's already on file. Distinct from Create, which works correctly — this is specifically an edit-flow defect.
- **The homepage "Get Started" CTA is a complete silent no-op for genuine authenticated customers.** Confirmed against a real, Gmail-verified, non-admin account: clicking it produces no scroll, no navigation, and no console error — despite the site's own `handleGetStarted()` function confirming the correct code branch runs (`currentUser` set, `emailVerified` true → `#gifts.scrollIntoView()`). This is the primary conversion path for a returning customer to reach the product catalogue from the homepage, and it currently does nothing. (An earlier version of this test used an admin session instead of a real customer, which masked the actual defect behind an unrelated admin-only redirect — see `get-started-scrolls-to-packs`.)

**Email and domain branding:**
- Email verification links redirect to `juelhaus-co-za.firebaseapp.com` instead of the custom domain, which can trigger a "this site may be fake" warning in Chrome for new users completing signup.
- Order tracking links in confirmation emails point to the raw Firebase Hosting domain (`.web.app`) rather than the branded domain, and omit the order ID as a deep-link parameter — forcing customers to manually enter their order number despite the tracking page supporting deep links elsewhere.
- The order confirmation email is triggered by an admin manually advancing the order to "Assembling" status, not by PayFast payment confirmation.
- The "resend verification email" button works correctly on the homepage but has no JS handler at all on the account page, and the underlying Cloud Function returns an HTTP 500 error server-side.

**Positive confirmations:**
- No PayFast credentials, TCG API keys, or MD5 libraries in client-side JavaScript.
- No deprecated project references (baylinhaus-c9d41) anywhere in the codebase.
- Firestore security rules hold under DOM bypass. Removing the auth overlay exposes no real data.
- Zero console errors across all known pages.
- XSS blocked on every tested input across public site and admin portal.
- SQL injection payloads handled gracefully on order tracking and admin search.
- Double-submit protection on demo form confirmed.
- Custom phone validation on registration form, and international phone number formats (UK, US, UAE, Germany) all validate correctly.
- Empty cart checkout blocked both via UI and direct `goToCheckout()` console call.
- CSV export blocked for unauthenticated visitors.
- Price and quantity are never sent by the client at checkout — the server performs its own lookup from the order/pack reference. Confirmed by intercepting the Cloud Function payload and by checking the admin order record after a manipulated client-side price was submitted.
- No order data leakage when guessing/incrementing a real order ID by one character.
- No cart data loss between concurrent sessions on the same account.
- No cross-customer data leak on welcome pages — each customer's welcome page serves only their own guest name, property name, and order data, confirmed with two real concurrent orders in Firestore.
- No cross-customer data leak on the order tracking page — neither customer's data appeared on the other's tracking result when probed with two real, valid, different order IDs.
- Full admin pack CRUD lifecycle (create, edit, delete) persists correctly to the database and reflects on the public storefront.
- The order lifecycle correctly progresses through all six statuses with each transition persisting, and waybill entry saves correctly.
- Remember Me correctly switches Firebase between LOCAL (persists across browser restarts) and SESSION persistence.
- PayFast payment triggering is correctly scoped to the order's owner — attempting to trigger payment for another customer's order is rejected by the backend, and re-triggering payment for an already-paid order is also rejected (no double-charge path).
- Admin actions are properly audited — advancing an order status produces a new Audit Log entry with a timestamp and the acting admin's identity — and the Force/Override status control cannot be applied without an explicit confirmation step.
- Multi-property account management works correctly end-to-end — customers can create, edit, and delete multiple saved properties (Create and Delete confirmed defect-free; Edit has the restaurants/activities repopulation gap noted above).

## How it works

### Auditors

Each auditor module in `src/auditors/` implements the `AuditResult` interface from `src/auditors/types.ts`. Auditors scan pages for specific issue categories and return structured findings with severity levels.

- **Links auditor:** Collects every `<a href>` on the page, checks each with an HTTP HEAD request, and falls back to full browser navigation for pages that require JavaScript to render. Eliminates false positives from client-rendered pages.
- **Accessibility auditor:** Runs axe-core via `@axe-core/playwright` against every known page. Maps axe impact levels to the Sentinel severity enum.
- **Discovery auditor:** Navigates to each configured page and maps every interactive element (forms, inputs, buttons, links, selects, textareas). Extracts the most reliable selector for each element and outputs a JSON map to `reports/discovery.json`. Also flags elements with no accessible name.
- **SEO auditor:** Checks page titles, meta descriptions, heading hierarchy, Open Graph tags, canonical URLs, lang attributes, and image alt text across every known page.
- **Code quality auditor:** Purpose-built to catch failure patterns specific to AI-generated frontends — duplicate element IDs, event handlers referencing undefined functions, forms with no submission mechanism, 404s on asset references, low-quality aria labels, duplicate meta tags, hardcoded localhost URLs, placeholder href links, excessive console.log calls, mixed HTTP content on HTTPS pages, and hardcoded placeholder text (Lorem ipsum, test@test.com, TODO/FIXME).

### Gmail integration for email verification testing

`src/utils/gmail.ts` connects to a dedicated Gmail inbox via the Gmail API (OAuth2, read-only scope) to fully automate email verification testing. After a test registers an account, Sentinel polls the real inbox, extracts the real verification or order-confirmation link from the email body, and navigates to it — proving the entire email round-trip works with zero manual intervention. This is how the Firebase Hosting domain redirect issue (above) was discovered: a fully automated test caught something a manual click-through would only find by accident.

**Token maintenance:** the OAuth refresh token (`GMAIL_REFRESH_TOKEN`) periodically expires or is revoked and needs re-authorization — tests fail fast with an explicit `SENTINEL INFRASTRUCTURE ISSUE` error when this happens, rather than a confusing generic timeout. Publishing the OAuth consent screen (now done) extends the token's lifetime considerably versus the default short-lived testing-mode token, but re-authorization can still be required occasionally. When the token is refreshed, update it in **both** places — the local `.env` and the repo's GitHub Actions secret (`GMAIL_REFRESH_TOKEN` under Settings → Secrets and variables → Actions) — or the two environments will silently drift out of sync.

### Journey runner

`src/runners/journey-runner.ts` executes declarative flow tests defined in `src/config/journeys.ts`. Each journey is a sequence of steps (click, fill, select, waitFor, assert) with human-readable descriptions. The runner takes a screenshot only when a step fails, saving it with the journey ID and step index for easy debugging.

Journey definitions are separated from test logic so new flows can be added as config without writing Playwright code.

### Report generator

`src/reports/sentinel-reporter.ts` is a custom Playwright Reporter that collects results from all test projects as they run. It parses `[FINDING]` log lines from test output, collects audit-result attachments, and generates a single self-contained HTML report.

The report includes a branded header, severity metric strip, executive summary, test results grouped by project (with client-friendly descriptions for every test), audit findings grouped by rule (with "Why this matters" and "How to fix" guidance), and security findings with severity badges.

Reports are named `sentinel-report-YYYY-MM-DD-HHmmss.html` and written to `reports/`.

A second, separate Test Case Report (`src/reports/test-case-reporter.ts`) is generated alongside it — a deterministic, test-management-tool style document with Test ID / Scenario / Category / Steps / Expected / Actual / Status / Remediation columns, sortable and filterable, better suited to documenting business-scenario verification than the findings-and-severity format.

### Risk Coverage

The findings report includes a Risk Coverage section that maps real test results to a documented set of business risks (`src/reports/risk-map.ts`), rather than leaving the reader to infer risk posture from a raw pass/fail list. Each risk entry lists the test name/tag patterns that exercise it; the reporter matches those patterns against the actual run's results and computes a confidence rating from what genuinely happened in that run, not a static claim.

Confidence is one of four states:
- **High** — the matching tests passed with no related findings logged against them.
- **Passed with findings — review** — the matching tests passed (no hard assertion failed), but at least one logged a `[FINDING]` at critical/high severity that relates to this risk. This exists as its own state because a Playwright "pass" only means no `expect()` failed — many tests in this codebase log soft findings via `console.error` without a hard assertion, so a bare pass/fail would silently overstate confidence on a risk that actually has an open, high-severity finding against it.
- **Low** — the matching test(s) failed outright.
- **Not evaluated this run** — no test in the current run matched this risk's patterns (e.g. a project was skipped via `--project` or `--grep`).

Because confidence is derived per run from the actual results, it moves with reality — a risk showing "High" in one report and "Passed with findings — review" in the next reflects a genuine change in what that run found, not a stale label.

### Site discovery

The discovery module auto-maps all interactive elements on a target site, outputting `reports/discovery.json`. This eliminates the manual work of hunting for selectors when testing a new site. The JSON map feeds directly into journey configuration.

## Environment setup

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
git clone https://github.com/Col1987/Sentinel.git
cd Sentinel
npm install
npx playwright install chromium
```

### Configuration

Create a `.env` file in the project root (gitignored):

```env
ADMIN_EMAIL=your-admin@example.com
ADMIN_PASSWORD=your-admin-password
SENTINEL_LIVE_MODE=false
```

The target site is configured in `src/config/sites.ts`. Changing `baseUrl` is enough to point the auditor modules (accessibility, SEO, code quality, discovery, broken links) at a different site. The business-flow journey tests, admin/checkout page objects, and Firebase-specific patterns in `CLAUDE.md` are built against juelhaus.co.za's actual DOM — targeting a different site's business flows needs new selectors and journey configs, not just a `baseUrl` change. See the coverage note at the top of this README.

### Running tests

```bash
# Full suite
npx playwright test

# Individual projects
npx playwright test --project=smoke
npx playwright test --project=functional
npx playwright test --project=security
npx playwright test --project=audit
npx playwright test --project=admin
npx playwright test --project=regression   # LIVE_MODE only — see "Safe mode vs Live mode" below

# Site discovery
npm run discover

# View the generated report
# Check reports/ for the latest sentinel-report-*.html file
```

## Safe mode vs Live mode

By default, Sentinel runs in safe mode (`SENTINEL_LIVE_MODE=false`). All outbound requests to backend services (Firebase Cloud Functions, auth endpoints) are intercepted before they leave the browser. No data is created, modified, or deleted on the target site.

In live mode (`SENTINEL_LIVE_MODE=true`), requests pass through to real backends. This enables full end-to-end verification but requires explicit permission from the site owner. A console warning is printed at the start of every live mode run.

## CI/CD

GitHub Actions runs the audit suite on every push to main and on a daily cron schedule. Reports are uploaded as build artifacts. The pipeline uses a single worker to avoid resource contention in CI.

### Nightly regression (LIVE_MODE)

`.github/workflows/nightly-regression.yml` runs the `regression` project against the real backend once daily at 02:00 UTC (off-peak), plus `workflow_dispatch` for manual triggering on demand. Unlike the safe-mode `audit.yml` pipeline, this workflow sets `SENTINEL_LIVE_MODE=true` — it creates real sandbox orders, sends real login attempts, and polls a real Gmail inbox for verification emails, exercising the full checkout → order lifecycle → email flow end-to-end. `--workers=1` is passed explicitly (matching what `playwright.config.ts` already forces whenever `SENTINEL_LIVE_MODE` is `true`), since concurrent workers logging into the same real admin account causes session/UI-state races. Generated reports are uploaded as a workflow artifact, retrievable from the Actions run summary without needing local access.

This workflow requires the following secrets to be configured under the repo's **Settings → Secrets and variables → Actions** before it will run successfully: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. Without them, the regression suite's admin-login and Gmail-polling helpers will throw immediately (`loginAsAdmin`, `getLatestVerificationEmail`) rather than running with blank credentials.

### Commit review (AI)

`.github/workflows/commit-review.yml` (`scripts/commit-review.ts`) runs automatically on every push to any branch. It sends the diff of the pushed commit(s) — not the full codebase — to Claude in a single scoped API call, checking for a fixed list of vibe-coding failure patterns: orphaned event handlers, dead forms, hardcoded API keys/credentials, duplicate HTML element IDs, placeholder content left in, `console.log` left in, hardcoded localhost references, comments that don't match the actual code, and suspicious duplicated logic. Findings print to the workflow log with a severity (critical/high/medium/low/info). The check only fails the build (non-zero exit) when a **critical** finding is returned — everything else is informational only and does not block the push. This is one deterministic API call per push, not an autonomous agent: one diff in, one structured JSON verdict out, nothing else.

**Distinct from the code-quality auditor** (`src/auditors/code-quality.ts`, part of the `audit` project — see "Auditors" above): that auditor scans the **deployed** target site's live DOM after the fact — rendered HTML, runtime script behavior. This workflow reviews the **source diff itself, before deployment**, at commit time. The two check some overlapping failure categories from genuinely different vantage points (post-deploy DOM vs. pre-deploy source); neither replaces the other, and running both is intentional, not redundant.

**Scope limitation — read this before trusting a clean result.** This review only ever sees the diff of the pushed commit(s). It cannot see cross-file usage, whether a changed function is called safely elsewhere in the codebase, whether it duplicates something in a file the diff doesn't touch, or whether it contradicts an earlier architectural decision made outside the diff. A clean result means "no obvious instance of the listed pattern types found in this diff" — it does not mean the change is broadly safe. The script prints this same caveat as a banner on every run, and the system prompt instructs Claude to phrase its own summary the same way, so this is never mistaken for a more thorough review than it actually is.

Requires `ANTHROPIC_API_KEY` configured as a GitHub Actions secret (**Settings → Secrets and variables → Actions**) — the same key already used locally by `npm run review` (see "Post-debugging diff review" below), now also required in CI for this workflow specifically. Until that secret is added, the workflow treats itself as intentionally disabled rather than broken: it logs that commit review is inactive and exits 0, so commits are never blocked or shown with a failing check just because the feature hasn't been configured yet.

## Development approach

This project was built using a CLAUDE.md-driven workflow with Claude Code in VS Code for implementation and Claude (chat) for architectural design, test planning, and code review. The CLAUDE.md file in the project root provides Claude Code with the project context, conventions, and hard rules it needs to produce consistent output.

Alongside CLAUDE.md, this project also uses Claude Code project skills (`.claude/skills/`) for packaging reusable procedures rather than standing context. Currently one skill exists — `investigate-hang` — which packages the diagnostic-first investigation sequence for slow or timing-out tests: check known bug patterns before assuming something new, fix infrastructure causes and re-run before trusting the assertion underneath, and respect the debugging circuit breaker.

Key design decisions:
- Auditors report findings without failing the pipeline. The report is where findings live.
- Tests fail hard when expected elements are missing (not graceful skip) because a missing element is either a site change or a wrong selector, both of which need investigation.
- All `waitForTimeout` calls have been replaced with deterministic waits to prevent flaky tests in CI.
- No independent timeouts in shared helpers or journey steps. Helpers like `loginAsAdmin` and the journey runner inherit the calling test's timeout budget. A helper that sets its own timeout creates a hidden failure ceiling that contradicts `test.slow()` and produces misleading error messages.
- Shared utilities (`src/utils/`, `src/runners/`) are reviewed with the same reliability standards as test files. A flaky helper breaks every test that uses it.
- The framework must work against any website. Site-specific assumptions are never hardcoded into core modules.
- **Mode-agnostic test design.** Every test is written to work in both safe mode and LIVE_MODE by default, asserting whatever it can prove in the active mode rather than being written exclusively for one. In safe mode, tests intercept the outgoing request and assert on what the client sends. In LIVE_MODE, they additionally verify what the server actually did. `test.skip(!LIVE_MODE)` is reserved only for tests that are structurally impossible to verify without a real backend (e.g. idempotency/race-condition checks).
- **Test cost awareness.** Before repeating an expensive operation (a full checkout flow, a full registration) across multiple variations, prefer cheap direct data verification over repeating the expensive flow when only the data differs, not the mechanism. When the full flow must be repeated, a representative sample is usually sufficient over exhaustive repetition. Parallel execution is a deliberate choice weighed against resource/rate-limit risk, not a default speed fix.
- **Debugging circuit breaker.** If a single test requires more than 2 consecutive live-debugging patches in one session without reaching a clean pass, the file is reverted to its last known-good commit and rewritten fresh in a later session, rather than continuing to chase the failure live. Repeated live-patching under pressure is a proven way to burn significant time chasing a hang one symptom at a time.

### Post-debugging diff review

`npm run review` (`scripts/review-diff.ts`) is a lightweight, manually-triggered script for the moment right after a debugging session that involved 2+ live-patch attempts — the exact scenario the circuit breaker above is about. Before building more work on top of a patched file, it sends the diff plus the full text of CLAUDE.md to Claude in a single API call and asks it to flag two things: (a) a change that contradicts or reverts an earlier fix visible elsewhere in the same diff, and (b) a specific CLAUDE.md convention the diff appears to violate, citing the rule. It prints the result to the console — it does not auto-apply anything, does not fail any process, and this script itself is not wired into CI or any test run (it is invoked manually, on demand).

```bash
npm run review                  # git diff HEAD — working tree vs last commit (default)
npm run review -- HEAD~3        # git diff HEAD~3
npm run review -- main...HEAD   # any valid git diff ref range
```

Requires `ANTHROPIC_API_KEY` set in your local `.env` (see `.env.example`) for local use. The same secret is also required in CI, but by the separate "Commit review (AI)" workflow above (`scripts/commit-review.ts`) — not by this script. The two scripts share the underlying git-diff helper (`scripts/lib/git-diff.ts`) but serve different purposes: this one is a manual, conversational-style review against CLAUDE.md's conventions; that one is an automatic, structured pass/fail check against a fixed list of failure patterns on every push.

## Roadmap

**Phase 1: Safe-mode framework and reporting (complete)**

Built the full test engine — now 206 tests across smoke, functional, security, audit, and admin projects, all running in safe mode with outbound requests intercepted. Unified HTML reporter generates client-ready reports with findings, severity metrics, and fix guidance. CI pipeline runs on push and daily cron. Site discovery auto-maps interactive elements. Reliability audit eliminated all flaky waits and independent timeouts.

**Phase 2: Live-mode execution (in progress)**

Full checkout through real PayFast sandbox, order lifecycle status progression, waybill persistence, welcome page rendering against real guest data, full admin pack CRUD lifecycle, login lockout and session persistence, and automated email verification via Gmail API are all confirmed working end-to-end against the real backend.

Business-scenario testing across all four dimensions is now complete. Customer/property variation (multi-property account management confirmed working end-to-end — full create/edit/delete against saved properties, not single-property-per-account as earlier assumed; international phone formats validated). Cart/product combinations (every pack's data verified, checkout confirmed working for a representative sample, two significant findings surfaced — a dropped cart item in multi-pack checkouts, and Wi-Fi configuration not reaching the welcome page in multi-item carts). Abuse/security testing (price and quantity manipulation confirmed impossible, order ID enumeration confirmed safe, no cart data loss across concurrent sessions, PayFast payment-ownership and double-charge protection both confirmed). Cross-customer data boundary correctness: welcome pages and order tracking are correctly scoped per customer with no cross-contamination; one finding surfaced — the admin order search uses substring matching rather than exact-email scoping, meaning a search for one customer's email can return another customer's order when email addresses share a common base string.

The second, separate Test Case Report (distinct from the Findings Report) is built — see "Report generator" under How it works. A Risk Coverage view mapping test results to documented business risks with per-run confidence ratings is also built — see "Risk Coverage" under How it works.

**Phase 3: Self-service portal**

Build a web frontend where a user can log in, input a target URL, choose safe or live mode, and trigger a full Sentinel audit. The portal runs the test suite as a background job and delivers the branded HTML report when complete. Includes domain verification (DNS TXT or meta tag) to confirm site ownership before running security probes. This turns Sentinel from a developer tool into a product.

## Licence

MIT
