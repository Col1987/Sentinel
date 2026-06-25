import * as fs from 'fs';
import * as path from 'path';
import type {
  Reporter,
  TestCase,
  TestResult,
  FullConfig,
  Suite,
  FullResult,
} from '@playwright/test/reporter';
import type { AuditResult, AuditFinding, Severity } from '../auditors/types';

// ─── Internal types ───────────────────────────────────────────────────────────

interface TestRecord {
  title: string;
  displayPath: string;
  project: string;
  status: TestResult['status'];
  durationMs: number;
  errorMessage?: string;
  screenshotB64?: string;
  description?: string;
}

interface FindingRecord {
  severity: Severity;
  message: string;
  testTitle: string;
  project: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const SEV_COLOUR: Record<Severity, string> = {
  critical: '#dc2626',
  high:     '#ea580c',
  medium:   '#d97706',
  low:      '#16a34a',
  info:     '#0284c7',
};

const SEV_BG: Record<Severity, string> = {
  critical: '#fef2f2',
  high:     '#fff7ed',
  medium:   '#fffbeb',
  low:      '#f0fdf4',
  info:     '#eff6ff',
};

const SHIELD_SVG = `<svg width="38" height="44" viewBox="0 0 38 44" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M19 2L3 9v12c0 12.4 7.1 24 16 27 8.9-3 16-14.6 16-27V9L19 2z" fill="#1e40af" fill-opacity="0.3"/>
  <path d="M19 6L6 12v9c0 10.2 5.9 19.7 13 22 7.1-2.3 13-11.8 13-22v-9L19 6z" fill="#3b82f6"/>
  <path d="M12 22l5 5 9-9" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ─── Rule guidance table ──────────────────────────────────────────────────────

interface Guidance { why: string; fix: string }

const RULE_GUIDANCE: Record<string, Guidance> = {
  'color-contrast': {
    why: 'Users with low vision, color blindness, or age-related visual decline depend on sufficient contrast to read content. Poor contrast also reduces legibility on mobile screens in bright sunlight and on budget displays used in emerging markets.',
    fix: 'Increase the contrast ratio to at least 4.5:1 for body text and 3:1 for large text (18 pt or 14 pt bold). Use the WebAIM Contrast Checker to find compliant values that still align with your brand palette. The fix is typically a single CSS colour change.',
  },
  'image-alt': {
    why: 'Screen readers convey image content to blind and low-vision users by reading the alt attribute. Without it, the image is announced as a raw filename or skipped entirely, removing context that may be critical to understanding the page.',
    fix: 'Add descriptive alt text to every meaningful image describing what it communicates, not what it depicts. For purely decorative images, use alt="" to instruct screen readers to skip them. Never use the filename or "image of" as alt text.',
  },
  'label': {
    why: 'Form inputs without labels are invisible to screen readers. Users cannot tell what a field expects, which directly reduces conversion rates, increases form abandonment, and generates avoidable support enquiries.',
    fix: 'Associate every input with a <label> element using matching for and id attributes. For icon-only or inline controls, provide an aria-label or aria-labelledby attribute. Every interactive form field must have a programmatic label.',
  },
  'link-name': {
    why: 'Screen reader users navigate pages by cycling through links without reading surrounding text. A link with no discernible name is announced simply as "link", making navigation impossible for millions of users who depend on assistive technology.',
    fix: 'Ensure every anchor element contains visible text, or supply an aria-label describing the destination. For icon-only links, add visually-hidden text via CSS (clip-pattern) or set aria-label directly on the <a> element.',
  },
  'button-name': {
    why: 'Icon-only buttons or buttons with empty text prevent assistive-technology users from understanding or activating controls. This directly blocks task completion for keyboard and screen reader users.',
    fix: 'Add visible text to every button. For icon-only buttons, use aria-label to describe the action — "Close dialog" rather than "X". The label must match what the button does when activated.',
  },
  'html-has-lang': {
    why: 'Screen readers select the correct speech synthesis engine based on the declared page language. Without a lang attribute, content may be read using the wrong language engine, producing unintelligible pronunciation.',
    fix: 'Add a lang attribute to the <html> element. For English, use lang="en". For South African English, lang="en-ZA" is more precise.',
  },
  'html-lang-valid': {
    why: 'An unrecognised lang value is silently ignored by screen readers, creating the same problem as a missing attribute — incorrect pronunciation.',
    fix: 'Replace the invalid value with a valid BCP 47 language tag. Common tags: "en", "en-ZA", "af", "fr", "de".',
  },
  'document-title': {
    why: 'The page title is the first content a screen reader announces on page load, and appears in browser tabs and bookmarks. A missing or repeated title prevents users from knowing their location.',
    fix: 'Add a unique, descriptive <title> inside <head> on every page. Follow the pattern "Page Name — Site Name".',
  },
  'landmark-one-main': {
    why: 'The <main> landmark lets screen reader and keyboard users skip directly to primary content, bypassing repeated navigation on every page load.',
    fix: 'Wrap primary page content in a single <main> element. Pair it with a visible-on-focus "Skip to main content" link.',
  },
  'bypass': {
    why: 'Without a skip link, keyboard-only users must press Tab through every navigation item on every page load to reach the main content.',
    fix: 'Add a visually-hidden "Skip to main content" anchor as the very first element in <body>. Make it visible on :focus.',
  },
  'region': {
    why: 'Screen reader users can jump between landmark regions to navigate efficiently. Content outside any landmark forces linear reading of the entire page.',
    fix: 'Ensure all visible page content sits inside a semantic landmark: <header>, <nav>, <main>, <aside>, or <footer>.',
  },
  'heading-order': {
    why: 'Screen readers provide heading navigation that allows users to skim and jump between sections. Skipping heading levels breaks the document outline.',
    fix: 'Maintain a strict hierarchy: one h1 per page, h2 for major sections, h3 for subsections. Use CSS to control appearance rather than choosing a level for its visual size.',
  },
  'meta-viewport': {
    why: 'Disabling pinch-to-zoom via user-scalable=no prevents users with low vision from enlarging content.',
    fix: 'Remove user-scalable=no and maximum-scale constraints from the viewport meta tag.',
  },
  'duplicate-id': {
    why: 'Duplicate id attributes cause aria-labelledby, aria-describedby, and <label for="..."> associations to silently target the wrong element.',
    fix: 'Ensure every id attribute in the DOM is unique per page. When generating lists dynamically, append a unique index or identifier to each id.',
  },
  'aria-required-attr': {
    why: 'ARIA roles require specific attributes to communicate their state to assistive technologies. Without them, the role is effectively non-functional.',
    fix: 'Add the required ARIA attributes listed in the violation details. Prefer native HTML elements over custom ARIA patterns where possible.',
  },
  'aria-valid-attr': {
    why: 'Misspelled or non-standard ARIA attributes are silently ignored by browsers and assistive technologies.',
    fix: 'Correct the attribute names. A common mistake is aria-labeledby (correct spelling: aria-labelledby).',
  },
  'aria-roles': {
    why: 'Invalid role values are discarded by assistive technologies and the element is announced by its underlying HTML tag instead.',
    fix: 'Replace invalid role values with valid WAI-ARIA roles. Prefer native semantic HTML where possible.',
  },
  'frame-title': {
    why: 'Screen reader users encounter iframe content without context unless a title attribute describes its purpose.',
    fix: 'Add a title attribute to every <iframe>. For invisible technical iframes, use aria-hidden="true".',
  },
  'select-name': {
    why: 'Dropdown menus without labels are invisible to screen readers. Users cannot determine what the dropdown controls.',
    fix: 'Associate a <label> with each <select> using matching for and id attributes, or apply aria-label directly.',
  },
  'input-image-alt': {
    why: 'Input elements with type="image" function as submit buttons. Without alt text, the button purpose is unannounced to screen reader users.',
    fix: 'Add alt text describing the button action — e.g., alt="Submit order".',
  },
  'HTTP 404': {
    why: 'Broken links degrade user experience and erode visitor trust. Search engines penalise sites with high rates of 404 errors.',
    fix: 'Restore the content at the original URL, or set up a 301 permanent redirect. For external links that no longer exist, replace or remove the reference.',
  },
  'HTTP 4xx': {
    why: 'Client-side HTTP errors indicate the linked resource is inaccessible due to authentication, authorisation, or request issues.',
    fix: 'Investigate the specific status code. 401 and 403 indicate permission or authentication requirements. Ensure publicly-linked resources are publicly accessible.',
  },
  'HTTP 5xx': {
    why: 'Server errors indicate a backend failure at the target. These pages are as inaccessible as 404s and may indicate broader infrastructure problems.',
    fix: 'Review server logs for the failing endpoint. For external URLs, notify the site owner or replace the link.',
  },
  'Request failed': {
    why: 'Network-level failures mean the resource is completely unreachable — the server may be offline, the domain may have expired, or the URL may contain a typo.',
    fix: 'Verify the URL is correctly formed. Check whether the target domain is still registered and the server is reachable.',
  },
  'Form control with no accessible label': {
    why: 'Screen readers announce form fields by their accessible label. Without one, visually impaired users hear only "edit text" or "combo box" with no indication of what information to enter. This affects WCAG 2.1 compliance (Success Criterion 1.3.1 and 4.1.2) and excludes users who rely on assistive technology.',
    fix: 'Add a <label> element with a for attribute matching each input\'s id, or add an aria-label attribute directly to the input. For example: <label for=\'demo-name\'>Full name</label> or <input id=\'demo-name\' aria-label=\'Full name\'>.',
  },
  'Interactive control with no accessible name': {
    why: 'Buttons without a text label or aria-label are announced by screen readers as simply "button" with no indication of what they do. This prevents keyboard and assistive-technology users from activating controls intentionally.',
    fix: 'Add visible text inside the button element, or add an aria-label attribute describing the action — for example, aria-label="Close dialog". The label must match what the button does when activated.',
  },
  'Link with no accessible name': {
    why: 'Screen reader users navigate pages by cycling through links. A link with no text or aria-label is announced only as "link", making navigation impossible for users who depend on assistive technology.',
    fix: 'Ensure every anchor element contains visible text. For icon-only links, add an aria-label describing the destination — for example, aria-label="Visit our Instagram page".',
  },
};

const DEFAULT_GUIDANCE: Guidance = {
  why: 'This issue was identified by the automated auditor. Review the linked documentation for a detailed explanation of its impact on users and compliance standing.',
  fix: 'Follow the remediation guidance in the documentation link below. If the fix requires interpretation, raise it with your development team alongside this report.',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stdioToString(entry: string | Buffer): string {
  if (typeof entry === 'string') return entry;
  if (Buffer.isBuffer(entry)) return entry.toString('utf-8');
  return '';
}

const FINDING_RE = /\[FINDING\]\[(critical|high|medium|low|info)\]\s+(.+)/;

function parseFinding(text: string): { severity: Severity; message: string } | null {
  const m = text.trim().match(FINDING_RE);
  if (!m) return null;
  return { severity: m[1] as Severity, message: m[2].trim() };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatFileTimestamp(ts: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${ts.getFullYear()}-${p(ts.getMonth() + 1)}-${p(ts.getDate())}-${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}`;
}

function extractOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

function getGuidance(message: string): Guidance {
  if (message in RULE_GUIDANCE) return RULE_GUIDANCE[message];
  const m = message.match(/^\[([^\]]+)\]/);
  const ruleId = m?.[1];
  if (ruleId && ruleId in RULE_GUIDANCE) return RULE_GUIDANCE[ruleId];
  if (/^HTTP 5\d\d$/.test(message)) return RULE_GUIDANCE['HTTP 5xx'];
  if (/^HTTP 4\d\d$/.test(message)) return RULE_GUIDANCE['HTTP 4xx'] ?? RULE_GUIDANCE['HTTP 404'];
  return DEFAULT_GUIDANCE;
}

function groupByMessage(findings: AuditFinding[]): Map<string, AuditFinding[]> {
  const map = new Map<string, AuditFinding[]>();
  for (const f of findings) {
    const bucket = map.get(f.message);
    if (bucket) bucket.push(f);
    else map.set(f.message, [f]);
  }
  return map;
}

// ─── Section renderers ────────────────────────────────────────────────────────

function renderMetricStrip(allAuditFindings: AuditFinding[], securityFindings: FindingRecord[]): string {
  const counts = Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0])) as Record<Severity, number>;
  for (const f of allAuditFindings) counts[f.severity]++;
  for (const f of securityFindings) counts[f.severity]++;

  const metrics = SEVERITY_ORDER.map(s => {
    const n = counts[s];
    const colour = n > 0 ? SEV_COLOUR[s] : '#94a3b8';
    const numColour = n > 0 ? SEV_COLOUR[s] : '#cbd5e1';
    return `<div class="metric-card">
      <div class="metric-indicator" style="background:${colour}"></div>
      <div class="metric-num" style="color:${numColour}">${n}</div>
      <div class="metric-label">${s.charAt(0).toUpperCase() + s.slice(1)}</div>
    </div>`;
  }).join('');

  return `<div class="metric-strip">${metrics}</div>`;
}

