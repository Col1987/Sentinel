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

146 tests across 5 projects, running in under 2 minutes.

**Smoke (11 tests):** Homepage returns 200, no console errors, page title present. All 7 known pages respond without a server error (checked in parallel via HTTP, completes in under 500ms). Navigation bar visible with at least one link. Primary CTA button ("Get Started" or "Book a Demo") present. Footer rendered. CSS stylesheets loaded with non-default computed styling applied. Firebase SDK initialised. All homepage images load without broken-image errors. Page load time measured and flagged if over 5 s (medium) or 10 s (high).

**Functional (63 tests):** Demo booking form (10 scenarios including validation, XSS, boundary inputs, double-submit), registration form (8 scenarios including password mismatch, phone validation, terms enforcement), login form (6 scenarios), forgot password (4 scenarios), navigation and anchor scrolling (5 tests), modal open/close and cross-modal navigation (9 tests), responsive/mobile (7 tests across three viewport groups — 375px mobile, 768px tablet boundary, and explicit 375px/1280px horizontal overflow checks), storefront cart behaviour (9 tests including multi-item accumulation, cross-page persistence, and badge-to-drawer count consistency), demo modal lifecycle (2 tests), auth flows including logout (3 tests), order tracking deeplinks (2 tests).

**Security (37 tests):** Auth bypass and direct page access (3 tests), cart manipulation and empty checkout (3 tests), console injection and DOM bypass (3 tests), credential exposure scanning for PayFast keys, TCG API keys, MD5 libraries, and deprecated project references (5 tests), CSP header validation (1 test), checkout abuse including XSS, empty submit, and price-in-DOM scanning (5 tests), welcome page XSS, collection address leak, QR data leak (5 tests), order tracking XSS, SQL injection, sensitive data scanning, cross-user access probing (6 tests), public page console error sweep across all known pages (1 test), security response headers (HSTS, X-Content-Type-Options, X-Frame-Options/CSP frame-ancestors, Referrer-Policy, Permissions-Policy) and cookie security flags (Secure, HttpOnly, SameSite) (2 tests).

**Audit (4 tests):** Accessibility via axe-core (WCAG AA) across all 6 known public pages (homepage, account, checkout, order tracking, welcome, terms) with findings grouped by page, SEO audit across all 6 pages checking title length, meta description, h1 count, heading hierarchy, Open Graph tags, canonical URL, lang attribute, and image alt attributes, broken link verification with browser fallback, interactive element discovery with selector mapping.

**Admin (32 tests):** Dashboard stats and tab navigation (2 tests), order management structure and detail view (2 tests), pack CRUD flows with create, edit, and delete confirmation (4 tests), user management list and detail (3 tests), order flows with filtering, search, and CSV export (5 tests), negative access control with DOM bypass, unauthenticated tab forcing, and session expiry (3 tests), negative order abuse with XSS, SQL injection, and unauthenticated export (4 tests), negative pack abuse with empty/negative/zero price and XSS (5 tests), negative user abuse with credential scanning and role escalation probing (2 tests), access control and auth gate verification (2 tests).

## Key findings on juelhaus.co.za

**Security:**
- Demo form accepts empty name submission when the HTML `required` attribute is stripped via DevTools. No JS-level validation guard exists in the submit handler.
- 19 JavaScript functions exposed globally on `window` (addToCart, handleLogin, goToCheckout, etc). Callable from the browser console by any visitor.
- Admin dashboard HTML renders before Firebase auth resolves. Content is in the DOM behind the auth overlay before authentication completes.

**Accessibility:**
- 24 WCAG AA colour contrast violations across the homepage.
- 15 form inputs with no accessible label (screen readers cannot identify them).
- 16 landmark/region violations (content outside semantic landmarks).
- Auth modal does not close on Escape key. Keyboard users cannot dismiss it.
- Mobile hamburger menu z-index blocks its own close button.

**SEO:**
- Homepage title is 74 characters, exceeding the 60-character SERP display limit. Current value: "Juel Haus | Guest Experience Platform for Airbnb & Short-Term Rental Hosts".
- Canonical URL (`<link rel="canonical">`) missing on all 6 pages. Without it, search engines may index multiple URL variants and split link equity.
- No `<h1>` heading on account, checkout, or welcome pages. Search engines use the h1 as the primary topical signal for each page.
- Meta description on account and checkout pages is 188 characters, exceeding the 160-character limit. Google will truncate or auto-generate a replacement snippet.
- Open Graph tags (og:title, og:description, og:image) missing on account, tracking, welcome, and terms pages. Shared links on social platforms will render without a preview.
- Heading hierarchy skips a level on the terms page (h1 → h3 with no h2). Breaks document outline for both search engines and screen reader navigation.
- 17 findings across 6 pages. Homepage and terms each show 2 findings; account shows 4.

