import { test } from '@playwright/test';
import { auditAccessibility } from '../../src/auditors/accessibility';
import { defaultSite } from '../../src/config/sites';

const pages = defaultSite.pages ?? ['/'];

test.describe('Accessibility audit', { tag: '@audit' }, () => {
  for (const pagePath of pages) {
    test(`audit a11y findings on ${pagePath} @a11y`, async ({ page }, testInfo) => {
      testInfo.annotations.push({ type: 'description', description: `Ran a full accessibility scan on the page at ${pagePath} using industry-standard tools. Accessibility issues can prevent visitors with disabilities from using the site and may create legal compliance obligations.` });
      await page.goto(pagePath);

      const targetUrl = `${defaultSite.baseUrl}${pagePath === '/' ? '' : pagePath}`;
      const result = await auditAccessibility(page, targetUrl);

      await testInfo.attach('audit-result', {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(result)),
      });
    });
  }
});
