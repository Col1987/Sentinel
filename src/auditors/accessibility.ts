import { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { AuditResult, AuditFinding, Severity } from './types';

const IMPACT_MAP: Record<string, Severity> = {
  critical: 'critical',
  serious: 'high',
  moderate: 'medium',
  minor: 'low',
};

export async function auditAccessibility(page: Page, targetUrl: string): Promise<AuditResult> {
  const start = Date.now();
  const findings: AuditFinding[] = [];

  const { violations } = await new AxeBuilder({ page }).analyze();

  for (const violation of violations) {
    const severity: Severity = IMPACT_MAP[violation.impact ?? ''] ?? 'info';

    for (const node of violation.nodes) {
      findings.push({
        url: targetUrl,
        severity,
        category: 'accessibility',
        message: `[${violation.id}] ${violation.description}`,
        selector: node.target.join(' > '),
        helpUrl: violation.helpUrl,
      });
    }
  }

  return {
    auditor: 'accessibility',
    targetUrl,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    passed: findings.length === 0,
    findings,
  };
}