function renderExecSummary(
  tests: TestRecord[],
  auditResults: AuditResult[],
  securityFindings: FindingRecord[],
  origin: string,
): string {
  const passed  = tests.filter(t => t.status === 'passed').length;
  const failed  = tests.filter(t => t.status === 'failed' || t.status === 'timedOut').length;
  const skipped = tests.filter(t => t.status === 'skipped').length;
  const total   = tests.length;

  const allAuditFindings = auditResults.flatMap(r => r.findings);
  const totalFindings = allAuditFindings.length + securityFindings.length;

  const counts = Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0])) as Record<Severity, number>;
  for (const f of allAuditFindings) counts[f.severity]++;
  for (const f of securityFindings) counts[f.severity]++;
  const urgent = counts.critical + counts.high;

  const testSummary = failed === 0
    ? `<strong>${passed}</strong> of <strong>${total}</strong> tests passed.`
    : `<strong class="stat-fail-text">${failed} test${failed === 1 ? '' : 's'} failed</strong> out of <strong>${total}</strong> (${passed} passed${skipped ? `, ${skipped} skipped` : ''}).`;

  const findingSummary = totalFindings === 0
    ? 'No audit or security findings were detected.'
    : `<strong>${totalFindings}</strong> finding${totalFindings === 1 ? '' : 's'} identified across all auditors and security probes.${urgent > 0 ? ` <strong>${urgent}</strong> are critical or high severity and should be prioritised for remediation.` : ''}`;

  const breakdown = SEVERITY_ORDER
    .filter(s => counts[s] > 0)
    .map(s => `<span class="exec-sev" style="color:${SEV_COLOUR[s]};border-color:${SEV_COLOUR[s]}20">${counts[s]} ${s}</span>`)
    .join(' ');

  return `<section class="exec-summary">
    <h2 class="section-heading">Executive Summary</h2>
    <p class="exec-text">Target: <strong>${escapeHtml(origin)}</strong></p>
    <p class="exec-text">${testSummary}</p>
    <p class="exec-text">${findingSummary}</p>
    ${breakdown ? `<div class="exec-breakdown">${breakdown}</div>` : ''}
  </section>`;
}

