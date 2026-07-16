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
import { RISK_MAP, type RiskEntry } from './risk-map';

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
  isInfraIssue: boolean;
}

interface FindingRecord {
  severity: Severity;
  message: string;
  testTitle: string;
  project: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Marks a thrown error as a Sentinel-side infrastructure problem (e.g. an expired Gmail
// OAuth token) rather than a defect in the site under test. See src/utils/gmail.ts.
export const INFRA_ISSUE_MARKER = 'SENTINEL INFRASTRUCTURE ISSUE';

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

export interface Guidance { why: string; fix: string }

export const RULE_GUIDANCE: Record<string, Guidance> = {
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

  // ── SEO rules ──────────────────────────────────────────────────────────────

  'seo-title': {
    why: 'The page title appears in browser tabs, bookmarks, and search engine results pages (SERPs). A missing or out-of-range title loses the single most influential on-page SEO signal and confuses users navigating multiple tabs.',
    fix: 'Add a unique <title> element to every page\'s <head>. Keep it between 10 and 60 characters so it is not truncated in SERPs. Follow the pattern "Page Name — Brand Name".',
  },
  'seo-meta-description': {
    why: 'Search engines display the meta description as the snippet below the page title in SERPs. A well-crafted description directly improves click-through rates. Missing or too-short descriptions cause Google to auto-generate a snippet, often producing unhelpful excerpts.',
    fix: 'Add <meta name="description" content="..."> inside <head> on every page. Write between 50 and 160 characters that summarise the page\'s purpose and include a natural call-to-action.',
  },
  'seo-h1': {
    why: 'The h1 heading is the primary semantic marker search engines use to understand what a page is about. Multiple h1 elements dilute topical authority; no h1 removes the signal entirely.',
    fix: 'Place exactly one <h1> per page containing the primary keyword and topic of the page. All other section headings should be h2 or below.',
  },
  'seo-heading-order': {
    why: 'A logical heading hierarchy (h1 → h2 → h3) reinforces the document outline that search engines use to understand content structure. Skipped levels also break screen reader navigation for users who jump between headings.',
    fix: 'Ensure headings descend sequentially: h1 for the page title, h2 for major sections, h3 for subsections. Use CSS — not heading levels — to control visual size.',
  },
  'seo-open-graph': {
    why: 'Open Graph meta tags control how the page appears when shared on social media platforms (Facebook, LinkedIn, WhatsApp preview). Missing tags result in unattractive link previews that reduce click-through when content is shared.',
    fix: 'Add og:title, og:description, and og:image <meta> tags inside <head>. The image should be at least 1200 × 630 px for best display across platforms.',
  },
  'seo-canonical': {
    why: 'A canonical URL tells search engines which version of a page is definitive. Without it, crawlers may index multiple URL variants (with/without trailing slash, query strings, www vs non-www), splitting link equity and causing duplicate-content penalties.',
    fix: 'Add <link rel="canonical" href="https://www.example.com/page/"> inside <head> on every page, pointing to the preferred URL for that page.',
  },
  'seo-lang': {
    why: 'The lang attribute on <html> lets search engines match content to the correct regional audience and helps browsers and assistive technologies apply the right language rules for spell-checking and pronunciation.',
    fix: 'Add lang="en-ZA" (or the relevant BCP 47 tag) to the <html> element.',
  },
  'seo-img-alt': {
    why: 'Search engines index image alt text as a content signal for image search and broader topic relevance. Images without alt attributes are invisible to search engines and inaccessible to users with visual impairments.',
    fix: 'Add descriptive alt attributes to every meaningful image. Describe what the image communicates, not what it depicts — "Welcome pack with artisanal coffee and local guide" rather than "image.jpg".',
  },

  // ── Code-quality rules ─────────────────────────────────────────────────────

  'code-quality-duplicate-id': {
    why: 'Duplicate element IDs are a common pattern in AI-generated code where the same component or section is repeated without unique identifiers. The HTML spec requires IDs to be unique within a document. Duplicate IDs cause unpredictable behaviour in CSS selectors, JavaScript lookups (document.getElementById returns only the first match), and ARIA label associations. Analytics scripts and tracking tools also rely on IDs to identify elements.',
    fix: 'Assign a unique id to every element that has one. For repeated components (card grids, list items), use data-* attributes or class names instead of IDs, or generate unique suffixes (e.g., item-1, item-2). A linter rule (eslint-plugin-jsx-a11y or html-validate) can enforce uniqueness automatically.',
  },
  'code-quality-orphaned-handler': {
    why: 'AI-generated code frequently references event handler functions (onclick="handleClick()") that were never defined, or were defined in a separate script file that was removed or renamed. An orphaned handler silently fails: the click fires, the function lookup returns undefined, and the JavaScript engine throws a ReferenceError. Users see no feedback; the action does nothing. This is distinct from a console error — it is a broken user interaction.',
    fix: 'Ensure every function name referenced in an inline event handler exists in the global scope at the time the element is rendered. Move handler definitions into a <script> block that loads before the element, or replace inline handlers with addEventListener calls added after DOMContentLoaded. Verify with a browser console search: type the function name and confirm it is not undefined.',
  },
  'code-quality-dead-form': {
    why: 'AI-generated forms often include the visual structure of a form (inputs, labels, submit button) without the submission mechanism. A <form> element with no action attribute, no onsubmit handler, and no onclick hook on its children will collect user input but never send or process it. Visitors experience a broken flow: they fill out the form, click submit, and nothing happens.',
    fix: 'Every form must have at least one submission path: (1) an action attribute pointing to a server endpoint for traditional HTML form posts, (2) an onsubmit handler that processes data and prevents default, or (3) a JavaScript event listener on the submit event added via addEventListener. Verify that the submission path actually executes by checking the Network tab after a test submission.',
  },
  'code-quality-phantom-asset': {
    why: 'AI code generators frequently reference CSS files, JavaScript libraries, fonts, or images by filename without verifying they exist on the server. A referenced asset that returns 404 is silently dropped by the browser: styles are not applied, scripts do not run, and fonts fall back to system defaults. In production, phantom assets cause layout failures and broken functionality that only appear after deployment — they are invisible in local development if the file exists locally but was never uploaded.',
    fix: 'Confirm every asset referenced by a <link href>, <script src>, or <link rel="preload"> exists at that URL and returns HTTP 200. Check the Network tab in browser DevTools with "4xx" or "Failed" filters applied. Remove or correct any reference that returns 404. If the asset is intentionally lazy-loaded, ensure the URL is generated at runtime rather than hardcoded in HTML.',
  },
  'code-quality-low-quality-aria': {
    why: 'AI tools generate aria-label attributes to satisfy accessibility linters, but frequently produce labels that are technically present but semantically worthless: single characters, the element\'s own tag name, or generic phrases like "click here" or "button". A screen reader user navigating by landmark or control type hears these labels verbatim — "button, button" or "link, click here" — which conveys no more information than having no label at all, and in some cases introduces more confusion.',
    fix: 'Replace generic or redundant aria-labels with a concise description of the element\'s specific purpose or destination: "Close booking dialog" rather than "×", "View order #1234" rather than "link". Labels should describe what happens when the element is activated, not what the element is. At minimum, the label must be distinct from every other label on the page and longer than 2 characters.',
  },
  'code-quality-duplicate-meta': {
    why: 'AI tools that generate or merge component output sometimes produce multiple <title> or <meta name="description"> elements in the same document. Browsers use only the first value and ignore subsequent duplicates, but search engines may penalise duplicate signals or apply unpredictable precedence rules. Multiple <meta name="viewport"> tags cause inconsistent rendering across mobile browsers because each tag may override the previous one with different scale or width settings.',
    fix: 'Search the document <head> for duplicate title or meta tags and remove all but one. This often appears in templates where a base layout and a child template both emit the same tag. Use server-side template inheritance or slot mechanisms to ensure exactly one instance of each head element is rendered. Validate with a search engine preview tool (e.g., Google Search Console) to confirm the intended value is being indexed.',
  },
  'code-quality-hardcoded-localhost': {
    why: 'AI code generators frequently leave development-environment URLs (localhost, 127.0.0.1) in production code. These references appear when the tool generates code against a local dev server and the developer deploys without replacing them. In production, API calls to localhost silently fail, forms submit nowhere, and scripts refuse to load — causing broken functionality that only manifests after deployment and is difficult to trace.',
    fix: 'Replace all hardcoded localhost URLs with environment variables, configuration files, or relative paths. Use a build-time substitution mechanism (Vite\'s import.meta.env, webpack DefinePlugin, or dotenv) so the same codebase works in development and production without manual find-and-replace. Search for "localhost" and "127.0.0.1" across all HTML, JS, and CSS files before every deployment.',
  },
  'code-quality-empty-href': {
    why: 'AI tools generate `<a href="#">` or `<a href="javascript:void(0)">` as placeholder links when they need an anchor element but have not yet determined its destination. These links appear clickable but do nothing useful: clicking "#" scrolls the page to the top, while "javascript:void(0)" does nothing at all. Screen reader users hear the link text announced as a navigable destination that leads nowhere, and search engines waste crawl budget following them.',
    fix: 'Replace placeholder hrefs with real destinations, or convert elements that trigger JavaScript actions into <button> elements (which are the semantically correct element for in-page actions). If the link destination is not yet known, remove the element entirely rather than leaving a non-functional placeholder in production.',
  },
  'code-quality-console-log': {
    why: 'AI tools insert console.log statements throughout generated code to aid development debugging. More than 5 console.log calls in inline scripts strongly suggests debug output was not cleaned up before deployment. This leaks internal application state, data structures, API responses, and user information to anyone who opens the browser console — including security-relevant data that should never be visible in production.',
    fix: 'Remove console.log calls from all code that runs in production. Use a build step (terser with drop_console, babel-plugin-transform-remove-console, or eslint no-console rule) to strip them automatically. If logging is needed in production, use a structured logging library with configurable log levels that can be silenced in production environments.',
  },
  'code-quality-mixed-content': {
    why: 'Mixed content occurs when an HTTPS page loads resources (scripts, stylesheets, images, fonts) over HTTP. Modern browsers block active mixed content (scripts, stylesheets) outright and show security warnings for passive mixed content (images). A blocked script or stylesheet may cause the entire page to render incorrectly or JavaScript functionality to fail silently. This is a common AI-generated code pattern when the tool copies asset URLs from examples that predate widespread HTTPS adoption.',
    fix: 'Replace all http:// asset URLs with https:// equivalents. For external resources (CDNs, fonts, APIs), verify the provider offers HTTPS — virtually all major providers do. For self-hosted resources, ensure your server is configured for HTTPS. Use protocol-relative URLs (//cdn.example.com/file.js) only as a last resort, as they depend on the page protocol.',
  },
  'code-quality-hardcoded-test-data': {
    why: 'AI tools use placeholder content (Lorem ipsum, test@test.com, John Doe, TODO, FIXME) when generating UI components before real content is available. This placeholder text is often never replaced and ships to production, appearing in visible page text, email notifications, invoice templates, and client-facing documents. Placeholder emails (test@test.com) in forms route real submissions to non-existent addresses. TODO and FIXME annotations in visible text indicate incomplete features shipped prematurely.',
    fix: 'Search page body text for each flagged placeholder and replace with real content or remove the element if the content is not yet available. Establish a pre-deployment checklist that includes a text search for common placeholder strings. For TODO and FIXME items, resolve the underlying task or remove the annotation from user-visible text — these belong in code comments, not in rendered output.',
  },

  // ── API key exposure rules ─────────────────────────────────────────────────

  'api-key-anthropic': {
    why: 'An Anthropic API key grants full access to make Claude API calls billed to the key owner\'s account. If it appears in any browser-downloadable file — HTML, an inline script, or an external script — any visitor can copy it from DevTools and use it to run unlimited paid requests against the owner\'s account, exfiltrate data the key has access to, or exhaust rate limits and quotas that legitimate application traffic depends on.',
    fix: 'Remove the key from all client-side code immediately and rotate it in the Anthropic Console — a key that has ever been exposed client-side must be treated as compromised even after removal, since it may already be cached, logged, or archived elsewhere. Move all Claude API calls to a server-side endpoint (a Cloud Function, API route, or backend service) that holds the key in an environment variable and proxies requests on the client\'s behalf. The browser must never hold anything more privileged than a short-lived, scoped session token issued by your own backend.',
  },
  'api-key-openai': {
    why: 'An OpenAI secret key (standard or project-scoped) authorises billed API usage against the owner\'s account. Exposure in client-accessible code lets any visitor extract it and make unlimited requests at the account\'s expense, potentially reaching spend limits, exhausting quota needed by the real application, or using the account for abuse that could get the underlying OpenAI account suspended.',
    fix: 'Remove the key from all client-side code and rotate it immediately in the OpenAI dashboard — treat any client-exposed key as compromised regardless of how briefly it was visible. All OpenAI API calls must be made from a server-side environment that reads the key from a secret store or environment variable, never from code shipped to the browser.',
  },
  'api-key-stripe-live': {
    why: 'A Stripe LIVE secret key can create real charges, issue refunds, access real customer payment data, and manage the account\'s actual money. This is the single most damaging credential category this auditor checks for — exposure in client-accessible code gives any visitor the ability to move real funds or read real customer payment information immediately, with no further steps required.',
    fix: 'Rotate the key in the Stripe Dashboard immediately — this is not optional or lower-priority than other findings. Stripe secret keys (as opposed to publishable keys, which are designed to be client-visible) must only ever be used in server-side code that creates PaymentIntents, processes webhooks, or manages the account via the Stripe API. The client should only ever hold a publishable key (pk_live_...) or a short-lived client secret returned by your own server for a specific payment.',
  },
  'api-key-stripe-test': {
    why: 'A Stripe TEST secret key cannot move real money, but its presence in client-accessible code indicates the same architectural mistake that would be catastrophic with a live key: payment-related secret keys are being handled in code paths that ship to the browser. This is a strong signal the equivalent live key follows the same pattern, or will once the site goes to production.',
    fix: 'Remove the test key from client-side code and move all Stripe API calls (test or live) to server-side code, exactly as required for a live key. Treat this as an early warning to audit the checkout implementation before the live key is introduced, not as a lower-severity issue to defer.',
  },
  'api-key-aws': {
    why: 'An exposed AWS access key ID (paired with its secret, which is often nearby in the same config or code) can grant access to S3 buckets, databases, compute resources, or any other AWS service the underlying IAM identity is permitted to reach — depending on its permissions, this can mean reading or deleting production data, spinning up billed resources, or full account compromise.',
    fix: 'Deactivate the access key in the AWS IAM console immediately and issue a new one — do not wait to confirm exploitation before rotating. Client-side code must never hold long-lived AWS credentials. Use short-lived, scoped credentials issued via AWS Cognito Identity Pools or STS for any AWS access genuinely needed from the browser, and keep all other AWS operations server-side.',
  },
  'api-key-supabase-service-role': {
    why: 'The Supabase service_role key bypasses Row Level Security entirely, granting full read/write access to every table in the database regardless of the RLS policies configured for normal users. This is fundamentally different from the anon/public key, which is designed to be client-visible. A service_role key in client-accessible code means any visitor has unrestricted database access — they can read every user\'s data, modify any record, or delete entire tables.',
    fix: 'Rotate the service_role key in the Supabase project settings immediately. Only the anon (public) key belongs in client-side code — RLS policies are what make that safe. Any operation that genuinely requires bypassing RLS (admin actions, background jobs, server-side aggregation) must run in a server-side environment (an Edge Function, a backend API route) that holds the service_role key as a server-only environment variable.',
  },
  'api-key-bearer-token': {
    why: 'A hardcoded "Bearer sk-..." value inside a fetch/XHR call means a secret API key is being attached directly to outgoing requests from browser-executed code — the key is fully readable in the script source and in the Network tab\'s request headers for every visitor, regardless of which provider issued it.',
    fix: 'Move whatever API call this Authorization header belongs to into a server-side proxy endpoint. The browser should call your own backend (with no secret attached, or with a session token your backend issues), and your backend should attach the real provider key when it makes the actual upstream request.',
  },
};

const AUDITOR_DESCRIPTIONS: Record<string, string> = {
  'discovery':     'Maps every interactive element on the site and checks for missing accessible labels on form controls.',
  'broken-links':  'Checks every link on the homepage to verify it leads to a working page. Uses browser fallback for JavaScript-rendered pages.',
  'seo':           'Checks page titles, meta descriptions, heading hierarchy, Open Graph tags, canonical URLs, lang attributes, and image alt text across all pages.',
  'accessibility': 'Runs axe-core WCAG 2 AA compliance checks across all public pages, testing colour contrast, landmarks, labels, and semantic structure.',
  'code-quality':  'Detects common patterns in AI-generated code: duplicate element IDs, event handler attributes referencing undefined functions, and form elements with no submission mechanism.',
  'api-key-exposure': 'Scans raw page HTML, inline scripts, and same-origin external scripts for exposed secret API keys — Anthropic, OpenAI, Stripe, AWS, and Supabase — that must only ever exist in server-side environment variables.',
};

export const DEFAULT_GUIDANCE: Guidance = {
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
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

export function getGuidance(message: string): Guidance {
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
  const failed  = tests.filter(t => (t.status === 'failed' || t.status === 'timedOut') && !t.isInfraIssue).length;
  const skipped = tests.filter(t => t.status === 'skipped').length;
  const infra   = tests.filter(t => (t.status === 'failed' || t.status === 'timedOut') && t.isInfraIssue).length;
  const total   = tests.length;

  const allAuditFindings = auditResults.flatMap(r => r.findings);
  const totalFindings = allAuditFindings.length + securityFindings.length;

  const counts = Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0])) as Record<Severity, number>;
  for (const f of allAuditFindings) counts[f.severity]++;
  for (const f of securityFindings) counts[f.severity]++;
  const urgent = counts.critical + counts.high;

