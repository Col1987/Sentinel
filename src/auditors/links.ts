import { Page, request } from '@playwright/test';
import type { AuditResult, AuditFinding } from './types';

const REQUEST_TIMEOUT = 15_000;

export async function auditBrokenLinks(page: Page, targetUrl: string): Promise<AuditResult> {
  const start = Date.now();
  const findings: AuditFinding[] = [];

  const hrefs = await page.evaluate((): string[] => {
    return Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .map((a) => a.href)
      .filter(Boolean);
  });

  const unique = [...new Set(hrefs)].filter((href) => /^https?:\/\//.test(href));

  const apiContext = await request.newContext();

  await Promise.all(
    unique.map(async (url) => {
      try {
        let response = await apiContext.head(url, { timeout: REQUEST_TIMEOUT });
        // Some servers reject HEAD; retry with GET
        if (response.status() === 405) {
          response = await apiContext.get(url, { timeout: REQUEST_TIMEOUT });
        }
        const status = response.status();
        if (status >= 400) {
          findings.push({
            url,
            severity: status >= 500 ? 'critical' : 'high',
            category: 'broken-links',
            message: `HTTP ${status}`,
            detail: `Link returned status ${status}`,
          });
        }
      } catch (err) {
        findings.push({
          url,
          severity: 'high',
          category: 'broken-links',
          message: 'Request failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );

  await apiContext.dispose();

  return {
    auditor: 'broken-links',
    targetUrl,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    passed: findings.length === 0,
    findings,
  };
}