**Functional:**
- Cart total display does not reset after removing the last item. Badge shows 0 but price stays at R1,200.
- No confirmation prompt before pack deletion in admin portal.

**Positive confirmations:**
- No PayFast credentials, TCG API keys, or MD5 libraries in client-side JavaScript.
- No deprecated project references (baylinhaus-c9d41) anywhere in the codebase.
- Firestore security rules hold under DOM bypass. Removing the auth overlay exposes no real data.
- Zero console errors across all 6 known pages.
- XSS blocked on every tested input across public site and admin portal.
- SQL injection payloads handled gracefully on order tracking and admin search.
- Double-submit protection on demo form confirmed.
- Custom phone validation on registration form (not just browser `type="tel"`).
- Empty cart checkout blocked both via UI and direct `goToCheckout()` console call.
- CSV export blocked for unauthenticated visitors.

## How it works

### Auditors

Each auditor module in `src/auditors/` implements the `AuditResult` interface from `src/auditors/types.ts`. Auditors scan pages for specific issue categories and return structured findings with severity levels.

- **Links auditor:** Collects every `<a href>` on the page, checks each with an HTTP HEAD request, and falls back to full browser navigation for pages that require JavaScript to render. Eliminates false positives from client-rendered pages.
- **Accessibility auditor:** Runs axe-core via `@axe-core/playwright` against configured pages. Maps axe impact levels to the Sentinel severity enum.
- **Discovery auditor:** Navigates to each configured page and maps every interactive element (forms, inputs, buttons, links, selects, textareas). Extracts the most reliable selector for each element and outputs a JSON map to `reports/discovery.json`. Also flags elements with no accessible name.

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

## Development approach

This project was built using a CLAUDE.md-driven workflow with Claude Code in VS Code for implementation and Claude (chat) for architectural design, test planning, and code review. The CLAUDE.md file in the project root provides Claude Code with the project context, conventions, and hard rules it needs to produce consistent output.

Key design decisions:
- Auditors report findings without failing the pipeline. The report is where findings live.
- Tests fail hard when expected elements are missing (not graceful skip) because a missing element is either a site change or a wrong selector, both of which need investigation.
- All `waitForTimeout` calls have been replaced with deterministic waits to prevent flaky tests in CI.
- No independent timeouts in shared helpers or journey steps. Helpers like `loginAsAdmin` and the journey runner inherit the calling test's timeout budget. A helper that sets its own timeout creates a hidden failure ceiling that contradicts `test.slow()` and produces misleading error messages.
- Shared utilities (`src/utils/`, `src/runners/`) are reviewed with the same reliability standards as test files. A flaky helper breaks every test that uses it.
- The framework must work against any website. Site-specific assumptions are never hardcoded into core modules.

## Roadmap

**Phase 1: Safe-mode framework and reporting (complete)**

Built the full test engine, 146 tests across smoke, functional, security, audit, and admin projects. All tests run in safe mode with outbound requests intercepted. Unified HTML reporter generates client-ready reports with findings, severity metrics, and fix guidance. CI pipeline runs on push and daily cron. Site discovery auto-maps interactive elements. Reliability audit eliminated all flaky waits and independent timeouts.

**Phase 2: Live-mode execution**

Flip `SENTINEL_LIVE_MODE=true` and run the full suite against real backends with the site owner's permission. This verifies server-side validation, end-to-end checkout flows, email delivery, real order tracking, and authenticated user journeys that safe mode cannot fully test. Requires a test user account and a PayFast sandbox environment for payment flow verification.

**Phase 3: Self-service portal**

Build a web frontend where a user can log in, input a target URL, choose safe or live mode, and trigger a full Sentinel audit. The portal runs the test suite as a background job and delivers the branded HTML report when complete. Includes domain verification (DNS TXT or meta tag) to confirm site ownership before running security probes. This turns Sentinel from a developer tool into a product.

## Licence

MIT