  const extras = [
    passed ? `${passed} passed` : '',
    skipped ? `${skipped} skipped` : '',
    infra ? `${infra} infrastructure issue${infra === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(', ');

  const testSummary = failed === 0
    ? `<strong>${passed}</strong> of <strong>${total}</strong> tests passed.${infra ? ` <strong>${infra}</strong> additional test${infra === 1 ? '' : 's'} hit a Sentinel infrastructure issue (not a site defect).` : ''}`
    : `<strong class="stat-fail-text">${failed} test${failed === 1 ? '' : 's'} failed</strong> out of <strong>${total}</strong>${extras ? ` (${extras})` : ''}.`;

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

// ─── Risk coverage ──────────────────────────────────────────────────────────────

type RiskConfidence = 'high' | 'low' | 'review' | 'not-evaluated';

interface RiskAssessment {
  confidence: RiskConfidence;
  matchedTests: TestRecord[];   // every test whose title matched a pattern, any status
  failureDetail?: string;       // set when confidence is 'low' or 'review'
}

function testMatchesRisk(title: string, patterns: Array<string | RegExp>): boolean {
  return patterns.some(p => (typeof p === 'string' ? title.includes(p) : p.test(title)));
}

// Confidence is derived entirely from this run's actual results, never asserted in
// advance. Skipped tests and Sentinel-side infrastructure failures (see
// INFRA_ISSUE_MARKER) don't count as evidence either way — a risk whose only matched
// tests were skipped or hit an infra issue is "not evaluated", not "high confidence".
//
// A passing Playwright test is not, by itself, proof a risk is mitigated: many tests
// in this codebase (e.g. admin-order-search-isolation) deliberately log
// [FINDING][critical|high] via console.error without a hard expect() — a soft-finding
// convention used throughout this suite. securityFindings carries exactly those lines
// (parsed in onTestEnd), keyed by the same testTitle used to match test patterns above.
//
// A matched test that passed but logged a critical/high finding is deliberately NOT
// treated as 'low' (confirmed happening) — that finding might be a genuinely observed
// violation, or it might be the same codebase's other common idiom: a setup/precondition
// bail-out ("beforeAll did not capture real order IDs — cannot perform check") that means
// the check never actually ran. Distinguishing those two cases from message text alone
// would mean pattern-matching prose, which this project deliberately avoids building.
// 'review' surfaces the finding without asserting which case it is — a human call, not
// an inferred one.
function assessRisk(entry: RiskEntry, tests: TestRecord[], securityFindings: FindingRecord[]): RiskAssessment {
  const matchedTests = tests.filter(t => testMatchesRisk(t.title, entry.testPatterns));
  const provingTests = matchedTests.filter(t => t.status !== 'skipped' && !t.isInfraIssue);

  if (provingTests.length === 0) {
    return { confidence: 'not-evaluated', matchedTests };
  }

  const failedTests = provingTests.filter(t => t.status === 'failed' || t.status === 'timedOut');
  if (failedTests.length > 0) {
    return {
      confidence: 'low',
      matchedTests,
      failureDetail: failedTests[0].errorMessage ?? 'Test failed (no error message)',
    };
  }

  const findingHits = securityFindings.filter(
    f => (f.severity === 'critical' || f.severity === 'high') && testMatchesRisk(f.testTitle, entry.testPatterns),
  );
  if (findingHits.length > 0) {
    return {
      confidence: 'review',
      matchedTests,
      failureDetail: `[${findingHits[0].severity}] ${findingHits[0].message}`,
    };
  }

  return { confidence: 'high', matchedTests };
}

function renderRiskCoverageSection(tests: TestRecord[], securityFindings: FindingRecord[], riskMap: RiskEntry[]): string {
  if (riskMap.length === 0) return '';

  const rows = riskMap.map(entry => {
    const assessment = assessRisk(entry, tests, securityFindings);

    const badge = assessment.confidence === 'high'
      ? { cls: 'status-pass', label: 'High — confirmed' }
      : assessment.confidence === 'low'
        ? { cls: 'status-fail', label: 'Low — confirmed happening' }
        : assessment.confidence === 'review'
          ? { cls: 'status-warn', label: 'Passed with findings — review' }
          : { cls: 'stat-skip', label: 'Not evaluated this run' };

    const coveredHtml = assessment.matchedTests.length > 0
      ? `<ul class="risk-covered-list">${assessment.matchedTests.map(t => {
          const isPass = t.status === 'passed';
          const isFail = t.status === 'failed' || t.status === 'timedOut';
          const cls = isPass ? 'pass' : isFail ? 'fail' : '';
          const icon = isPass ? '&#10003;' : isFail ? '&#10007;' : '&#8212;';
          const testId = t.title.split(' — ')[0].trim();
          return `<li class="risk-covered-item ${cls}">${icon} ${escapeHtml(testId)}</li>`;
        }).join('')}</ul>`
      : `<span class="risk-covered-empty">${escapeHtml(entry.testPatterns.map(p => (typeof p === 'string' ? p : p.source)).join(', '))} — not run this session</span>`;

    const failureHtml = assessment.failureDetail
      ? `<pre class="risk-failure-detail${assessment.confidence === 'review' ? ' risk-failure-detail--review' : ''}">${escapeHtml(assessment.failureDetail)}</pre>`
      : '';

    return `<tr>
      <td class="risk-name">${escapeHtml(entry.risk)}</td>
      <td class="risk-cause">${escapeHtml(entry.couldItHappen)}</td>
      <td class="risk-covered">${coveredHtml}</td>
      <td class="risk-confidence">
        <span class="status-badge ${badge.cls}">${escapeHtml(badge.label)}</span>
        <div class="risk-rationale">${escapeHtml(entry.confidenceRationale)}</div>
        ${failureHtml}
      </td>
    </tr>`;
  }).join('');

  return `<section class="report-section">
    <h2 class="section-heading">Risk Coverage</h2>
    <p class="risk-intro">This table maps the documented business risks for this site to the tests that provide direct evidence for or against them. Confidence is computed from this run's actual pass/fail results, not asserted in advance — a risk shows "Not evaluated this run" whenever none of its covering tests ran this time (for example, a filtered <code>--grep</code> run), rather than falsely claiming coverage it doesn't have.</p>
    <div class="risk-table-wrap">
      <table class="risk-table">
        <thead>
          <tr><th>Risk</th><th>Could it happen?</th><th>Covered by</th><th>Confidence</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
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
          <span class="sev-badge" style="background:${colour}">${escapeHtml(severity)}</span>
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

function renderTestIcon(status: TestRecord['status'], isInfraIssue: boolean): string {
  if (isInfraIssue) {
    return `<svg class="test-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Test infrastructure issue">
      <circle cx="10" cy="10" r="9" fill="#f1f5f9" stroke="#64748b" stroke-width="1.5"/>
      <path d="M10 6.5v4.5M10 13.75h.01" stroke="#64748b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
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
    const nFailed  = projectTests.filter(t => (t.status === 'failed' || t.status === 'timedOut') && !t.isInfraIssue).length;
    const nSkipped = projectTests.filter(t => t.status === 'skipped').length;
    const nInfra   = projectTests.filter(t => (t.status === 'failed' || t.status === 'timedOut') && t.isInfraIssue).length;
    const nTotal   = projectTests.length;
    const borderColour = nFailed > 0 ? '#dc2626' : '#16a34a';

    const testItems = projectTests.map(t => {
      const isInfra   = (t.status === 'failed' || t.status === 'timedOut') && t.isInfraIssue;
      const isFailed  = (t.status === 'failed' || t.status === 'timedOut') && !t.isInfraIssue;
      const isSkipped = t.status === 'skipped';
      const statusClass = isInfra ? 'test-item--infra' : isFailed ? 'test-item--failed' : isSkipped ? 'test-item--skipped' : 'test-item--passed';

      const descHtml = t.description
        ? `<p class="test-item-desc">${escapeHtml(t.description)}</p>`
        : '';
      const errorHtml = (isFailed || isInfra) && t.errorMessage
        ? `<pre class="test-error-inline${isInfra ? ' test-error-inline--infra' : ''}">${escapeHtml(t.errorMessage)}</pre>`
        : '';
      const screenshotHtml = isFailed && t.screenshotB64
        ? `<img class="test-screenshot-inline" src="data:image/png;base64,${t.screenshotB64}" alt="Screenshot at point of failure" loading="lazy">`
        : '';
      const infraBadge = isInfra ? `<span class="infra-badge">Test Infrastructure</span>` : '';

      return `<div class="test-item ${statusClass}">
        ${renderTestIcon(t.status, isInfra)}
        <div class="test-item-body">
          <div class="test-item-header">
            <span class="test-item-title">${escapeHtml(t.displayPath)}</span>
            ${infraBadge}
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
          ${nInfra   > 0 ? `<span class="stat stat-infra">${nInfra} infrastructure</span>` : ''}
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

    const desc = AUDITOR_DESCRIPTIONS[result.auditor];
    const nameBlock = desc
      ? `<div class="auditor-name-block">
          <h3 class="auditor-name">${escapeHtml(result.auditor)}</h3>
          <p class="auditor-desc">${escapeHtml(desc)}</p>
        </div>`
      : `<h3 class="auditor-name">${escapeHtml(result.auditor)}</h3>`;

    return `<div class="auditor-card ${cardClass}">
      <div class="auditor-header">
        ${nameBlock}
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

  // Group by test title, preserving insertion order within each group.
  const byTest = new Map<string, FindingRecord[]>();
  for (const f of findings) {
    const bucket = byTest.get(f.testTitle);
    if (bucket) bucket.push(f);
    else byTest.set(f.testTitle, [f]);
  }

  // Sort groups highest-severity-first (use the best severity in the group).
  const sortedGroups = [...byTest.entries()].sort(([, a], [, b]) => {
    const aTop = Math.min(...a.map(f => SEVERITY_ORDER.indexOf(f.severity)));
    const bTop = Math.min(...b.map(f => SEVERITY_ORDER.indexOf(f.severity)));
    return aTop - bTop;
  });

  const groups = sortedGroups.map(([testTitle, groupFindings]) => {
    const sorted = [...groupFindings].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );
    const highestSev = sorted[0].severity;
    const colour = SEV_COLOUR[highestSev];
    const bg     = SEV_BG[highestSev];
    const count  = sorted.length;

    // Readable title: strip the narrative description after " — ", then humanise.
    const testId      = testTitle.split(' — ')[0].trim();
    const readableTitle = testId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const rows = sorted.map(f => {
      const c = SEV_COLOUR[f.severity];
      return `<div class="security-group-row">
        <span class="sev-badge" style="background:${c}">${escapeHtml(f.severity)}</span>
        <span class="finding-msg">${escapeHtml(f.message)}</span>
      </div>`;
    }).join('');

    return `<div class="rule-group">
      <details>
        <summary class="rule-summary" style="border-left-color:${colour};background:${bg}">
          <div class="summary-left">
            <span class="sev-badge" style="background:${colour}">${escapeHtml(highestSev)}</span>
            <span class="rule-title">${escapeHtml(readableTitle)}</span>
          </div>
          <span class="summary-count">${count} finding${count === 1 ? '' : 's'} &#8250;</span>
        </summary>
        <div class="security-group-body">${rows}</div>
      </details>
    </div>`;
  }).join('');

  return `<section class="report-section">
    <h2 class="section-heading">Security Findings</h2>
    <div class="findings">${groups}</div>
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
.stat-infra  { background: #f1f5f9; color: #64748b; }
.stat-total  { background: #f1f5f9; color: #475569; }


/* ── Audit cards ── */
.auditor-card { border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 0.75rem; overflow: hidden; }
.auditor-card:last-child { margin-bottom: 0; }
.auditor-header { display: flex; align-items: flex-start; gap: 0.75rem; padding: 1rem 1.5rem; border-bottom: 1px solid #f1f5f9; }
.card-pass .auditor-header { border-left: 4px solid #16a34a; }
.card-fail .auditor-header { border-left: 4px solid #dc2626; }
.card-warn .auditor-header { border-left: 4px solid #d97706; }
.auditor-name-block { display: flex; flex-direction: column; gap: 0.2rem; }
.auditor-name { font-size: 0.875rem; font-weight: 700; text-transform: capitalize; color: #0f172a; }
.auditor-desc { font-size: 0.75rem; color: #64748b; line-height: 1.5; max-width: 52ch; }
.status-badge { font-size: 0.6rem; font-weight: 700; padding: 0.25em 0.65em; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 0.1rem; }
.status-pass { background: #dcfce7; color: #15803d; }
.status-fail { background: #fee2e2; color: #b91c1c; }
.status-warn { background: #fef3c7; color: #92400e; }
.auditor-meta { margin-left: auto; font-size: 0.75rem; color: #94a3b8; white-space: nowrap; }
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
.test-item--infra .test-item-title { color: #475569; }
.infra-badge {
  font-size: 0.6rem;
  font-weight: 700;
  padding: 0.2em 0.6em;
  border-radius: 4px;
  color: #475569;
  background: #e2e8f0;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
  flex-shrink: 0;
}
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
.test-error-inline--infra {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  color: #475569;
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

/* ── Security findings (grouped) ── */
.security-group-body { padding: 0.5rem 1rem 0.625rem; border-top: 1px solid #f1f5f9; display: flex; flex-direction: column; gap: 0.375rem; }
.security-group-row { display: flex; align-items: flex-start; gap: 0.625rem; padding: 0.25rem 0; }
.finding-msg { font-size: 0.845rem; font-weight: 500; color: #1e293b; line-height: 1.5; }

/* ── Risk coverage ── */
.risk-intro { font-size: 0.875rem; color: #334155; line-height: 1.7; margin-bottom: 1rem; }
.risk-intro code { font-family: 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', monospace; font-size: 0.82em; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 0.1em 0.4em; }
.risk-table-wrap { overflow-x: auto; }
table.risk-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
table.risk-table th {
  text-align: left; font-size: 0.62rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.1em; color: #94a3b8; padding: 0.6rem 0.75rem; border-bottom: 2px solid #e2e8f0;
}
table.risk-table td { padding: 0.85rem 0.75rem; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
table.risk-table tr:last-child td { border-bottom: none; }
.risk-name { font-weight: 600; color: #1e293b; min-width: 170px; }
.risk-cause { color: #475569; min-width: 220px; max-width: 320px; }
.risk-covered { min-width: 180px; }
.risk-covered-list { list-style: none; display: flex; flex-direction: column; gap: 0.3rem; }
.risk-covered-item { font-family: 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', monospace; font-size: 0.74rem; }
.risk-covered-item.pass { color: #15803d; }
.risk-covered-item.fail { color: #b91c1c; }
.risk-covered-empty { color: #94a3b8; font-style: italic; font-size: 0.78rem; }
.risk-confidence { min-width: 220px; }
.risk-rationale { color: #64748b; font-size: 0.76rem; margin-top: 0.4rem; line-height: 1.55; }
.risk-failure-detail {
  margin-top: 0.5rem; font-family: 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', monospace; font-size: 0.72rem;
  background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 0.5rem 0.7rem; color: #7f1d1d;
  white-space: pre-wrap; max-height: 140px; overflow-y: auto;
}
.risk-failure-detail--review { background: #fef3c7; border-color: #d97706; color: #92400e; }

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

    // Self-identifying infrastructure failures (e.g. an expired Gmail OAuth token) are not
    // a claim about the site under test — flag them so the report can badge them distinctly
    // instead of counting them as a red "failed" finding.
    const isInfraIssue = errorMessage?.includes(INFRA_ISSUE_MARKER) ?? false;

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
      isInfraIssue,
    });
  }

  onEnd(_result: FullResult): void {
    fs.mkdirSync('reports', { recursive: true });
    const ts = new Date();
    const isLive     = process.env.SENTINEL_LIVE_MODE === 'true';
    const modeTag    = isLive ? 'LIVE' : 'SAFE';
    const outputPath = path.join('reports', `sentinel-report-${formatFileTimestamp(ts)}-${modeTag}.html`);
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
  ${renderRiskCoverageSection(this.tests, this.securityFindings, RISK_MAP)}
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
