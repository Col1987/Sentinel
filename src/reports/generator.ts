import * as fs from 'fs';
import * as path from 'path';
import type { AuditResult, Severity } from '../auditors/types';

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_COLOUR: Record<Severity, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#d97706',
  low: '#65a30d',
  info: '#0284c7',
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function generateReport(results: AuditResult[], outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `report-${timestamp}.html`);

  const allFindings = results.flatMap((r) => r.findings);
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  const resultSections = results
    .map((result) => {
      const sorted = [...result.findings].sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
      );
      const rows = sorted
        .map(
          (f) => `
        <tr>
          <td><span class="sev" style="background:${SEVERITY_COLOUR[f.severity]}">${f.severity}</span></td>
          <td>${escapeHtml(f.url)}</td>
          <td>${escapeHtml(f.message)}</td>
          <td>${escapeHtml(f.detail ?? '')}</td>
        </tr>`
        )
        .join('');

      const body =
        sorted.length === 0
          ? '<p class="empty">No findings.</p>'
          : `<table>
        <thead><tr><th>Severity</th><th>URL</th><th>Message</th><th>Detail</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

      return `
    <div class="section">
      <div class="section-header">
        <h2>${escapeHtml(result.auditor)}</h2>
        <span class="badge ${result.passed ? 'badge-pass' : 'badge-fail'}">${result.passed ? 'pass' : 'fail'}</span>
        <span class="meta-right">${escapeHtml(result.targetUrl)} &nbsp;|&nbsp; ${result.durationMs}ms</span>
      </div>
      ${body}
    </div>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sentinel Audit Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f8fafc; color: #1e293b; padding: 2rem; }
    h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
    .meta { color: #64748b; font-size: 0.875rem; margin-bottom: 2rem; }
    .summary { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .stat { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem 1.5rem; min-width: 100px; }
    .stat-value { font-size: 2rem; font-weight: 700; }
    .stat-label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    .section { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 1.5rem; overflow: hidden; }
    .section-header { padding: 0.875rem 1.5rem; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; gap: 0.5rem; }
    .section-header h2 { font-size: 0.9rem; font-weight: 600; }
    .meta-right { margin-left: auto; font-size: 0.8rem; color: #64748b; }
    .badge { font-size: 0.65rem; font-weight: 700; padding: 0.2em 0.6em; border-radius: 9999px; text-transform: uppercase; }
    .badge-pass { background: #dcfce7; color: #166534; }
    .badge-fail { background: #fee2e2; color: #991b1b; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 0.5rem 1.5rem; background: #f8fafc; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; }
    td { padding: 0.625rem 1.5rem; border-top: 1px solid #f1f5f9; word-break: break-all; vertical-align: top; }
    tr:hover td { background: #f8fafc; }
    .sev { font-size: 0.65rem; font-weight: 700; padding: 0.2em 0.6em; border-radius: 4px; color: #fff; white-space: nowrap; }
    .empty { padding: 1.5rem; color: #64748b; font-size: 0.875rem; }
  </style>
</head>
<body>
  <h1>Sentinel Audit Report</h1>
  <p class="meta">Generated: ${new Date().toLocaleString()} &nbsp;|&nbsp; Auditors run: ${results.length} &nbsp;|&nbsp; Total findings: ${allFindings.length}</p>

  <div class="summary">
    <div class="stat">
      <div class="stat-value">${results.length}</div>
      <div class="stat-label">Auditors</div>
    </div>
    <div class="stat">
      <div class="stat-value" style="color:#166534">${passed}</div>
      <div class="stat-label">Passed</div>
    </div>
    <div class="stat">
      <div class="stat-value" style="color:#991b1b">${failed}</div>
      <div class="stat-label">Failed</div>
    </div>
    <div class="stat">
      <div class="stat-value">${allFindings.length}</div>
      <div class="stat-label">Findings</div>
    </div>
  </div>

  ${resultSections}
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf-8');
  return outputPath;
}
