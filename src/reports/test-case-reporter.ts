import * as fs from 'fs';
import * as path from 'path';
import type {
  Reporter,
  TestCase,
  TestResult,
  FullConfig,
  FullResult,
} from '@playwright/test/reporter';
import { RULE_GUIDANCE, getGuidance, INFRA_ISSUE_MARKER, type Guidance } from './sentinel-reporter';

// A second, standalone report: a deterministic, test-management-tool style Test Case
// Report (Test ID / Scenario / Category / Steps / Expected / Actual / Status /
// Remediation), distinct from Sentinel's findings-and-severity report. Registered as an
// additional Playwright reporter alongside sentinel-reporter.ts — both build independently
// from the same test run and write separate output files.

// ─── Types ──────────────────────────────────────────────────────────────────

type Status = 'Pass' | 'Fail' | 'Skip';

interface TestCaseRecord {
  testId: string;
  scenario: string;
  category: string;
  categoryInferred: boolean;
  steps: string[];
  expected: string;
  expectedInferred: boolean;
  actual: string;
  status: Status;
  remediation: string;
  project: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_COLOUR: Record<Status, { fg: string; bg: string }> = {
  Pass: { fg: '#047857', bg: '#d1fae5' },
  Fail: { fg: '#be123c', bg: '#ffe4e6' },
  Skip: { fg: '#475569', bg: '#f1f5f9' },
};

const CATEGORY_COLOUR: Record<string, { fg: string; bg: string }> = {
  'Functional':           { fg: '#4338ca', bg: '#e0e7ff' },
  'Negative':              { fg: '#b45309', bg: '#fef3c7' },
  'Negative/Adversarial':  { fg: '#be123c', bg: '#ffe4e6' },
  'Abuse':                 { fg: '#7e22ce', bg: '#f3e8ff' },
};
const DEFAULT_CATEGORY_COLOUR = { fg: '#475569', bg: '#f1f5f9' };

const BRAND_SVG = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="4" y="2" width="16" height="20" rx="2" fill="#4338ca" fill-opacity="0.28"/>
  <rect x="7" y="1" width="10" height="4" rx="1.5" fill="#818cf8"/>
  <path d="M8 11l2.2 2.2L16 7.5" stroke="#c7d2fe" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M8 16.5h8" stroke="#c7d2fe" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatFileTimestamp(ts: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${ts.getFullYear()}-${p(ts.getMonth() + 1)}-${p(ts.getDate())}-${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}`;
}

function extractOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

// Lowercase-kebab-case, stripped to a URL/id-safe character set, capped short.
function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'test';
}

// Stable, short Test ID derived from the spec file name and the test's own kebab-case
// identifier. This codebase's convention (see CLAUDE.md: "Test names describe the
// expected behaviour") is "test-id-slug — narrative description" — reuse that existing
// identifier rather than slugifying the full narrative title. Falls back to slugifying
// the whole title when no " — " separator is present.
function buildTestId(test: TestCase): string {
  const fileBase = path.basename(test.location.file).replace(/\.spec\.ts$/, '');
  const fileTag = slugify(fileBase).slice(0, 24);
  const titleIdPart = test.title.split(' — ')[0].trim();
  const titleSlug = slugify(titleIdPart);
  return `${fileTag}__${titleSlug}`;
}

// Splits on sentence boundaries. Deliberately simple — a formatting task, not an NLP
// project. Handles the well-formed, single-clause-per-sentence prose style used
// throughout this codebase's test descriptions; does not attempt to handle abbreviations
// or decimal numbers as special cases.
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map(s => s.trim())
    .filter(Boolean);
}

// Steps = every sentence except the last (the procedure). Expected = the last sentence —
// this codebase's description convention consistently closes on the stated outcome
// ("CONFIRMED: ...", "X is a finding", etc.). A single-sentence description is used for
// both, since there is nothing to cleanly split.
function stepsAndExpectedFromDescription(description: string | undefined): { steps: string[]; expected: string } {
  if (!description) return { steps: [], expected: '' };
  const sentences = splitSentences(description);
  if (sentences.length === 0) return { steps: [], expected: '' };
  if (sentences.length === 1) return { steps: sentences, expected: sentences[0] };
  return { steps: sentences.slice(0, -1), expected: sentences[sentences.length - 1] };
}

