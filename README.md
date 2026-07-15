# Sentinel

An AI-powered website testing framework that runs against any site to identify risks, defects, accessibility issues, and workflow gaps. Built with Playwright and TypeScript.

Currently targeting [juelhaus.co.za](https://www.juelhaus.co.za) as the first test subject (owner permission granted).

## What it does

Sentinel combines automated auditing with targeted flow testing to produce a professional HTML report. One command runs the full suite and generates a branded, client-ready document with findings grouped by severity, plain-English explanations, and fix guidance.

The framework is designed to work against any website. Site-specific test configuration (URLs, selectors, journey definitions) is separated from the core engine so the same auditors and runner can be pointed at a new target with minimal setup.

## Architecture

```
sentinel/
  src/
    auditors/         Standalone audit modules (links, accessibility, discovery)
    config/           Site configuration, journey definitions, environment setup
    runners/          Journey runner that executes declarative flow tests
    reports/          Unified Playwright reporter generating branded HTML
    utils/            Shared helpers (auth, logging)
  tests/
    smoke/            Quick health checks (HTTP status, console errors, page title)
    functional/       User workflow tests (forms, navigation, modals, cart, auth)
    security/         Adversarial tests (XSS, injection, credential exposure, DOM bypass)
    audits/           Auditor-driven tests (accessibility, broken links, discovery)
    admin/            Admin portal tests (dashboard, orders, packs, users)
    admin/negative/   Admin security tests (access control bypass, data exposure)
  reports/            Generated report output (gitignored)
  .github/workflows/  CI pipeline (runs on push and daily cron)
```

## Current test coverage

150+ tests across 5 projects in safe mode, plus a growing suite of LIVE_MODE end-to-end tests that exercise real backends (Firebase Auth, Cloud Functions, PayFast sandbox, Gmail) with explicit owner permission.

**Smoke (11 tests):** Page availability across all known routes, critical UI elements present, CSS/JS loaded correctly, no broken images, homepage load time threshold.

**Functional (60+ tests):** Demo booking form, registration form (including international phone number formats), login form, forgot password, navigation and anchor scrolling, modal open/close and cross-modal navigation, responsive/mobile including tablet boundary and horizontal overflow checks, storefront cart behaviour, demo modal lifecycle, auth flows including logout and session persistence, order tracking deeplinks, Watch Demo button content check.

**Security (37+ tests):** Auth bypass, cart manipulation, console injection and DOM bypass, credential exposure scanning, security headers (HSTS, CSP, X-Frame-Options), checkout abuse including price/quantity manipulation via DevTools, welcome page XSS and data leak checks, order tracking XSS/SQL injection/enumeration, public page console error sweep.

**Audit (4 tests):** Accessibility via axe-core across all known pages, broken link verification with browser fallback, interactive element discovery, SEO auditor (titles, meta descriptions, heading hierarchy, Open Graph, canonicals, alt text), and an 11-check code quality auditor purpose-built to catch AI-generated code failure patterns (duplicate IDs, orphaned event handlers, dead forms, phantom asset references, low-quality aria labels, duplicate meta tags, hardcoded localhost URLs, placeholder href links, excessive console.log, mixed content, hardcoded test data).

**Admin (32+ tests):** Dashboard, order management, pack CRUD, user management, negative access control (DOM bypass, session expiry, unauthenticated export), negative order/pack/user abuse (XSS, SQL injection, role escalation probing).

**LIVE_MODE end-to-end (new):** Full checkout through real PayFast sandbox with order creation confirmed in admin. Order lifecycle testing — status progression through all 6 stages (Pending → Assembling → Ready for Collection → In Transit → Delivered → Completed) with persistence verification, waybill entry and save. Welcome page rendering verified against real guest/property data from a real order. Full admin pack CRUD lifecycle (create → verify on storefront → edit → delete) against the real database. Login lockout and session persistence testing, including Firebase's brute-force protection and the Remember Me persistence mechanism. Automated email verification testing via Gmail API — Sentinel reads the real inbox, extracts the real verification link, and follows it, with zero manual intervention. Price and quantity manipulation testing (confirmed server-side price lookup, no client-supplied price accepted). Order ID enumeration testing against real order IDs. Multi-property and international phone number registration testing.

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

**Functional:**
- Cart total display does not reset after removing the last item. Badge shows 0 but price stays.
- No confirmation prompt before pack deletion in admin portal.
- Welcome page does not display which pack the guest ordered.
- Storefront serves a cached version of pack data after an admin edit — changes don't reflect immediately.
- Failed login lockout (Firebase's brute-force protection) shows no message to the user. The form silently stops accepting the correct password with no explanation.
- **The platform drops one item when two different packs are added to cart and checked out together.** A cart with two packs produces an order for only one — confirmed via the real admin order total being short by exactly one pack's price plus its share of delivery. This is a revenue-affecting defect: a customer ordering multiple packs in one checkout may be charged for or receive fewer items than they ordered.
- **Wi-Fi configuration does not reach the welcome page in a multi-item cart.** Wi-Fi is architecturally per-order, not per-item — when Wi-Fi credentials are entered for one item in a two-item cart, the welcome page's Wi-Fi display does not appear for either item. Worth confirming with the site owner whether this is intended (one Wi-Fi config per order) or a gap, but as observed the entered credentials do not surface anywhere on the guest-facing page.
- The site reuses the same HTML element IDs across multiple cart items in the checkout config forms rather than generating unique IDs per item. Duplicate IDs violate the HTML spec and can cause unpredictable behaviour in form handling and accessibility tooling.

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

### Journey runner

`src/runners/journey-runner.ts` executes declarative flow tests defined in `src/config/journeys.ts`. Each journey is a sequence of steps (click, fill, select, waitFor, assert) with human-readable descriptions. The runner takes a screenshot only when a step fails, saving it with the journey ID and step index for easy debugging.

Journey definitions are separated from test logic so new flows can be added as config without writing Playwright code.

### Report generator

`src/reports/sentinel-reporter.ts` is a custom Playwright Reporter that collects results from all test projects as they run. It parses `[FINDING]` log lines from test output, collects audit-result attachments, and generates a single self-contained HTML report.

The report includes a branded header, severity metric strip, executive summary, test results grouped by project (with client-friendly descriptions for every test), audit findings grouped by rule (with "Why this matters" and "How to fix" guidance), and security findings with severity badges.

Reports are named `sentinel-report-YYYY-MM-DD-HHmmss.html` and written to `reports/`.

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

The target site is configured in `src/config/sites.ts`. Change `baseUrl` to point at a different site.

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

## Development approach

This project was built using a CLAUDE.md-driven workflow with Claude Code in VS Code for implementation and Claude (chat) for architectural design, test planning, and code review. The CLAUDE.md file in the project root provides Claude Code with the project context, conventions, and hard rules it needs to produce consistent output.

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

## Roadmap

**Phase 1: Safe-mode framework and reporting (complete)**

Built the full test engine, 130 tests across smoke, functional, security, audit, and admin projects. All tests run in safe mode with outbound requests intercepted. Unified HTML reporter generates client-ready reports with findings, severity metrics, and fix guidance. CI pipeline runs on push and daily cron. Site discovery auto-maps interactive elements. Reliability audit eliminated all flaky waits and independent timeouts.

**Phase 2: Live-mode execution (in progress)**

Full checkout through real PayFast sandbox, order lifecycle status progression, waybill persistence, welcome page rendering against real guest data, full admin pack CRUD lifecycle, login lockout and session persistence, and automated email verification via Gmail API are all confirmed working end-to-end against the real backend.

Business-scenario testing across all four dimensions is now complete. Customer/property variation (single-property-per-account architecture confirmed, international phone formats validated). Cart/product combinations (every pack's data verified, checkout confirmed working for a representative sample, two significant findings surfaced — a dropped cart item in multi-pack checkouts, and Wi-Fi configuration not reaching the welcome page in multi-item carts). Abuse/security testing (price and quantity manipulation confirmed impossible, order ID enumeration confirmed safe, no cart data loss across concurrent sessions). Cross-customer data boundary correctness: welcome pages and order tracking are correctly scoped per customer with no cross-contamination; one finding surfaced — the admin order search uses substring matching rather than exact-email scoping, meaning a search for one customer's email can return another customer's order when email addresses share a common base string.

A second, separate Test Case Report (distinct from the Findings Report) is planned — deterministic, test-management-tool style with Test ID / Scenario / Steps / Expected / Actual / Status / Remediation columns, better suited to documenting business-scenario verification than the findings-and-severity format.

**Phase 3: Self-service portal**

Build a web frontend where a user can log in, input a target URL, choose safe or live mode, and trigger a full Sentinel audit. The portal runs the test suite as a background job and delivers the branded HTML report when complete. Includes domain verification (DNS TXT or meta tag) to confirm site ownership before running security probes. This turns Sentinel from a developer tool into a product.

## Licence

MIT
