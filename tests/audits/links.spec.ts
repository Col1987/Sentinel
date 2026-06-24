import { test } from '@playwright/test';
import { auditBrokenLinks } from '../../src/auditors/links';
import { generateReport } from '../../src/reports/generator';
import { defaultSite } from '../../src/config/sites';

test.describe('Broken links audit @regression', () => {
  test('should have no broken links on the homepage', async ({ page }) => {
    await page.goto('/');

    const result = await auditBrokenLinks(page, defaultSite.baseUrl);
    generateReport([result], 'reports');

    const broken = result.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');

    if (broken.length > 0) {
      const summary = broken.map((f) => `  [${f.message}] ${f.url}`).join('\n');
      throw new Error(`${broken.length} broken link(s) found:\n${summary}`);
    }
  });
});