function renderRuleGroup(message: string, groupFindings: AuditFinding[]): string {
  const severity = groupFindings[0].severity;
  const colour = SEV_COLOUR[severity];
  const bg = SEV_BG[severity];
  const count = groupFindings.length;
  const guidance = getGuidance(message);
  const uniqueUrls = new Set(groupFindings.map(f => f.url));
  const urlsVary = uniqueUrls.size > 1;
  const instanceItems = groupFindings.map(f => {
    const display = f.selector ?? (urlsVary ? f.url : f.url);
    return `<li class="instance-item"><code class="selector">${escapeHtml(display)}</code></li>`;
  }).join('');
  const helpUrl = groupFindings[0].helpUrl;
  const learnMore = helpUrl
    ? `<a class="learn-more" href="${escapeHtml(helpUrl)}" target="_blank" rel="noopener noreferrer">Learn more &#8599;</a>`
    : '';
  const instanceHeading = urlsVary ? 'Affected URLs' : 'Affected elements';
  return `<div class="rule-group">
    <details>
      <summary class="rule-summary" style="border-left-color:${colour};background:${bg}">
        <div class="summary-left">
          <span class="sev-badge" style="background:${colour}">${severity}</span>
          <span class="rule-title">${escapeHtml(message)}</span>
        </div>
        <span class="summary-count">${count} instance${count === 1 ? '' : 's'} &#8250;</span>
      </summary>
      <div class="rule-body">
        <div class="guidance-row">
          <div class="guidance-block">
            <h4 class="guidance-heading">Why this matters</h4>
            <p class="guidance-text">${escapeHtml(guidance.why)}</p>
          </div>
          <div class="guidance-block">
            <h4 class="guidance-heading">How to fix</h4>
            <p class="guidance-text">${escapeHtml(guidance.fix)}</p>
          </div>
        </div>
        <div class="instances-block">
          <h4 class="guidance-heading">${instanceHeading} (${count})</h4>
          <ul class="instance-list">${instanceItems}</ul>
        </div>
        ${learnMore}
      </div>
    </details>
  </div>`;
}

