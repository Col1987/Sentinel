import { test } from '@playwright/test';
import { auditAccessibility } from '../../src/auditors/accessibility';
import { defaultSite, LIVE_MODE } from '../../src/config/sites';

const CF_PATTERN       = '**europe-west1-juelhaus-co-za.cloudfunctions.net**';
const CF_EMPTY_RESPONSE = { status: 200, contentType: 'application/json', body: '{"ok":true}' };

// All public pages — /admin.html excluded (requires auth; axe would only scan the overlay).
const AUDIT_PATHS = [
  '/',
  '/account.html',
  '/checkout.html',
  '/track.html',
  '/welcome.html',
  '/terms.html',
] as const;

test.describe('Accessibility audit', { tag: '@audit' }, () => {

  test('a11y-all-pages — axe-core accessibility scan across all known public pages @a11y', async ({ page }, testInfo) => {
    testInfo.annotations.push({
      type: 'description',
      description: 'Ran a full accessibility scan across all known public pages of the site using axe-core, an industry-standard accessibility testing tool. Findings are grouped by page URL. Accessibility issues can prevent visitors with disabilities from using the site and may create legal compliance obligations under WCAG 2.1 and related standards.',
    });

    // axe scans 6 pages in sequence; triple the timeout to give each page comfortable headroom.
    test.slow();

    if (!LIVE_MODE) {
      // /welcome.html makes CF requests before DOMContentLoaded — fulfill them so the page
      // does not hang. The route persists for all navigations within this test.
      await page.route(CF_PATTERN, route => route.fulfill(CF_EMPTY_RESPONSE));
    }

    const result = await auditAccessibility(page, Array.from(AUDIT_PATHS), defaultSite.baseUrl);

    // Attach the full JSON result for the report
    await testInfo.attach('audit-result', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(result, null, 2)),
    });

    // Group findings by page URL for readable console output
    const byPage = new Map<string, typeof result.findings>();
    for (const finding of result.findings) {
      if (!byPage.has(finding.url)) byPage.set(finding.url, []);
      byPage.get(finding.url)!.push(finding);
    }

    for (const [pageUrl, pageFindings] of byPage) {
      const realFindings = pageFindings.filter(f => f.severity !== 'info');
      console.log(`[INFO] a11y-all-pages [${pageUrl}]: ${realFindings.length} violation(s).`);
      for (const f of realFindings) {
        const logFn = (f.severity === 'critical' || f.severity === 'high')
          ? console.error
          : console.warn;
        logFn(
          `[FINDING][${f.severity}] a11y-all-pages [${pageUrl}]: ${f.message}` +
            (f.selector ? ` — "${f.selector}"` : '') +
            (f.helpUrl   ? ` — ${f.helpUrl}`   : ''),
        );
      }
    }

    // Summary
    const totalViolations = result.findings.filter(f => f.severity !== 'info').length;
    console.log(`[INFO] a11y-all-pages: ${totalViolations} total violation(s) across ${AUDIT_PATHS.length} page(s).`);

    // No hard assertion — a11y findings are informational for the report.
    // The auditor result is attached above for the sentinel reporter to consume.
  });

});
