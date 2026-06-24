import * as fs from 'fs';
import * as path from 'path';
import type { AuditResult, AuditFinding, Severity } from '../auditors/types';

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

// ─── Rule guidance table ───────────────────────────────────────────────────────
// Keyed by axe rule id or literal message string (for non-axe auditors).

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
    why: 'Icon-only buttons or buttons with empty text prevent assistive-technology users from understanding or activating controls. This directly blocks task completion — checkout flows, navigation, form submission — for keyboard and screen reader users.',
    fix: 'Add visible text to every button. For icon-only buttons, use aria-label to describe the action, not the icon — use "Close dialog" rather than "X". The label must match what the button does when activated.',
  },
  'html-has-lang': {
    why: 'Screen readers select the correct speech synthesis engine based on the declared page language. Without a lang attribute, content may be read using the wrong language engine, producing unintelligible pronunciation for non-English-speaking visitors.',
    fix: 'Add a lang attribute to the <html> element. For a site primarily in English, use lang="en". For South African English, lang="en-ZA" is more precise. Multilingual pages should additionally mark regions of differing language with lang on the containing element.',
  },
  'html-lang-valid': {
    why: 'An unrecognised lang value is silently ignored by screen readers, creating the same problem as a missing attribute — incorrect pronunciation that can make content unintelligible to non-native speakers.',
    fix: 'Replace the invalid value with a valid BCP 47 language tag. Common tags: "en" (English), "en-ZA" (South African English), "af" (Afrikaans), "fr" (French), "de" (German). Refer to the IANA Language Subtag Registry for the full list.',
  },
  'document-title': {
    why: 'The page title is the first content a screen reader announces on page load, and it appears in browser tabs and bookmarks. A missing or repeated title across pages prevents users from knowing their location within a site.',
    fix: 'Add a unique, descriptive <title> inside <head> on every page. Follow the pattern "Page Name — Site Name" so each page is distinguishable. Avoid generic values like "Home" or leaving the title empty.',
  },
  'landmark-one-main': {
    why: 'The <main> landmark lets screen reader and keyboard users skip directly to primary content, bypassing repeated navigation on every page load. Without it, users are forced to re-traverse the entire navigation header on every visit.',
    fix: 'Wrap primary page content in a single <main> element. Each page should have exactly one <main>. Pair it with a visible-on-focus "Skip to main content" link as the first focusable element in <body>.',
  },
  'bypass': {
    why: 'Without a skip link, keyboard-only users must press Tab through every navigation item on every page load to reach the main content. On a site with a substantial navigation bar this can require 30 or more keystrokes per page.',
    fix: 'Add a visually-hidden "Skip to main content" anchor as the very first element in <body>. Make it visible on :focus. Link it to the id of your <main> element. This takes under an hour to implement and significantly improves keyboard usability.',
  },
  'region': {
    why: 'Screen reader users can jump between landmark regions to navigate efficiently. Content outside any landmark forces linear reading of the entire page, which is significantly slower and more frustrating for assistive-technology users.',
    fix: 'Ensure all visible page content sits inside a semantic landmark: <header>, <nav>, <main>, <aside>, or <footer>. For regions without a matching HTML5 element, apply the equivalent ARIA role (role="region" with an aria-label).',
  },
  'heading-order': {
    why: 'Screen readers provide heading navigation that allows users to skim and jump between sections. Skipping heading levels breaks the document outline and forces users to re-read content to reconstruct context that should be implicit in structure.',
    fix: 'Maintain a strict hierarchy: one h1 per page, h2 for major sections, h3 for subsections. Never skip a level for visual sizing — use CSS to control the appearance of headings instead of choosing a level based on how it looks.',
  },
  'meta-viewport': {
    why: 'Disabling pinch-to-zoom via user-scalable=no prevents users with low vision from enlarging content. This affects a significant share of users over 40 and those using mobile devices in suboptimal lighting conditions.',
    fix: 'Remove user-scalable=no and maximum-scale constraints from the viewport meta tag. Ensure your layout is responsive so it adapts gracefully when the browser zoom level increases, rather than restricting zoom as a workaround for layout problems.',
  },
  'duplicate-id': {
    why: 'Duplicate id attributes cause aria-labelledby, aria-describedby, and <label for="..."> associations to silently target the wrong element. Form labels, error messages, and widget relationships break for screen reader users without any visible indication.',
    fix: 'Ensure every id attribute in the DOM is unique per page. When generating lists or repeating components dynamically, append a unique index or identifier to each id. Audit your templates and component library for shared static ids.',
  },
  'aria-required-attr': {
    why: 'ARIA roles require specific attributes to communicate their state to assistive technologies. Without them, the role is effectively non-functional — a progressbar with no aria-valuenow conveys nothing about progress.',
    fix: 'Add the required ARIA attributes listed in the violation details. Consult the WAI-ARIA Authoring Practices for required attributes per role. Where possible, prefer a native HTML element over a custom ARIA pattern, as native elements carry semantics automatically.',
  },
  'aria-valid-attr': {
    why: 'Misspelled or non-standard ARIA attributes are silently ignored by browsers and assistive technologies. The element appears to have ARIA support in code but provides none at runtime.',
    fix: 'Correct the attribute names. A common mistake is aria-labeledby (correct spelling: aria-labelledby). Validate all ARIA attributes against the official WAI-ARIA specification before shipping.',
  },
  'aria-roles': {
    why: 'Invalid role values are discarded by assistive technologies and the element is announced by its underlying HTML tag instead, which is often meaningless or misleading in context.',
    fix: 'Replace invalid role values with valid WAI-ARIA roles. Prefer native semantic HTML wherever possible — <button> is always preferable to <div role="button"> as it carries keyboard behaviour automatically without additional JavaScript.',
  },
  'frame-title': {
    why: 'Screen reader users encounter iframe content without context unless a title attribute describes its purpose. Unlabelled iframes are announced simply as "frame", giving no indication of whether a user should enter or skip the frame.',
    fix: 'Add a title attribute to every <iframe> that describes its content purpose. For invisible or empty technical iframes, use aria-hidden="true" to remove them from the accessibility tree entirely.',
  },
  'select-name': {
    why: 'Dropdown menus without labels are invisible to screen readers. Users cannot determine what the dropdown controls, which blocks form completion for an estimated 7 million screen reader users globally.',
    fix: 'Associate a <label> element with each <select> using matching for and id attributes, or apply aria-label directly to the select element where a visible label is not practical in the layout.',
  },
  'input-image-alt': {
    why: 'Input elements with type="image" function as submit buttons. Without alt text, the button\'s purpose is unannounced to screen reader users, making form submission inaccessible.',
    fix: 'Add alt text that describes the button action, not the image — for example, alt="Submit order". If the image is decorative and a text label is present elsewhere, use alt="".',
  },
  'scope-attr-valid': {
    why: 'Invalid scope attributes on table header cells break the relationship between headers and data cells for assistive technologies, making data tables unnavigable for screen reader users.',
    fix: 'Ensure all scope attributes on <th> elements use only valid values: "col", "row", "colgroup", or "rowgroup". Remove invalid or misspelled scope attributes and verify the resulting table structure communicates correctly.',
  },
  'td-headers-attr': {
    why: 'When table cells reference header ids that do not exist or are incorrect, screen readers announce data without its header context. Users cannot understand what column or row a value belongs to.',
    fix: 'Ensure every id referenced in a headers attribute exists and belongs to a <th> element that logically describes the data cell. Simpler tables are usually better served by the scope attribute than by headers/id associations.',
  },
  // Links auditor patterns
  'HTTP 404': {
    why: 'Broken links degrade user experience and erode visitor trust. Search engines penalise sites with high rates of 404 errors, reducing organic search rankings and discoverability.',
    fix: 'Restore the content at the original URL, or set up a 301 permanent redirect to its current location. For external links that no longer exist, replace them with a current equivalent or remove the reference from the page.',
  },
  'HTTP 4xx': {
    why: 'Client-side HTTP errors indicate the linked resource is inaccessible due to authentication, authorisation, or request issues. From a visitor\'s perspective, these links lead nowhere useful and signal a low-quality site.',
    fix: 'Investigate the specific status code returned. 401 and 403 responses indicate permission or authentication requirements. Ensure publicly-linked resources are publicly accessible, or remove the links.',
  },
  'HTTP 5xx': {
    why: 'Server errors indicate a backend failure at the target. From a visitor\'s perspective these pages are as inaccessible as 404s, and they may also indicate broader infrastructure problems affecting live user journeys.',
    fix: 'Review server logs for the failing endpoint to identify the root cause. For external URLs returning 5xx, notify the site owner or replace the link. For internal URLs, treat this as a production incident requiring immediate investigation.',
  },
  'Request failed': {
    why: 'Network-level failures mean the resource is completely unreachable — the server may be offline, the domain may have expired, or the URL may contain a typo. Visitors clicking these links receive a browser-level error page.',
    fix: 'Verify the URL is correctly formed. Check whether the target domain is still registered and the server is reachable. For external links, replace with a working equivalent. For internal links, investigate your server and DNS configuration.',
  },
};