// Category derivation order, most-specific signal first: an abuse/negative naming
// pattern in the test's own ID is a stronger, more precise signal than its broader tag,
// so it takes precedence. Tags are checked next, then a light description keyword scan
// as a last resort. Per instruction: fall back to a sensible default and note it, rather
// than writing deeper inference logic.
const ABUSE_NAME_RE    = /manipulat|enumerat|idempotenc/i;
// Negative lookbehind excludes "non-empty"/"not-missing" style negations — observed live
// on health.spec.ts's "should-have-a-non-empty-page-title" (a functional check, not a
// negative-test-case pattern) — without building broader negation-detection logic.
const NEGATIVE_NAME_RE = /(?<!non-)(?<!not-)\b(empty|invalid|missing)\b/i;

function deriveCategory(test: TestCase, description: string | undefined): { category: string; inferred: boolean } {
  const idPart = test.title.split(' — ')[0];

  if (ABUSE_NAME_RE.test(idPart)) return { category: 'Abuse', inferred: false };
  if (NEGATIVE_NAME_RE.test(idPart)) return { category: 'Negative', inferred: false };

  // test.tags covers the {tag: [...]} option; also scan the title path text as a cheap
  // fallback for any test that embeds a tag directly in title/describe text instead.
  const tagText = [...test.tags, test.titlePath().join(' ')].join(' ').toLowerCase();
  if (tagText.includes('@security')) return { category: 'Negative/Adversarial', inferred: false };
  if (tagText.includes('@functional') || tagText.includes('@admin')) return { category: 'Functional', inferred: false };

  if (description && /malicious|unauthoriz|bypass|exploit|abuse/i.test(description)) {
    return { category: 'Negative/Adversarial', inferred: true };
  }

  return { category: 'Functional', inferred: true };
}

// Two root-cause bugs each affect more than one test (not a single specific scenario),
// so their Guidance object is shared across every currently-known-affected testId in
// TEST_REMEDIATION below, rather than duplicated per entry.
const CHECKOUT_AUTH_RACE_GUIDANCE: Guidance = {
  why: 'checkout.js polls auth.currentUser with an exit condition that resolves almost ' +
    'immediately regardless of whether Firebase\'s auth-state hydration has actually ' +
    'finished, so an unverified account non-deterministically hits a "Verify Your Email" ' +
    'gate instead of the checkout config form — see docs/ENGINEERING_LOG.md, July 20 and ' +
    '22 entries.',
  fix: 'Register through runVerifiedCheckoutFlow (tests/functional/checkout-helpers.ts) ' +
    'instead of plain registerForCheckout plus the individual checkout steps — the same ' +
    'fix already applied to the regression suite\'s checkout tests and ' +
    'admin-order-lookup-reliability.spec.ts after they hit the identical race.',
};

const GMAIL_COLLISION_GUIDANCE: Guidance = {
  why: 'getLatestVerificationEmail() (src/utils/gmail.ts) takes the most recent ' +
    'verification email from the shared Gmail inbox without checking that its recipient ' +
    'matches the account this specific test just registered — under a full-suite run, ' +
    'another test\'s verification email can be consumed instead, leaving this test\'s own ' +
    'account genuinely unverified.',
  fix: 'Add a recipient-address check to getLatestVerificationEmail() — match the ' +
    'message\'s To: header against the email this test registered before returning its ' +
    'verification link, so a busy shared inbox can never hand one test another test\'s link.',
};

