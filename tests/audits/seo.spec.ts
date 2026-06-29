import { test } from '@playwright/test';
import { auditSeo } from '../../src/auditors/seo';
import { defaultSite, LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN        = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';
const CF_EMPTY_RESPONSE = { status: 200, contentType: 'application/json', body: '{"ok":true}' };

const AUDIT_PATHS = [
  '/',
  '/account.html',
  '/checkout.html',
  '/track.html',
  '/welcome.html',
  '/terms.html',
] as const;

test.describe('SEO audit', { tag: ['@audit'] }, () => {

  test('seo-all-pages — SEO checks across all known public pages', async ({ page }, testInfo) => {
    testInfo.annotations.push({
      type: 'description',
      description: 'Ran a full SEO audit across all known public pages of the site. Checks include page title, meta description, heading structure (single h1, sequential hierarchy), Open Graph tags, canonical URL, HTML lang attribute, and image alt attributes. Findings indicate SEO improvement opportunities — the test does not hard-fail on findings.',
    });

    test.slow();

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.fulfill(CF_EMPTY_RESPONSE));
    }

    const result = await auditSeo(page, Array.from(AUDIT_PATHS), defaultSite.baseUrl);

    await testInfo.attach('audit-result', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(result, null, 2)),
    });

    // Group findings by page for readable console output
    const byPage = new Map<string, typeof result.findings>();
    for (const finding of result.findings) {
      if (!byPage.has(finding.url)) byPage.set(finding.url, []);
      byPage.get(finding.url)!.push(finding);
    }

    for (const [pageUrl, pageFindings] of byPage) {
      const nonInfo = pageFindings.filter(f => f.severity !== 'info');
      console.log(`[INFO] seo-all-pages [${pageUrl}]: ${nonInfo.length} finding(s).`);
      for (const f of pageFindings) {
        if (f.severity === 'info') continue;
        const logFn = (f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium')
          ? console.error
          : console.warn;
        logFn(
          `[FINDING][${f.severity}] seo-all-pages [${pageUrl}]: ${f.message}` +
            (f.detail    ? ` — ${f.detail}`    : '') +
            (f.selector  ? ` (${f.selector})`  : ''),
        );
      }
    }

    const total = result.findings.filter(f => f.severity !== 'info').length;
    console.log(
      `[INFO] seo-all-pages: ${total} total SEO finding(s) across ${AUDIT_PATHS.length} page(s). ` +
        `Auditor status: ${result.passed ? (result.warning ? 'review' : 'pass') : 'fail'}.`,
    );
  });

});