const DEFAULT_GUIDANCE: Guidance = {
  why: 'This issue was identified by the automated auditor. Review the linked documentation for a detailed explanation of its impact on users and compliance standing.',
  fix: 'Follow the remediation guidance in the documentation link below. If the fix requires interpretation, raise it with your development team alongside this report.',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function extractOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

function extractRuleId(message: string): string | null {
  const m = message.match(/^\[([^\]]+)\]/);
  return m ? m[1] : null;
}

function getGuidance(message: string): Guidance {
  if (message in RULE_GUIDANCE) return RULE_GUIDANCE[message];
  const ruleId = extractRuleId(message);
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

// ─── Render: metric strip ────────────────────────────────────────────────────

function renderMetricStrip(findings: AuditFinding[]): string {
  const counts = Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0])) as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;

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

// ─── Render: executive summary ───────────────────────────────────────────────

function renderExecSummary(results: AuditResult[], origin: string): string {
  const allFindings = results.flatMap(r => r.findings);

  if (allFindings.length === 0) {
    return `<section class="exec-summary">
      <h2 class="section-heading">Executive Summary</h2>
      <p class="exec-text exec-clean">All automated checks passed. No issues were detected on <strong>${escapeHtml(origin)}</strong> during this audit run.</p>
    </section>`;
  }

  const uniqueCount = new Set(allFindings.map(f => f.message)).size;
  const total = allFindings.length;

  const counts = Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0])) as Record<Severity, number>;
  for (const f of allFindings) counts[f.severity]++;

  const urgent = (counts.critical ?? 0) + (counts.high ?? 0);
  const breakdown = SEVERITY_ORDER
    .filter(s => counts[s] > 0)
    .map(s => `<span class="exec-sev" style="color:${SEV_COLOUR[s]};border-color:${SEV_COLOUR[s]}20">${counts[s]} ${s}</span>`)
    .join(' ');

  const urgencyNote = urgent > 0
    ? ` Of these, <strong>${urgent} instance${urgent === 1 ? '' : 's'}</strong> are critical or high severity and should be prioritised for remediation before the next release.`
    : ' All findings are medium severity or lower and should be scheduled for remediation in the next development cycle.';

  return `<section class="exec-summary">
    <h2 class="section-heading">Executive Summary</h2>
    <p class="exec-text">Sentinel identified <strong>${uniqueCount} unique issue${uniqueCount === 1 ? '' : 's'}</strong> across <strong>${total} instance${total === 1 ? '' : 's'}</strong> on <strong>${escapeHtml(origin)}</strong>.${urgencyNote}</p>
    <div class="exec-breakdown">${breakdown}</div>
  </section>`;
}