// Standing findings this project already knows about and has real fix guidance for,
// matched by this report's own testId (see buildTestId) rather than a [rule-id] bracket —
// genuine test assertion failures don't carry a rule-id the way auditor findings do.
// Reuses the same Guidance shape as RULE_GUIDANCE for consistency; only .fix is shown in
// this report's Remediation column, since there's no "why" section in this table format.
const TEST_REMEDIATION: Record<string, Guidance> = {
  'storefront__cart-remove-item-updates-total': {
    why: 'Cart total display does not reset after removing the last item from the cart ' +
      'drawer — the item-count badge correctly goes to 0, but the price total remains at ' +
      'its pre-removal value.',
    fix: 'Locate the cart-total DOM update logic and confirm it recalculates from the ' +
      'current (now empty) cart array rather than only decrementing the previously ' +
      'displayed value — likely a missing "cart is empty → reset total to R0" branch.',
  },
  'storefront__get-started-scrolls-to-packs': {
    why: 'The "Get Started" button is a complete silent no-op for genuine authenticated ' +
      'customers — no scroll, no navigation, no console error — despite ' +
      'handleGetStarted()\'s own source confirming the correct branch (currentUser set, ' +
      'emailVerified true) should call #gifts.scrollIntoView().',
    fix: 'Add logging inside handleGetStarted()\'s verified-customer branch to confirm ' +
      '#gifts exists in the DOM at the moment this handler runs, and check whether an ' +
      'earlier exception in the same handler is silently aborting execution before the ' +
      'scroll call ever fires.',
  },
  'admin-gaps-live__audit-log-records-admin-actions': {
    why: 'Advancing an order\'s status — including via the Force/Override mechanism — ' +
      'does not produce a corresponding Audit Log entry; only account-level events (user ' +
      'creation, admin grants) are currently recorded.',
    fix: 'Add an Audit Log write (timestamp + acting admin identity) to the same Cloud ' +
      'Function or handler that processes an order status transition, matching the ' +
      'pattern already used for account-level events.',
  },
  'console-injection__modify-dom-required': {
    why: 'The demo booking form accepts an empty name submission once the HTML required ' +
      'attribute is removed via DevTools — there is no JavaScript-level validation guard ' +
      'in the submit handler backing up the HTML attribute.',
    fix: 'Add an explicit non-empty check on the name field inside the form\'s own submit ' +
      'handler, independent of the required HTML attribute, so a client-side DOM edit ' +
      'cannot bypass validation entirely.',
  },
  'welcome-page-live__checkout-with-wifi-configured': CHECKOUT_AUTH_RACE_GUIDANCE,
  'checkout-abuse-live__duplicate-order-idempotency': CHECKOUT_AUTH_RACE_GUIDANCE,
  'my-account-live__my-properties-actual-behavior': GMAIL_COLLISION_GUIDANCE,
  // File tag truncated to 24 chars by buildTestId ('welcome-page-content-live' is 25
  // chars) — confirmed against a real generated report rather than assumed, since this
  // truncation is easy to get wrong silently. The third key's title portion is also
  // truncated: slugify() caps at 40 chars internally, and
  // 'welcome-page-shows-restaurants-and-activities' is 46.
  'welcome-page-content-liv__welcome-page-shows-house-rules': GMAIL_COLLISION_GUIDANCE,
  'welcome-page-content-liv__welcome-page-shows-restaurants-and-activ': GMAIL_COLLISION_GUIDANCE,
  'welcome-page-content-liv__welcome-page-shows-host-contact': GMAIL_COLLISION_GUIDANCE,
};

const NO_REMEDIATION_YET = 'Remediation not yet documented for this finding — see docs/JUELHAUS_TESTING_SUMMARY.md';

// Checked in order of specificity: a Sentinel-side infrastructure marker first (this is
// never a site defect regardless of what else the error text contains), then this exact
// test's own entry in TEST_REMEDIATION, then a [rule-id]-bracketed auditor-style message
// (reusing RULE_GUIDANCE/getGuidance directly, not a parallel copy). Only a genuine test
// failure with none of the above falls through to the explicit placeholder — never a
// silent blank, so missing guidance is visibly missing rather than looking resolved.
function deriveRemediation(testId: string, errorMessage: string | undefined, isInfraIssue: boolean): string {
  if (!errorMessage) return '';

  if (isInfraIssue) {
    return 'Re-authorize Sentinel’s Gmail OAuth token — see the token refresh procedure referenced in src/utils/gmail.ts. This is a Sentinel test-infrastructure issue, not a defect in the site under test.';
  }

  if (testId in TEST_REMEDIATION) {
    return TEST_REMEDIATION[testId].fix;
  }

  const m = errorMessage.match(/\[([a-z0-9-]+)\]/i);
  if (m && m[1] in RULE_GUIDANCE) {
    return getGuidance(`[${m[1]}]`).fix;
  }

  return NO_REMEDIATION_YET;
}

