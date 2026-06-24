import * as fs from 'fs';
import * as path from 'path';
import { test } from '@playwright/test';
import { discoverInteractiveElements } from '../../src/auditors/discovery';
import type { PageDiscovery } from '../../src/auditors/discovery';
import { generateReport } from '../../src/reports/generator';
import { defaultSite } from '../../src/config/sites';
import type { AuditResult } from '../../src/auditors/types';

const pages = defaultSite.pages ?? ['/'];

test.describe('Site discovery', { tag: ['@audit', '@discovery'] }, () => {
  // Single test iterates all pages so the JSON output is written atomically
  // once all pages have been visited, rather than in parallel workers.
  test('map interactive elements across all pages @discovery', async ({ page }) => {
    const discoveries: PageDiscovery[] = [];
    const results: AuditResult[] = [];

    for (const pagePath of pages) {
      await page.goto(pagePath);

      const targetUrl = `${defaultSite.baseUrl}${pagePath === '/' ? '' : pagePath}`;
      const { result, discovery } = await discoverInteractiveElements(page, targetUrl);

      discoveries.push(discovery);
      results.push(result);
    }

    // ── Write JSON element map ──────────────────────────────────────────────

    const outputDir = 'reports';
    fs.mkdirSync(outputDir, { recursive: true });

    const jsonPayload = {
      generatedAt: new Date().toISOString(),
      targetUrl: defaultSite.baseUrl,
      pages: discoveries,
    };

    fs.writeFileSync(
      path.join(outputDir, 'discovery.json'),
      JSON.stringify(jsonPayload, null, 2),
      'utf-8',
    );

    // ── Write HTML report ───────────────────────────────────────────────────

    generateReport(results, outputDir);
  });
});