// ─── Render: rule group ───────────────────────────────────────────────────────

function renderRuleGroup(message: string, groupFindings: AuditFinding[]): string {
  const severity = groupFindings[0].severity;
  const colour = SEV_COLOUR[severity];
  const bg = SEV_BG[severity];
  const count = groupFindings.length;
  const guidance = getGuidance(message);

  // If URLs vary across instances the URL itself is the finding (e.g. broken links).
  // If constant, use the selector field; fall back to the url.
  const uniqueUrls = new Set(groupFindings.map(f => f.url));
  const urlsVary = uniqueUrls.size > 1;

  const instanceItems = groupFindings.map(f => {
    const display = f.selector ?? (urlsVary ? f.url : f.url);
    return `<li class="instance-item"><code class="selector">${escapeHtml(display)}</code></li>`;
  }).join('');

  // Learn more link — use first finding's helpUrl; for links auditor it's undefined
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

// ─── Render: auditor card ────────────────────────────────────────────────────

function renderAuditorCard(result: AuditResult): string {
  const sorted = [...result.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
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
      ([, a], [, b]) =>
        SEVERITY_ORDER.indexOf(a[0].severity) - SEVERITY_ORDER.indexOf(b[0].severity)
    );
    body = `<div class="findings">${sortedGroups.map(([msg, f]) => renderRuleGroup(msg, f)).join('')}</div>`;
  }

  const statusBadge = result.passed
    ? `<span class="status-badge status-pass">Pass</span>`
    : `<span class="status-badge status-fail">Fail</span>`;

  const cardClass = result.passed ? 'card-pass' : 'card-fail';

  return `<div class="auditor-card ${cardClass}">
    <div class="auditor-header">
      <h2 class="auditor-name">${escapeHtml(result.auditor)}</h2>
      ${statusBadge}
      <span class="auditor-meta">${formatDuration(result.durationMs)} &nbsp;·&nbsp; ${escapeHtml(result.targetUrl)}</span>
    </div>
    ${body}
  </div>`;
}

