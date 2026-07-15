import { test } from '@playwright/test';
import { auditAccessibility } from '../../src/auditors/accessibility';
import { auditSeo } from '../../src/auditors/seo';
import { auditCodeQuality } from '../../src/auditors/code-quality';
import { auditApiKeyExposure } from '../../src/auditors/api-key-exposure';
import { defaultSite } from '../../src/config/sites';
import type { AuditResult } from '../../src/auditors/types';

// Forced safe-mode auditors: these always intercept and fulfil CF requests regardless of
// SENTINEL_LIVE_MODE, since a regression run should get fast, deterministic audit findings
// rather than depending on the live backend's availability.
const CF_PATTERN       = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';
const CF_EMPTY_RESPONSE = { status: 200, contentType: 'application/json', body: '{"ok":true}' };

const AUDIT_PATHS = [
  '/',
  '/account.html',
  '/checkout.html',
  '/track.html',
  '/welcome.html',
  '/terms.html',
] as const;

function logFindings(auditorName: string, result: AuditResult): void {
  const byPage = new Map<string, typeof result.findings>();
  for (const finding of result.findings) {
    if (!byPage.has(finding.url)) byPage.set(finding.url, []);
    byPage.get(finding.url)!.push(finding);
  }
  for (const [pageUrl, pageFindings] of byPage) {
    const realFindings = pageFindings.filter(f => f.severity !== 'info');
    console.log(`[INFO] ${auditorName} [${pageUrl}]: ${realFindings.length} finding(s).`);
    for (const f of realFindings) {
      const logFn = (f.severity === 'critical' || f.severity === 'high') ? console.error : console.warn;
      logFn(`[FINDING][${f.severity}] ${auditorName} [${pageUrl}]: ${f.message}` + (f.selector ? ` — "${f.selector}"` : ''));
    }
  }
  const total = result.findings.filter(f => f.severity !== 'info').length;
  console.log(`[INFO] ${auditorName}: ${total} total finding(s) across ${AUDIT_PATHS.length} page(s).`);
}

test.describe('Safe-mode auditors', { tag: ['@regression'] }, () => {

  test.beforeEach(async ({ page }) => {
    test.slow();
    await page.route(CF_PATTERN, route => route.fulfill(CF_EMPTY_RESPONSE));
  });

  test('accessibility-audit-safe-mode — axe-core scan across all known public pages', async ({ page }, testInfo) => {
    testInfo.annotations.push({
      type: 'description',
      description: 'Ran the accessibility auditor (axe-core) across all known public pages in forced safe mode.',
    });

    const result = await auditAccessibility(page, Array.from(AUDIT_PATHS), defaultSite.baseUrl);
    await testInfo.attach('audit-result', { contentType: 'application/json', body: Buffer.from(JSON.stringify(result, null, 2)) });
    logFindings('accessibility-audit-safe-mode', result);
  });

  test('seo-audit-safe-mode — SEO checks across all known public pages', async ({ page }, testInfo) => {
    testInfo.annotations.push({
      type: 'description',
      description: 'Ran the SEO auditor across all known public pages in forced safe mode.',
    });

    const result = await auditSeo(page, Array.from(AUDIT_PATHS), defaultSite.baseUrl);
    await testInfo.attach('audit-result', { contentType: 'application/json', body: Buffer.from(JSON.stringify(result, null, 2)) });
    logFindings('seo-audit-safe-mode', result);
  });

  test('code-quality-audit-safe-mode — AI-generated code pattern checks across all known public pages', async ({ page }, testInfo) => {
    testInfo.annotations.push({
      type: 'description',
      description: 'Ran the code-quality auditor across all known public pages in forced safe mode.',
    });

    const result = await auditCodeQuality(page, Array.from(AUDIT_PATHS), defaultSite.baseUrl);
    await testInfo.attach('audit-result', { contentType: 'application/json', body: Buffer.from(JSON.stringify(result, null, 2)) });
    logFindings('code-quality-audit-safe-mode', result);
  });

  test('api-key-exposure-audit-safe-mode — secret API key exposure checks across all known public pages', async ({ page }, testInfo) => {
    testInfo.annotations.push({
      type: 'description',
      description: 'Ran the API key exposure auditor (Anthropic, OpenAI, Stripe, AWS, Supabase service role, generic Bearer token) across all known public pages in forced safe mode. Matched values are redacted in the report.',
    });

    const result = await auditApiKeyExposure(page, Array.from(AUDIT_PATHS), defaultSite.baseUrl);
    await testInfo.attach('audit-result', { contentType: 'application/json', body: Buffer.from(JSON.stringify(result, null, 2)) });
    logFindings('api-key-exposure-audit-safe-mode', result);
  });

});
