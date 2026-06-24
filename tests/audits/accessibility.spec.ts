import { test } from '@playwright/test';
import { auditAccessibility } from '../../src/auditors/accessibility';
import { generateReport } from '../../src/reports/generator';
import { defaultSite } from '../../src/config/sites';

const pages = defaultSite.pages ?? ['/'];

test.describe('Accessibility audit', { tag: '@audit' }, () => {
  for (const path of pages) {
    test(`audit a11y findings on ${path} @a11y`, async ({ page }) => {
      await page.goto(path);

      const targetUrl = `${defaultSite.baseUrl}${path === '/' ? '' : path}`;
      const result = await auditAccessibility(page, targetUrl);
      generateReport([result], 'reports');
    });
  }
});