function renderTestIcon(status: TestRecord['status']): string {
  if (status === 'passed') {
    return `<svg class="test-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Passed">
      <circle cx="10" cy="10" r="9" fill="#dcfce7" stroke="#16a34a" stroke-width="1.5"/>
      <path d="M6 10l3 3 5-5" stroke="#16a34a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
  if (status === 'failed' || status === 'timedOut') {
    return `<svg class="test-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Failed">
      <circle cx="10" cy="10" r="9" fill="#fee2e2" stroke="#dc2626" stroke-width="1.5"/>
      <path d="M7 7l6 6M13 7l-6 6" stroke="#dc2626" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
  }
  return `<svg class="test-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Skipped">
    <circle cx="10" cy="10" r="9" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.5"/>
    <path d="M7 10h6" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
}

function renderTestSection(tests: TestRecord[]): string {
  const PROJECT_ORDER = ['smoke', 'functional', 'security', 'audit', 'regression'];
  const byProject = new Map<string, TestRecord[]>();
  for (const t of tests) {
    const arr = byProject.get(t.project);
    if (arr) arr.push(t);
    else byProject.set(t.project, [t]);
  }

  const sorted = [...byProject.entries()].sort(([a], [b]) => {
    const ai = PROJECT_ORDER.indexOf(a);
    const bi = PROJECT_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const cards = sorted.map(([project, projectTests]) => {
    const nPassed  = projectTests.filter(t => t.status === 'passed').length;
    const nFailed  = projectTests.filter(t => t.status === 'failed' || t.status === 'timedOut').length;
    const nSkipped = projectTests.filter(t => t.status === 'skipped').length;
    const nTotal   = projectTests.length;
    const borderColour = nFailed > 0 ? '#dc2626' : '#16a34a';

    const testItems = projectTests.map(t => {
      const isFailed  = t.status === 'failed' || t.status === 'timedOut';
      const isSkipped = t.status === 'skipped';
      const statusClass = isFailed ? 'test-item--failed' : isSkipped ? 'test-item--skipped' : 'test-item--passed';

      const descHtml = t.description
        ? `<p class="test-item-desc">${escapeHtml(t.description)}</p>`
        : '';
      const errorHtml = isFailed && t.errorMessage
        ? `<pre class="test-error-inline">${escapeHtml(t.errorMessage)}</pre>`
        : '';
      const screenshotHtml = isFailed && t.screenshotB64
        ? `<img class="test-screenshot-inline" src="data:image/png;base64,${t.screenshotB64}" alt="Screenshot at point of failure" loading="lazy">`
        : '';

      return `<div class="test-item ${statusClass}">
        ${renderTestIcon(t.status)}
        <div class="test-item-body">
          <div class="test-item-header">
            <span class="test-item-title">${escapeHtml(t.displayPath)}</span>
            <span class="test-item-duration">${formatDuration(t.durationMs)}</span>
          </div>
          ${descHtml}${errorHtml}${screenshotHtml}
        </div>
      </div>`;
    }).join('');

    return `<div class="project-card" style="border-left-color:${borderColour}">
      <div class="project-header">
        <span class="project-name">${escapeHtml(project)}</span>
        <div class="project-stats">
          <span class="stat stat-pass">${nPassed} passed</span>
          ${nFailed  > 0 ? `<span class="stat stat-fail">${nFailed} failed</span>` : ''}
          ${nSkipped > 0 ? `<span class="stat stat-skip">${nSkipped} skipped</span>` : ''}
          <span class="stat stat-total">${nTotal} total</span>
        </div>
      </div>
      <details class="test-list-details">
        <summary class="test-list-summary">View all ${nTotal} test${nTotal === 1 ? '' : 's'} &#8250;</summary>
        <div class="test-list">${testItems}</div>
      </details>
    </div>`;
  }).join('');

  return `<section class="report-section">
    <h2 class="section-heading">Test Results</h2>
    ${cards || '<p class="no-data">No tests recorded.</p>'}
  </section>`;
}

function renderAuditSection(auditResults: AuditResult[]): string {
  if (auditResults.length === 0) return '';

  const cards = auditResults.map(result => {
    const sorted = [...result.findings].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );

    let body: string;
    if (sorted.length === 0) {
      body = `<div class="passed-body">
        <svg class="pass-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="10" cy="10" r="9" stroke="#16a34a" stroke-width="1.5"/>
          <path d="M6 10l3 3 5-5" stroke="#16a34a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        All checks passed — no findings
      </div>`;
    } else {
      const groups = groupByMessage(sorted);
      const sortedGroups = [...groups.entries()].sort(
        ([, a], [, b]) => SEVERITY_ORDER.indexOf(a[0].severity) - SEVERITY_ORDER.indexOf(b[0].severity),
      );
      body = `<div class="findings">${sortedGroups.map(([msg, f]) => renderRuleGroup(msg, f)).join('')}</div>`;
    }

    const isWarning = !result.passed || result.warning;
    const statusBadge = result.passed && !result.warning
      ? `<span class="status-badge status-pass">Pass</span>`
      : result.warning
        ? `<span class="status-badge status-warn">Review</span>`
        : `<span class="status-badge status-fail">Fail</span>`;

    const cardClass = result.passed && !result.warning
      ? 'card-pass'
      : result.warning
        ? 'card-warn'
        : 'card-fail';

    return `<div class="auditor-card ${cardClass}">
      <div class="auditor-header">
        <h3 class="auditor-name">${escapeHtml(result.auditor)}</h3>
        ${statusBadge}
        <span class="auditor-meta">${formatDuration(result.durationMs)} &nbsp;·&nbsp; ${escapeHtml(result.targetUrl)}</span>
      </div>
      ${body}
    </div>`;
  }).join('');

  return `<section class="report-section">
    <h2 class="section-heading">Audit Findings</h2>
    ${cards}
  </section>`;
}

function renderSecuritySection(findings: FindingRecord[]): string {
  if (findings.length === 0) return '';

  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  const items = sorted.map(f => {
    const colour = SEV_COLOUR[f.severity];
    const bg = SEV_BG[f.severity];
    return `<div class="security-finding" style="border-left-color:${colour};background:${bg}">
      <div class="finding-header">
        <span class="sev-badge" style="background:${colour}">${f.severity}</span>
        <span class="finding-msg">${escapeHtml(f.message)}</span>
      </div>
      <div class="finding-source">${escapeHtml(f.project)} &middot; ${escapeHtml(f.testTitle)}</div>
    </div>`;
  }).join('');

  return `<section class="report-section">
    <h2 class="section-heading">Security Findings</h2>
    <div class="security-findings">${items}</div>
  </section>`;
}

// ─── CSS ─────────────────────────────────────────────────────────────────────

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: #f1f5f9;
  color: #0f172a;
  padding: 2rem;
  line-height: 1.6;
  max-width: 1100px;
  margin: 0 auto;
}

/* ── Header ── */
.report-header {
  background: #0f172a;
  border-radius: 14px;
  padding: 2rem 2.5rem 2.25rem;
  margin-bottom: 1.25rem;
}
.header-top { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.75rem; }
.brand-text { display: flex; flex-direction: column; gap: 0.1rem; }
.brand-name { font-size: 1.1rem; font-weight: 800; letter-spacing: 0.06em; color: #f8fafc; text-transform: uppercase; }
.brand-sub { font-size: 0.7rem; font-weight: 500; letter-spacing: 0.1em; color: #475569; text-transform: uppercase; }
.header-divider { border: none; border-top: 1px solid #1e293b; margin-bottom: 1.5rem; }
.header-meta { display: flex; gap: 3rem; flex-wrap: wrap; }
.meta-item { display: flex; flex-direction: column; gap: 0.25rem; }
.meta-key { font-size: 0.58rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; color: #475569; }
.meta-val { font-size: 0.875rem; color: #94a3b8; }
.meta-url { font-size: 0.9rem; color: #38bdf8; text-decoration: none; word-break: break-all; font-weight: 500; }
.meta-url:hover { text-decoration: underline; }

/* ── Metric strip ── */
.metric-strip { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0.75rem; margin-bottom: 1.25rem; }
.metric-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; text-align: center; padding: 1rem 0.5rem 0.875rem; }
.metric-indicator { height: 4px; margin: -1rem -0.5rem 0.875rem; }
.metric-num { font-size: 2rem; font-weight: 800; line-height: 1; margin-bottom: 0.35rem; }
.metric-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; }

/* ── Executive summary ── */
.exec-summary {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 1.5rem 1.75rem;
  margin-bottom: 1.25rem;
}
.section-heading {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: #94a3b8;
  margin-bottom: 0.75rem;
}
.exec-text { font-size: 0.95rem; color: #334155; line-height: 1.7; margin-bottom: 0.6rem; }
.exec-text:last-of-type { margin-bottom: 1rem; }
.stat-fail-text { color: #dc2626; }
.exec-breakdown { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.exec-sev { font-size: 0.78rem; font-weight: 600; padding: 0.25em 0.75em; border-radius: 9999px; border: 1px solid; background: #fff; }

/* ── Report sections ── */
.report-section {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 1.5rem 1.75rem;
  margin-bottom: 1.25rem;
}
.no-data { font-size: 0.875rem; color: #94a3b8; }

/* ── Project cards (test results) ── */
.project-card {
  border: 1px solid #e2e8f0;
  border-left: 4px solid #e2e8f0;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 0.75rem;
}
.project-card:last-child { margin-bottom: 0; }
.project-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.875rem 1.25rem;
  background: #f8fafc;
}
.project-name { font-size: 0.85rem; font-weight: 700; color: #0f172a; text-transform: capitalize; }
.project-stats { display: flex; gap: 0.625rem; flex-wrap: wrap; margin-left: auto; }
.stat { font-size: 0.72rem; font-weight: 600; padding: 0.2em 0.65em; border-radius: 9999px; }
.stat-pass   { background: #dcfce7; color: #15803d; }
.stat-fail   { background: #fee2e2; color: #b91c1c; }
.stat-skip   { background: #f1f5f9; color: #64748b; }
.stat-total  { background: #f1f5f9; color: #475569; }


/* ── Audit cards ── */
.auditor-card { border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 0.75rem; overflow: hidden; }
.auditor-card:last-child { margin-bottom: 0; }
.auditor-header { display: flex; align-items: center; gap: 0.75rem; padding: 1rem 1.5rem; border-bottom: 1px solid #f1f5f9; }
.card-pass .auditor-header { border-left: 4px solid #16a34a; }
.card-fail .auditor-header { border-left: 4px solid #dc2626; }
.card-warn .auditor-header { border-left: 4px solid #d97706; }
.auditor-name { font-size: 0.875rem; font-weight: 700; text-transform: capitalize; color: #0f172a; }
.status-badge { font-size: 0.6rem; font-weight: 700; padding: 0.25em 0.65em; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.06em; }
.status-pass { background: #dcfce7; color: #15803d; }
.status-fail { background: #fee2e2; color: #b91c1c; }
.status-warn { background: #fef3c7; color: #92400e; }
.auditor-meta { margin-left: auto; font-size: 0.75rem; color: #94a3b8; }
.passed-body { display: flex; align-items: center; gap: 0.625rem; padding: 1.25rem 1.5rem; color: #15803d; font-size: 0.875rem; font-weight: 500; }
.pass-icon { width: 20px; height: 20px; flex-shrink: 0; }
.findings { padding: 1rem 1.25rem 1.25rem; display: flex; flex-direction: column; gap: 0.5rem; }

/* ── Rule groups ── */
.rule-group { border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden; }
details > summary { list-style: none; }
details > summary::-webkit-details-marker { display: none; }
.rule-summary { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.75rem 1rem; border-left: 4px solid transparent; cursor: pointer; user-select: none; }
.rule-summary:hover { filter: brightness(0.97); }
.summary-left { display: flex; align-items: center; gap: 0.6rem; flex: 1; min-width: 0; }
.sev-badge { font-size: 0.6rem; font-weight: 700; padding: 0.2em 0.6em; border-radius: 4px; color: #fff; text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; flex-shrink: 0; }
.rule-title { font-size: 0.845rem; font-weight: 600; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.summary-count { font-size: 0.72rem; font-weight: 600; color: #64748b; white-space: nowrap; flex-shrink: 0; }
.rule-body { padding: 1.25rem 1.25rem 1rem; border-top: 1px solid #f1f5f9; background: #fff; }
.guidance-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; margin-bottom: 1.25rem; }
@media (max-width: 680px) { .guidance-row { grid-template-columns: 1fr; } }
.guidance-block { display: flex; flex-direction: column; gap: 0.4rem; }
.guidance-heading { font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; }
.guidance-text { font-size: 0.845rem; color: #334155; line-height: 1.65; }
.instances-block { margin-bottom: 1rem; }
.instances-block > .guidance-heading { margin-bottom: 0.5rem; }
.instance-list { list-style: none; display: flex; flex-direction: column; gap: 0.3rem; }
.instance-item { display: flex; align-items: flex-start; }
.selector { font-family: 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', monospace; font-size: 0.78rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 0.2em 0.55em; color: #0f172a; word-break: break-all; }
.learn-more { display: inline-flex; align-items: center; gap: 0.2rem; font-size: 0.78rem; font-weight: 600; color: #2563eb; text-decoration: none; }
.learn-more:hover { text-decoration: underline; }

/* ── Test list (collapsible) ── */
.test-list-details { border-top: 1px solid #f1f5f9; }
details.test-list-details > summary { list-style: none; }
details.test-list-details > summary::-webkit-details-marker { display: none; }
.test-list-summary {
  padding: 0.75rem 1.25rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: #64748b;
  cursor: pointer;
  user-select: none;
  display: block;
}
.test-list-summary:hover { color: #334155; }
.test-list { padding: 0.25rem 1.25rem 1rem; display: flex; flex-direction: column; }
.test-item { display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.625rem 0; border-bottom: 1px solid #f8fafc; }
.test-item:last-child { border-bottom: none; }
.test-icon { width: 20px; height: 20px; flex-shrink: 0; margin-top: 1px; }
.test-item-body { flex: 1; min-width: 0; }
.test-item-header { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.2rem; flex-wrap: wrap; }
.test-item-title { font-size: 0.82rem; font-weight: 600; color: #1e293b; flex: 1; min-width: 0; }
.test-item--failed .test-item-title { color: #b91c1c; }
.test-item--skipped .test-item-title { color: #64748b; font-style: italic; }
.test-item-duration { font-size: 0.68rem; color: #94a3b8; white-space: nowrap; flex-shrink: 0; }
.test-item-desc { font-size: 0.78rem; color: #475569; line-height: 1.55; }
.test-error-inline {
  margin-top: 0.5rem;
  font-family: 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 0.72rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  padding: 0.625rem 0.875rem;
  color: #7f1d1d;
  white-space: pre-wrap;
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
}
.test-screenshot-inline {
  margin-top: 0.5rem;
  max-width: 100%;
  max-height: 300px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  object-fit: contain;
  display: block;
}

/* ── Security findings ── */
.security-findings { display: flex; flex-direction: column; gap: 0.625rem; }
.security-finding { border-left: 4px solid transparent; border-radius: 8px; padding: 0.875rem 1rem; }
.finding-header { display: flex; align-items: flex-start; gap: 0.625rem; margin-bottom: 0.375rem; }
.finding-msg { font-size: 0.845rem; font-weight: 500; color: #1e293b; line-height: 1.5; }
.finding-source { font-size: 0.72rem; color: #64748b; padding-left: calc(0.6em * 2 + 0.6em + 0.625rem); }

/* ── Footer ── */
.report-footer { text-align: center; padding: 2rem 0 1rem; font-size: 0.75rem; color: #94a3b8; letter-spacing: 0.02em; }
`;

// ─── Reporter class ───────────────────────────────────────────────────────────

class SentinelReporter implements Reporter {
  private readonly tests: TestRecord[] = [];
  private readonly securityFindings: FindingRecord[] = [];
  private readonly auditResults: AuditResult[] = [];
  private startTime = new Date();
  private baseUrl = '';

  onBegin(config: FullConfig): void {
    this.startTime = new Date();
    this.baseUrl = (config.projects[0]?.use as Record<string, unknown>)?.baseURL as string ?? '';
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.titlePath()[1] ?? 'unknown';

    // Parse [FINDING] lines from stdout and stderr
    const allOutput = [
      ...(result.stdout as Array<string | Buffer>).map(stdioToString),
      ...(result.stderr as Array<string | Buffer>).map(stdioToString),
    ];
    for (const chunk of allOutput) {
      for (const line of chunk.split('\n')) {
        const finding = parseFinding(line);
        if (finding) {
          this.securityFindings.push({
            ...finding,
            testTitle: test.title,
            project,
          });
        }
      }
    }

    // Parse audit-result JSON attachments
    for (const att of result.attachments) {
      if (att.name === 'audit-result') {
        try {
          const json = att.body?.toString('utf-8')
            ?? (att.path ? fs.readFileSync(att.path, 'utf-8') : null);
          if (json) this.auditResults.push(JSON.parse(json) as AuditResult);
        } catch { /* skip malformed attachment */ }
      }
    }

    // Find a screenshot attachment to embed
    let screenshotB64: string | undefined;
    const screenshotAtt = result.attachments.find(
      a => a.contentType?.startsWith('image/'),
    );
    if (screenshotAtt) {
      try {
        const buf = screenshotAtt.body
          ?? (screenshotAtt.path ? fs.readFileSync(screenshotAtt.path) : null);
        if (buf) screenshotB64 = buf.toString('base64');
      } catch { /* skip unreadable screenshot */ }
    }

    // Error message (first meaningful error only)
    let errorMessage: string | undefined;
    if (result.status === 'failed' || result.status === 'timedOut') {
      errorMessage = result.errors
        .map(e => e.message ?? String(e))
        .filter(Boolean)
        .join('\n---\n') || 'Test failed (no error message)';
    }

    // Build display path: describe blocks + test title, excluding project/file prefix
    const displayPath = test.titlePath().slice(3).join(' › ') || test.title;

    // Description from annotation (set by runJourney or test.info().annotations.push)
    const description = test.annotations.find(a => a.type === 'description')?.description;

    this.tests.push({
      title: test.title,
      displayPath,
      project,
      status: result.status,
      durationMs: result.duration,
      errorMessage,
      screenshotB64,
      description,
    });
  }

  onEnd(_result: FullResult): void {
    fs.mkdirSync('reports', { recursive: true });
    const ts = new Date();
    const outputPath = path.join('reports', `sentinel-report-${formatFileTimestamp(ts)}.html`);
    fs.writeFileSync(outputPath, this.buildHtml(ts), 'utf-8');
    process.stdout.write(`\nSentinel report written → ${outputPath}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }

  private buildHtml(ts: Date): string {
    const origin = extractOrigin(this.baseUrl);
    const humanDate = ts.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'medium' });
    const allAuditFindings = this.auditResults.flatMap(r => r.findings);
    const totalTests = this.tests.length;
    const failedTests = this.tests.filter(t => t.status === 'failed' || t.status === 'timedOut').length;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sentinel Report — ${escapeHtml(origin)}</title>
  <style>${CSS}</style>
</head>
<body>

  <header class="report-header">
    <div class="header-top">
      ${SHIELD_SVG}
      <div class="brand-text">
        <span class="brand-name">Sentinel</span>
        <span class="brand-sub">Automated Site Audit</span>
      </div>
    </div>
    <hr class="header-divider">
    <div class="header-meta">
      <div class="meta-item">
        <span class="meta-key">Target</span>
        <a class="meta-url" href="${escapeHtml(origin)}" target="_blank" rel="noopener noreferrer">${escapeHtml(origin)}</a>
      </div>
      <div class="meta-item">
        <span class="meta-key">Generated</span>
        <span class="meta-val">${humanDate}</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">Tests run</span>
        <span class="meta-val">${totalTests}${failedTests > 0 ? ` (${failedTests} failed)` : ' (all passed)'}</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">Audit findings</span>
        <span class="meta-val">${allAuditFindings.length}</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">Security findings</span>
        <span class="meta-val">${this.securityFindings.length}</span>
      </div>
    </div>
  </header>

  ${renderMetricStrip(allAuditFindings, this.securityFindings)}
  ${renderExecSummary(this.tests, this.auditResults, this.securityFindings, origin)}
  ${renderTestSection(this.tests)}
  ${renderAuditSection(this.auditResults)}
  ${renderSecuritySection(this.securityFindings)}

  <footer class="report-footer">
    Report generated by Sentinel &mdash; AI-Powered Website Testing Framework
  </footer>

</body>
</html>`;
  }
}

export default SentinelReporter;
