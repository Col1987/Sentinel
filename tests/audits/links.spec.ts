import { test } from '@playwright/test';
import { auditBrokenLinks } from '../../src/auditors/links';
import { defaultSite } from '../../src/config/sites';

test.describe('Broken links audit', { tag: ['@audit', '@regression'] }, () => {
  test('should have no broken links on the homepage', async ({ page }, testInfo) => {
    testInfo.annotations.push({ type: 'description', description: "Automatically checked every link on the homepage to verify they all lead to working pages. Broken links frustrate visitors, damage trust, and can harm search engine rankings." });
    await page.goto('/');

    const result = await auditBrokenLinks(page, defaultSite.baseUrl);

    await testInfo.attach('audit-result', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(result)),
    });

    const broken = result.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');

    if (broken.length > 0) {
      const summary = broken.map((f) => `  [${f.message}] ${f.url}`).join('\n');
      throw new Error(`${broken.length} broken link(s) found:\n${summary}`);
    }
  });
});