// Expected-result extraction from a failure's error message: the first non-empty line,
// with a leading "Error:" stripped — this is where a custom expect(value, 'message')
// message reliably appears in Playwright's thrown error text. Falls back to the
// description-derived expected result if that line is empty or pure boilerplate.
function expectedFromError(errorMessage: string, fallback: string): string {
  const firstLine = errorMessage
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0) ?? '';
  const cleaned = firstLine.replace(/^Error:\s*/i, '').trim();
  if (!cleaned || /^(AssertionError)?:?$/i.test(cleaned)) return fallback;
  return cleaned;
}

// ─── CSS ─────────────────────────────────────────────────────────────────────
// Distinct visual identity from sentinel-reporter.ts: an indigo/violet palette, a real
// data table rather than card/accordion sections, and no shield brand mark.

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: #f5f3ff;
  color: #1e1b4b;
  padding: 2rem;
  line-height: 1.55;
  max-width: 1440px;
  margin: 0 auto;
}

/* ── Header ── */
.tc-header {
  background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%);
  border-radius: 12px;
  padding: 1.75rem 2.25rem;
  margin-bottom: 1.5rem;
  color: #eef2ff;
}
.tc-header-top { display: flex; align-items: center; gap: 0.9rem; margin-bottom: 1.5rem; }
.tc-title { font-size: 1.2rem; font-weight: 800; letter-spacing: 0.01em; }
.tc-subtitle { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: #a5b4fc; margin-top: 0.15rem; }
.tc-meta-row { display: flex; gap: 2.5rem; flex-wrap: wrap; }
.tc-meta-item { display: flex; flex-direction: column; gap: 0.22rem; }
.tc-meta-key { font-size: 0.58rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.13em; color: #818cf8; }
.tc-meta-val { font-size: 0.85rem; color: #e0e7ff; }
.tc-meta-url { font-size: 0.85rem; color: #a5b4fc; text-decoration: none; word-break: break-all; font-weight: 500; }
.tc-meta-url:hover { text-decoration: underline; }

/* ── Summary pills ── */
.tc-summary { display: flex; gap: 0.75rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
.tc-summary-pill {
  flex: 1; min-width: 130px;
  background: #fff; border: 1px solid #e0e7ff; border-radius: 999px;
  padding: 0.7rem 1.3rem;
  display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
}
.tc-summary-pill .n { font-size: 1.35rem; font-weight: 800; }
.tc-summary-pill .l { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; }

/* ── Filter controls ── */
.tc-controls {
  display: flex; align-items: center; gap: 0.9rem; flex-wrap: wrap;
  background: #fff; border: 1px solid #e0e7ff; border-radius: 10px;
  padding: 0.85rem 1.1rem; margin-bottom: 1rem;
}
.tc-controls .tc-field { display: flex; align-items: center; gap: 0.4rem; }
.tc-controls label { font-size: 0.68rem; font-weight: 700; color: #4338ca; text-transform: uppercase; letter-spacing: 0.07em; }
.tc-controls select {
  font: inherit; font-size: 0.8rem; padding: 0.35rem 0.6rem; border-radius: 6px;
  border: 1px solid #c7d2fe; background: #fff; color: #1e1b4b; cursor: pointer;
}
.tc-count { margin-left: auto; font-size: 0.76rem; color: #64748b; }

/* ── Table ── */
.tc-table-wrap { background: #fff; border: 1px solid #e0e7ff; border-radius: 10px; overflow: auto; }
table.tc-table { width: 100%; border-collapse: collapse; font-size: 0.79rem; }
table.tc-table thead th {
  background: #eef2ff; color: #312e81; text-align: left;
  font-size: 0.64rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
  padding: 0.7rem 0.85rem; border-bottom: 2px solid #c7d2fe;
  cursor: pointer; white-space: nowrap; user-select: none;
  position: sticky; top: 0;
}
table.tc-table thead th:hover { background: #e0e7ff; }
table.tc-table thead th .arrow { opacity: 0.4; margin-left: 0.25rem; font-size: 0.6rem; }
table.tc-table tbody td { padding: 0.7rem 0.85rem; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
table.tc-table tbody tr:nth-child(even) { background: #fafaff; }
table.tc-table tbody tr:hover { background: #f5f3ff; }
table.tc-table tbody tr.tc-hidden { display: none; }

.tc-id { font-family: 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 0.7rem; color: #4338ca; white-space: nowrap; }
.tc-scenario { min-width: 200px; max-width: 300px; font-weight: 600; color: #1e1b4b; }
.tc-steps { list-style: decimal; padding-left: 1.1rem; display: flex; flex-direction: column; gap: 0.2rem; min-width: 220px; max-width: 320px; color: #334155; }
.tc-cell-text { min-width: 170px; max-width: 280px; color: #334155; }
.tc-actual-fail {
  color: #be123c; font-family: 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 0.7rem;
  white-space: pre-wrap; display: block; max-height: 140px; overflow-y: auto;
}
.tc-remediation { min-width: 190px; max-width: 300px; color: #334155; }
.tc-empty { color: #cbd5e1; }
.tc-pill {
  display: inline-block; font-size: 0.64rem; font-weight: 700; padding: 0.28em 0.75em;
  border-radius: 999px; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap;
}
.tc-inferred { font-size: 0.64rem; font-weight: 500; text-transform: none; letter-spacing: 0; color: #94a3b8; font-style: italic; margin-left: 0.3rem; white-space: nowrap; }

/* ── Footer ── */
.tc-footer { text-align: center; padding: 1.75rem 0 1rem; font-size: 0.72rem; color: #a5b4fc; letter-spacing: 0.02em; }
`;

// ─── JS (filter + sort, no external libraries) ────────────────────────────────

const CLIENT_SCRIPT = `
(function () {
  var table  = document.getElementById('tcTable');
  if (!table) return;
  var tbody  = table.tBodies[0];
  var catSel = document.getElementById('tcFilterCategory');
  var statSel = document.getElementById('tcFilterStatus');
  var countEl = document.getElementById('tcVisibleCount');

  function applyFilters() {
    var cat = catSel.value;
    var stat = statSel.value;
    var visible = 0;
    Array.prototype.forEach.call(tbody.rows, function (row) {
      var matchCat = cat === 'all' || row.getAttribute('data-category') === cat;
      var matchStat = stat === 'all' || row.getAttribute('data-status') === stat;
      var show = matchCat && matchStat;
      row.classList.toggle('tc-hidden', !show);
      if (show) visible++;
    });
    if (countEl) countEl.textContent = visible + ' of ' + tbody.rows.length + ' shown';
  }

  catSel.addEventListener('change', applyFilters);
  statSel.addEventListener('change', applyFilters);
  applyFilters();

  var sortColumn = -1;
  var sortAsc = true;
  Array.prototype.forEach.call(table.tHead.rows[0].cells, function (th, colIndex) {
    th.addEventListener('click', function () {
      sortAsc = (sortColumn === colIndex) ? !sortAsc : true;
      sortColumn = colIndex;
      Array.prototype.forEach.call(table.tHead.rows[0].cells, function (h) {
        var a = h.querySelector('.arrow');
        if (a) a.textContent = '';
      });
      var arrow = th.querySelector('.arrow');
      if (arrow) arrow.textContent = sortAsc ? '\\u25B2' : '\\u25BC';

      var rows = Array.prototype.slice.call(tbody.rows);
      rows.sort(function (a, b) {
        var av = a.cells[colIndex].textContent.trim().toLowerCase();
        var bv = b.cells[colIndex].textContent.trim().toLowerCase();
        if (av < bv) return sortAsc ? -1 : 1;
        if (av > bv) return sortAsc ? 1 : -1;
        return 0;
      });
      rows.forEach(function (r) { tbody.appendChild(r); });
    });
  });
})();
`;

// ─── Reporter class ───────────────────────────────────────────────────────────

class TestCaseReporter implements Reporter {
  private readonly records: TestCaseRecord[] = [];
  private baseUrl = '';

  onBegin(config: FullConfig): void {
    this.baseUrl = (config.projects[0]?.use as Record<string, unknown>)?.baseURL as string ?? '';
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.titlePath()[1] ?? 'unknown';
    const description = test.annotations.find(a => a.type === 'description')?.description;

    let errorMessage: string | undefined;
    if (result.status === 'failed' || result.status === 'timedOut') {
      errorMessage = result.errors
        .map(e => e.message ?? String(e))
        .filter(Boolean)
        .join('\n---\n') || 'Test failed (no error message)';
    }
    const isInfraIssue = errorMessage?.includes(INFRA_ISSUE_MARKER) ?? false;

    const status: Status = result.status === 'passed'
      ? 'Pass'
      : result.status === 'skipped'
        ? 'Skip'
        : 'Fail';

    const { steps, expected: descExpected } = stepsAndExpectedFromDescription(description);
    const { category, inferred: categoryInferred } = deriveCategory(test, description);

    let expected: string;
    let expectedInferred = false;
    if (status === 'Fail' && errorMessage) {
      expected = expectedFromError(errorMessage, descExpected || 'Not stated in test description.');
      if (!descExpected) expectedInferred = true;
    } else if (descExpected) {
      expected = descExpected;
    } else {
      expected = 'Not stated in test description.';
      expectedInferred = true;
    }

    let actual: string;
    if (status === 'Pass') {
      actual = 'As expected';
    } else if (status === 'Skip') {
      const skipReason = test.annotations.find(a => a.type === 'skip')?.description;
      actual = skipReason ? `Skipped — ${skipReason}` : 'Skipped';
    } else {
      actual = errorMessage ?? 'Test failed (no error message)';
    }

    const testId = buildTestId(test);
    const remediation = status === 'Fail' ? deriveRemediation(testId, errorMessage, isInfraIssue) : '';

    const scenario = test.titlePath().slice(3).join(' › ') || test.title;

    this.records.push({
      testId,
      scenario,
      category,
      categoryInferred,
      steps,
      expected,
      expectedInferred,
      actual,
      status,
      remediation,
      project,
    });
  }

  onEnd(_result: FullResult): void {
    fs.mkdirSync('reports', { recursive: true });
    const ts = new Date();
    const isLive = process.env.SENTINEL_LIVE_MODE === 'true';
    const modeTag = isLive ? 'LIVE' : 'SAFE';
    const outputPath = path.join('reports', `sentinel-test-case-report-${formatFileTimestamp(ts)}-${modeTag}.html`);
    fs.writeFileSync(outputPath, this.buildHtml(ts), 'utf-8');
    process.stdout.write(`\nTest Case Report written → ${outputPath}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }

  private buildHtml(ts: Date): string {
    const origin = extractOrigin(this.baseUrl);
    const humanDate = ts.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'medium' });

    const total  = this.records.length;
    const passed = this.records.filter(r => r.status === 'Pass').length;
    const failed = this.records.filter(r => r.status === 'Fail').length;
    const skipped = this.records.filter(r => r.status === 'Skip').length;

    const categories = [...new Set(this.records.map(r => r.category))].sort();
    const categoryOptions = ['<option value="all">All categories</option>']
      .concat(categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`))
      .join('');
    const statusOptions = ['<option value="all">All statuses</option>']
      .concat((['Pass', 'Fail', 'Skip'] as Status[]).map(s => `<option value="${s}">${s}</option>`))
      .join('');

    const rows = this.records.map(r => {
      const statusColour = STATUS_COLOUR[r.status];
      const catColour = CATEGORY_COLOUR[r.category] ?? DEFAULT_CATEGORY_COLOUR;

      const stepsHtml = r.steps.length > 0
        ? `<ol class="tc-steps">${r.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
        : '<span class="tc-empty">—</span>';

      const expectedHtml = r.expected
        ? `${escapeHtml(r.expected)}${r.expectedInferred ? '<span class="tc-inferred">(inferred)</span>' : ''}`
        : '<span class="tc-empty">—</span>';

      const actualHtml = r.status === 'Fail'
        ? `<code class="tc-actual-fail">${escapeHtml(r.actual)}</code>`
        : escapeHtml(r.actual);

      const remediationHtml = r.remediation
        ? escapeHtml(r.remediation)
        : '<span class="tc-empty">—</span>';

      return `<tr data-category="${escapeHtml(r.category)}" data-status="${r.status}">
        <td class="tc-id">${escapeHtml(r.testId)}</td>
        <td class="tc-scenario">${escapeHtml(r.scenario)}</td>
        <td><span class="tc-pill" style="color:${catColour.fg};background:${catColour.bg}">${escapeHtml(r.category)}</span>${r.categoryInferred ? '<span class="tc-inferred">(inferred)</span>' : ''}</td>
        <td>${stepsHtml}</td>
        <td class="tc-cell-text">${expectedHtml}</td>
        <td class="tc-cell-text">${actualHtml}</td>
        <td><span class="tc-pill" style="color:${statusColour.fg};background:${statusColour.bg}">${r.status}</span></td>
        <td class="tc-remediation">${remediationHtml}</td>
      </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sentinel Test Case Report — ${escapeHtml(origin)}</title>
  <style>${CSS}</style>
</head>
<body>

  <header class="tc-header">
    <div class="tc-header-top">
      ${BRAND_SVG}
      <div>
        <div class="tc-title">Sentinel Test Case Report</div>
        <div class="tc-subtitle">Deterministic Scenario Documentation</div>
      </div>
    </div>
    <div class="tc-meta-row">
      <div class="tc-meta-item">
        <span class="tc-meta-key">Target</span>
        <a class="tc-meta-url" href="${escapeHtml(origin)}" target="_blank" rel="noopener noreferrer">${escapeHtml(origin)}</a>
      </div>
      <div class="tc-meta-item">
        <span class="tc-meta-key">Generated</span>
        <span class="tc-meta-val">${humanDate}</span>
      </div>
      <div class="tc-meta-item">
        <span class="tc-meta-key">Mode</span>
        <span class="tc-meta-val">${process.env.SENTINEL_LIVE_MODE === 'true' ? 'LIVE' : 'SAFE'}</span>
      </div>
      <div class="tc-meta-item">
        <span class="tc-meta-key">Total cases</span>
        <span class="tc-meta-val">${total}</span>
      </div>
    </div>
  </header>

  <div class="tc-summary">
    <div class="tc-summary-pill"><span class="l">Total</span><span class="n">${total}</span></div>
    <div class="tc-summary-pill"><span class="l" style="color:${STATUS_COLOUR.Pass.fg}">Pass</span><span class="n" style="color:${STATUS_COLOUR.Pass.fg}">${passed}</span></div>
    <div class="tc-summary-pill"><span class="l" style="color:${STATUS_COLOUR.Fail.fg}">Fail</span><span class="n" style="color:${STATUS_COLOUR.Fail.fg}">${failed}</span></div>
    <div class="tc-summary-pill"><span class="l" style="color:${STATUS_COLOUR.Skip.fg}">Skip</span><span class="n" style="color:${STATUS_COLOUR.Skip.fg}">${skipped}</span></div>
  </div>

  <div class="tc-controls">
    <div class="tc-field">
      <label for="tcFilterCategory">Category</label>
      <select id="tcFilterCategory">${categoryOptions}</select>
    </div>
    <div class="tc-field">
      <label for="tcFilterStatus">Status</label>
      <select id="tcFilterStatus">${statusOptions}</select>
    </div>
    <span class="tc-count" id="tcVisibleCount"></span>
  </div>

  <div class="tc-table-wrap">
    <table class="tc-table" id="tcTable">
      <thead>
        <tr>
          <th>Test ID<span class="arrow"></span></th>
          <th>Scenario<span class="arrow"></span></th>
          <th>Category<span class="arrow"></span></th>
          <th>Steps</th>
          <th>Expected Result<span class="arrow"></span></th>
          <th>Actual Result<span class="arrow"></span></th>
          <th>Status<span class="arrow"></span></th>
          <th>Remediation</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="8" class="tc-empty" style="padding:1.5rem;">No tests recorded.</td></tr>'}
      </tbody>
    </table>
  </div>

  <footer class="tc-footer">
    Test Case Report generated by Sentinel &mdash; AI-Powered Website Testing Framework
  </footer>

  <script>${CLIENT_SCRIPT}</script>

</body>
</html>`;
  }
}

export default TestCaseReporter;
