import { Page, request } from '@playwright/test';
import type { AuditResult, AuditFinding } from './types';

const REQUEST_TIMEOUT = 15_000;
const BROWSER_TIMEOUT = 20_000;

async function checkWithBrowser(url: string, page: Page): Promise<boolean> {
  const tab = await page.context().newPage();
  try {
    const response = await tab.goto(url, { timeout: BROWSER_TIMEOUT, waitUntil: 'load' });
    // null response means same-document navigation — treat as reachable
    return response === null || response.status() < 400;
  } catch {
    return false;
  } finally {
    await tab.close();
  }
}

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
      let httpStatus: number | undefined;
      let httpError: string | undefined;

      try {
        let response = await apiContext.head(url, { timeout: REQUEST_TIMEOUT });
        // Some servers reject HEAD; retry with GET
        if (response.status() === 405) {
          response = await apiContext.get(url, { timeout: REQUEST_TIMEOUT });
        }
        httpStatus = response.status();
      } catch (err) {
        httpError = err instanceof Error ? err.message : String(err);
      }

      const httpFailed = httpError !== undefined || (httpStatus !== undefined && httpStatus >= 400);

      if (!httpFailed) {
        // Fast path passed — link is reachable
        return;
      }

      // HTTP check failed — retry with a full browser navigation before marking broken
      const browserOk = await checkWithBrowser(url, page);

      if (browserOk) {
        // Page loads in a real browser; the server likely requires JS rendering or
        // rejects non-browser user-agents. Not a broken link.
        findings.push({
          url,
          severity: 'info',
          category: 'broken-links',
          message: 'Page requires browser rendering',
          detail: httpError
            ? `HTTP request failed (${httpError}), but page loaded successfully via browser.`
            : `HTTP ${httpStatus} from raw request, but page loaded successfully via browser.`,
        });
        return;
      }

      // Both HTTP and browser navigation failed — link is genuinely broken
      findings.push({
        url,
        severity: httpStatus !== undefined && httpStatus >= 500 ? 'critical' : 'high',
        category: 'broken-links',
        message: httpError ? 'Request failed' : `HTTP ${httpStatus}`,
        detail: httpError
          ? `${httpError} (browser fallback also failed)`
          : `Link returned status ${httpStatus} (browser fallback also failed)`,
      });
    })
  );

  await apiContext.dispose();

  const broken = findings.filter((f) => f.severity === 'high' || f.severity === 'critical');

  return {
    auditor: 'broken-links',
    targetUrl,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    passed: broken.length === 0,
    findings,
  };
}
