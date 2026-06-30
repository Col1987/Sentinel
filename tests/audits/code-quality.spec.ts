import { test } from '@playwright/test';
import { auditCodeQuality } from '../../src/auditors/code-quality';
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

test.describe('Code quality audit', { tag: ['@audit'] }, () => {

  test('code-quality-all-pages — AI-generated code pattern checks across all known public pages', async ({ page }, testInfo) => {
    testInfo.annotations.push({
      type: 'description',
      description: 'Scanned all known public pages for eleven code patterns commonly produced by AI code generators: duplicate element IDs, event handlers referencing undefined functions, forms with no submission mechanism, asset references returning 404, low-quality aria labels, duplicate meta tags, hardcoded localhost URLs, placeholder href links, excessive console.log in production code, mixed HTTP content on HTTPS pages, and hardcoded test data like Lorem ipsum or placeholder emails. Findings indicate quality issues — the test does not hard-fail on findings.',
    });

    test.slow();

    if (!LIVE_MODE) {
      await page.route(CF_PATTERN, route => route.fulfill(CF_EMPTY_RESPONSE));
    }

    const result = await auditCodeQuality(page, Array.from(AUDIT_PATHS), defaultSite.baseUrl);

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
      console.log(`[INFO] code-quality-all-pages [${pageUrl}]: ${nonInfo.length} finding(s).`);
      for (const f of pageFindings) {
        if (f.severity === 'info') continue;
        const logFn = (f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium')
          ? console.error
          : console.warn;
        logFn(
          `[FINDING][${f.severity}] code-quality-all-pages [${pageUrl}]: ${f.message}` +
            (f.detail   ? ` — ${f.detail}`   : '') +
            (f.selector ? ` (${f.selector})` : ''),
        );
      }
    }

    const total = result.findings.filter(f => f.severity !== 'info').length;
    console.log(
      `[INFO] code-quality-all-pages: ${total} total finding(s) across ${AUDIT_PATHS.length} page(s). ` +
        `Auditor status: ${result.passed ? (result.warning ? 'review' : 'pass') : 'fail'}.`,
    );
  });

});
