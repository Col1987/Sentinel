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
