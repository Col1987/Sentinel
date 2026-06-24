export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AuditFinding {
  url: string;
  severity: Severity;
  category: string;
  message: string;
  detail?: string;
  screenshotPath?: string;
}

export interface AuditResult {
  auditor: string;
  targetUrl: string;
  timestamp: string;
  durationMs: number;
  passed: boolean;
  findings: AuditFinding[];
}
