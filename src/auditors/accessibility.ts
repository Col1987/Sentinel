import { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { AuditResult, AuditFinding, Severity } from './types';

const IMPACT_MAP: Record<string, Severity> = {
  critical: 'critical',
  serious:  'high',
  moderate: 'medium',
  minor:    'low',
};

// Runs axe-core on each supplied path and combines all findings into a single AuditResult.
// Findings are tagged with the full page URL via the `url` field so callers can group by page.
// The caller is responsible for setting up any route intercepts (e.g. CF stubs for /welcome.html)
// before calling this function — page routes persist across internal navigations.
export async function auditAccessibility(
  page: Page,
  paths: string[],
  baseUrl: string,
): Promise<AuditResult> {
  const start    = Date.now();
  const findings: AuditFinding[] = [];

  for (const path of paths) {
    const pageUrl = `${baseUrl}${path === '/' ? '' : path}`;

    try {
      // domcontentloaded avoids hanging on pages with slow external requests (e.g. /welcome.html
      // with live Cloud Function calls). axe-core can analyse the DOM at this state.
      await page.goto(path, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      findings.push({
        url:      pageUrl,
        severity: 'info',
        category: 'accessibility',
        message:  `Navigation to ${path} failed`,
        detail:   err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'];
    try {
      ({ violations } = await new AxeBuilder({ page }).analyze());
    } catch (err) {
      findings.push({
        url:      pageUrl,
        severity: 'info',
        category: 'accessibility',
        message:  `axe-core analysis failed on ${path}`,
        detail:   err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const violation of violations) {
      const severity: Severity = IMPACT_MAP[violation.impact ?? ''] ?? 'info';
      for (const node of violation.nodes) {
        findings.push({
          url:      pageUrl,
          severity,
          category: 'accessibility',
          message:  `[${violation.id}] ${violation.description}`,
          selector: node.target.join(' > '),
          helpUrl:  violation.helpUrl,
        });
      }
    }
  }

  const hasRealFinding = findings.some(f => f.severity !== 'info');

  return {
    auditor:     'accessibility',
    targetUrl:   baseUrl,
    timestamp:   new Date().toISOString(),
    durationMs:  Date.now() - start,
    passed:      !hasRealFinding,
    findings,
  };
}