// ─── SVG assets ──────────────────────────────────────────────────────────────

const SHIELD_SVG = `<svg width="38" height="44" viewBox="0 0 38 44" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M19 2L3 9v12c0 12.4 7.1 24 16 27 8.9-3 16-14.6 16-27V9L19 2z" fill="#1e40af" fill-opacity="0.3"/>
  <path d="M19 6L6 12v9c0 10.2 5.9 19.7 13 22 7.1-2.3 13-11.8 13-22v-9L19 6z" fill="#3b82f6"/>
  <path d="M12 22l5 5 9-9" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ─── Main export ──────────────────────────────────────────────────────────────

export function generateReport(results: AuditResult[], outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });

  const ts = new Date();
  const fileTs = ts.toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `report-${fileTs}.html`);

  const allFindings = results.flatMap(r => r.findings);
  const origin = extractOrigin(results[0]?.targetUrl ?? '');
  const humanDate = ts.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'medium' });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sentinel Audit Report — ${escapeHtml(origin)}</title>
  <style>
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
    .header-top {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.75rem;
    }
    .brand-text { display: flex; flex-direction: column; gap: 0.1rem; }
    .brand-name {
      font-size: 1.1rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      color: #f8fafc;
      text-transform: uppercase;
    }
    .brand-sub {
      font-size: 0.7rem;
      font-weight: 500;
      letter-spacing: 0.1em;
      color: #475569;
      text-transform: uppercase;
    }
    .header-divider {
      border: none;
      border-top: 1px solid #1e293b;
      margin-bottom: 1.5rem;
    }
    .header-meta { display: flex; gap: 3rem; flex-wrap: wrap; }
    .meta-item { display: flex; flex-direction: column; gap: 0.25rem; }
    .meta-key {
      font-size: 0.58rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: #475569;
    }
    .meta-val { font-size: 0.875rem; color: #94a3b8; }
    .meta-url {
      font-size: 0.9rem;
      color: #38bdf8;
      text-decoration: none;
      word-break: break-all;
      font-weight: 500;
    }
    .meta-url:hover { text-decoration: underline; }

    /* ── Metric strip ── */
    .metric-strip {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 0.75rem;
      margin-bottom: 1.25rem;
    }
    .metric-card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      overflow: hidden;
      text-align: center;
      padding: 1rem 0.5rem 0.875rem;
    }
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
    .exec-text { font-size: 0.95rem; color: #334155; line-height: 1.7; margin-bottom: 1rem; }
    .exec-text:last-child { margin-bottom: 0; }
    .exec-clean { color: #15803d; }
    .exec-breakdown { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .exec-sev {
      font-size: 0.78rem;
      font-weight: 600;
      padding: 0.25em 0.75em;
      border-radius: 9999px;
      border: 1px solid;
      background: #fff;
    }

    /* ── Auditor cards ── */
    .auditor-card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      margin-bottom: 1.25rem;
      overflow: hidden;
    }
    .auditor-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem 1.5rem;
      border-bottom: 1px solid #f1f5f9;
    }
    .card-pass .auditor-header { border-left: 4px solid #16a34a; }
    .card-fail .auditor-header { border-left: 4px solid #dc2626; }
    .auditor-name {
      font-size: 0.875rem;
      font-weight: 700;
      text-transform: capitalize;
      color: #0f172a;
    }
    .status-badge {
      font-size: 0.6rem;
      font-weight: 700;
      padding: 0.25em 0.65em;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .status-pass { background: #dcfce7; color: #15803d; }
    .status-fail { background: #fee2e2; color: #b91c1c; }
    .auditor-meta { margin-left: auto; font-size: 0.75rem; color: #94a3b8; }

    /* ── Passed body ── */
    .passed-body {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      padding: 1.25rem 1.5rem;
      color: #15803d;
      font-size: 0.875rem;
      font-weight: 500;
    }
    .pass-icon { width: 20px; height: 20px; flex-shrink: 0; }

    /* ── Findings ── */
    .findings { padding: 1rem 1.25rem 1.25rem; display: flex; flex-direction: column; gap: 0.5rem; }

    /* ── Rule group ── */
    .rule-group { border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden; }

    details > summary { list-style: none; }
    details > summary::-webkit-details-marker { display: none; }

    .rule-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border-left: 4px solid transparent;
      cursor: pointer;
      user-select: none;
    }
    .rule-summary:hover { filter: brightness(0.97); }

    .summary-left { display: flex; align-items: center; gap: 0.6rem; flex: 1; min-width: 0; }
    .sev-badge {
      font-size: 0.6rem;
      font-weight: 700;
      padding: 0.2em 0.6em;
      border-radius: 4px;
      color: #fff;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .rule-title {
      font-size: 0.845rem;
      font-weight: 600;
      color: #1e293b;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .summary-count {
      font-size: 0.72rem;
      font-weight: 600;
      color: #64748b;
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* ── Rule body ── */
    .rule-body {
      padding: 1.25rem 1.25rem 1rem;
      border-top: 1px solid #f1f5f9;
      background: #fff;
    }

    .guidance-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.25rem;
      margin-bottom: 1.25rem;
    }
    @media (max-width: 680px) { .guidance-row { grid-template-columns: 1fr; } }

    .guidance-block { display: flex; flex-direction: column; gap: 0.4rem; }
    .guidance-heading {
      font-size: 0.62rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #94a3b8;
    }
    .guidance-text { font-size: 0.845rem; color: #334155; line-height: 1.65; }

    .instances-block { margin-bottom: 1rem; }
    .instances-block > .guidance-heading { margin-bottom: 0.5rem; }
    .instance-list { list-style: none; display: flex; flex-direction: column; gap: 0.3rem; }
    .instance-item { display: flex; align-items: flex-start; }
    .selector {
      font-family: 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', monospace;
      font-size: 0.78rem;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      padding: 0.2em 0.55em;
      color: #0f172a;
      word-break: break-all;
    }

    .learn-more {
      display: inline-flex;
      align-items: center;
      gap: 0.2rem;
      font-size: 0.78rem;
      font-weight: 600;
      color: #2563eb;
      text-decoration: none;
    }
    .learn-more:hover { text-decoration: underline; }

    /* ── Footer ── */
    .report-footer {
      text-align: center;
      padding: 2rem 0 1rem;
      font-size: 0.75rem;
      color: #94a3b8;
      letter-spacing: 0.02em;
    }
  </style>
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
        <span class="meta-key">Auditors run</span>
        <span class="meta-val">${results.length}</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">Total findings</span>
        <span class="meta-val">${allFindings.length}</span>
      </div>
    </div>
  </header>

  ${renderMetricStrip(allFindings)}

  ${renderExecSummary(results, origin)}

  ${results.map(renderAuditorCard).join('\n')}

  <footer class="report-footer">
    Report generated by Sentinel &mdash; AI-Powered Website Testing Framework
  </footer>

</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf-8');
  return outputPath;
}
