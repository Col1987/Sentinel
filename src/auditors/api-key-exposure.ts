import { Page, Route } from '@playwright/test';
import type { AuditResult, AuditFinding } from './types';

// Pure client-side scan: loads each page, collects three text sources — raw HTML, inline
// <script> content, and same-origin external script bodies — and checks all three against
// known secret-key formats. Never depends on a backend response, so it behaves identically
// in safe mode and LIVE_MODE. Every matched value is redacted before it ever reaches an
// AuditFinding field — the report must never contain a usable key.

type SourceKind = 'raw HTML' | 'inline script' | 'external script';

interface RawMatch {
  ruleId: string;
  label: string;
  match: string;
}

const SUPABASE_PROXIMITY_WINDOW = 200;

// Anthropic and OpenAI project keys are checked before the generic OpenAI "sk-" pattern so
// their matches can be excluded from it — otherwise the same string could be reported twice
// under two different rule IDs.
function scanForKeys(text: string): RawMatch[] {
  const results: RawMatch[] = [];
  const claimedRanges: Array<[number, number]> = [];

  for (const m of text.matchAll(/sk-ant-[a-zA-Z0-9\-_]{95,}/g)) {
    results.push({ ruleId: 'api-key-anthropic', label: 'Anthropic API key', match: m[0] });
    claimedRanges.push([m.index!, m.index! + m[0].length]);
  }

  for (const m of text.matchAll(/sk-proj-[a-zA-Z0-9\-_]{20,}/g)) {
    results.push({ ruleId: 'api-key-openai', label: 'OpenAI project API key', match: m[0] });
    claimedRanges.push([m.index!, m.index! + m[0].length]);
  }

  for (const m of text.matchAll(/sk-[a-zA-Z0-9]{20,}/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    const alreadyClaimed = claimedRanges.some(([s, e]) => start < e && end > s);
    if (alreadyClaimed) continue;
    results.push({ ruleId: 'api-key-openai', label: 'OpenAI API key', match: m[0] });
  }

  for (const m of text.matchAll(/sk_live_[a-zA-Z0-9]{20,}/g)) {
    results.push({ ruleId: 'api-key-stripe-live', label: 'Stripe live secret key', match: m[0] });
  }

  for (const m of text.matchAll(/sk_test_[a-zA-Z0-9]{20,}/g)) {
    results.push({ ruleId: 'api-key-stripe-test', label: 'Stripe test secret key', match: m[0] });
  }

  for (const m of text.matchAll(/AKIA[0-9A-Z]{16}/g)) {
    results.push({ ruleId: 'api-key-aws', label: 'AWS access key ID', match: m[0] });
  }

  // Supabase service role key: a JWT-shaped string is only flagged when the literal text
  // "service_role" appears within ~200 characters of it — a bare JWT alone (e.g. a normal
  // Firebase ID token) is expected client-side and is not itself a finding.
  for (const m of text.matchAll(/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    const windowStart = Math.max(0, start - SUPABASE_PROXIMITY_WINDOW);
    const windowEnd = Math.min(text.length, end + SUPABASE_PROXIMITY_WINDOW);
    if (text.slice(windowStart, windowEnd).includes('service_role')) {
      results.push({ ruleId: 'api-key-supabase-service-role', label: 'Supabase service role key', match: m[0] });
    }
  }

  return results;
}

// Scoped separately per the spec — checked only against inline script text, not raw HTML
// or external scripts, since it targets a fetch/XHR Authorization header pattern that only
// makes sense inside executable script content.
function scanForBearerTokens(text: string): RawMatch[] {
  const results: RawMatch[] = [];
  for (const m of text.matchAll(/Bearer sk-[a-zA-Z0-9\-_]{20,}/g)) {
    results.push({ ruleId: 'api-key-bearer-token', label: 'Bearer token (sk- prefixed) in a fetch/XHR call', match: m[0] });
  }
  return results;
}

// Redacts to the first 8 characters only — applied before a matched value is placed into
// ANY AuditFinding field. No field on any finding produced by this auditor ever holds a
// full key, now or if new fields (detail, selector, etc.) are added later.
function redact(value: string): string {
  return `${value.slice(0, 8)}...redacted`;
}

export async function auditApiKeyExposure(
  page: Page,
  paths: string[],
  baseUrl: string,
): Promise<AuditResult> {
  const start = Date.now();
  const findings: AuditFinding[] = [];

  for (const path of paths) {
    const pageUrl = `${baseUrl}${path === '/' ? '' : path}`;
    let pageOrigin: string;
    try { pageOrigin = new URL(pageUrl).origin; } catch { pageOrigin = baseUrl; }

    // Route-interception pattern proven in tests/security/credential-exposure.spec.ts's
    // collectPageScripts: fetch the real response and re-fulfil it so the page loads
    // normally, while capturing the body for scanning.
    const capturedScripts: Array<{ url: string; body: string }> = [];
    await page.route('**/*.js', async (route: Route) => {
      const url = route.request().url();
      try {
        const response = await route.fetch();
        const text = await response.text();
        capturedScripts.push({ url, body: text });
        await route.fulfill({ response });
      } catch {
        try { await route.continue(); } catch { /* route already handled */ }
      }
    });

    try {
      await page.goto(path, { waitUntil: 'load' });
      // Wait for deferred/dynamically-injected scripts, matching auditCodeQuality's pattern.
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 2_000 }).catch(() => {});
    } catch (err) {
      findings.push({
        url: pageUrl, severity: 'info', category: 'api-key-exposure',
        message: `Navigation to ${path} failed`,
        detail:  err instanceof Error ? err.message : String(err),
      });
      await page.unroute('**/*.js');
      continue;
    }

    let html = '';
    let inlineScripts: string[] = [];
    try {
      html = await page.content();
      inlineScripts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('script:not([src])')).map(el => el.textContent ?? ''),
      );
    } catch (err) {
      findings.push({
        url: pageUrl, severity: 'info', category: 'api-key-exposure',
        message: `Content collection failed on ${path}`,
        detail:  err instanceof Error ? err.message : String(err),
      });
      await page.unroute('**/*.js');
      continue;
    }

    await page.unroute('**/*.js');

    const push = (
      ruleId: string,
      label: string,
      match: string,
      source: SourceKind,
      sourceDescription: string,
      selector?: string,
    ) => {
      const finding: AuditFinding = {
        url: pageUrl,
        category: 'api-key-exposure',
        severity: 'critical',
        message: `[${ruleId}] ${label} found in ${source}`,
        detail:  `Redacted match: ${redact(match)} — ${sourceDescription}`,
      };
      if (selector) finding.selector = selector;
      findings.push(finding);
    };

    // ── 1. Inline <script> tags ─────────────────────────────────────────────
    // Scanned before raw HTML so its matches can be recorded and excluded there —
    // page.content() serializes the whole document, so every inline-script match is
    // guaranteed to reappear verbatim in the raw HTML scan. That's not a second real
    // exposure, just the same script tag read through two different sources — keep the
    // inline-script attribution (more precise) and drop the raw-HTML duplicate.
    const inlineMatchValues = new Set<string>();
    inlineScripts.forEach((scriptText, i) => {
      const selector = `script:nth-of-type(${i + 1})`;
      for (const m of scanForKeys(scriptText)) {
        inlineMatchValues.add(m.match);
        push(m.ruleId, m.label, m.match, 'inline script', `inline <script> tag (${selector})`, selector);
      }
      for (const m of scanForBearerTokens(scriptText)) {
        inlineMatchValues.add(m.match);
        push(m.ruleId, m.label, m.match, 'inline script', `inline <script> tag (${selector})`, selector);
      }
    });

    // ── 2. Raw page HTML ────────────────────────────────────────────────────
    // Genuinely useful for a match sitting outside any <script> tag (an HTML comment,
    // a data attribute, an inline event handler) — skip anything already reported as
    // an inline-script match on this same page.
    for (const m of scanForKeys(html)) {
      if (inlineMatchValues.has(m.match)) continue;
      push(m.ruleId, m.label, m.match, 'raw HTML', 'page.content() source');
    }

    // ── 3. Same-origin external script files ────────────────────────────────
    // Not deduplicated against inline/HTML — a key appearing in both an inline script
    // and a separate external file is two distinct, independently-fixable exposures.
    const seenUrls = new Set<string>();
    for (const { url, body } of capturedScripts) {
      if (!url.startsWith(pageOrigin) || seenUrls.has(url)) continue;
      seenUrls.add(url);

      let filename = url;
      try { filename = new URL(url).pathname.split('/').pop() || url; } catch { /* keep raw url */ }
      const selector = `script[src*="${filename}"]`;

      for (const m of scanForKeys(body)) {
        push(m.ruleId, m.label, m.match, 'external script', url, selector);
      }
    }
  }

  return {
    auditor:    'api-key-exposure',
    targetUrl:  baseUrl,
    timestamp:  new Date().toISOString(),
    durationMs: Date.now() - start,
    passed:     true,
    warning:    findings.some(f => f.severity !== 'info'),
    findings,
  };
}
