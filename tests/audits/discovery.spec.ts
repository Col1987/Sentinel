import * as fs from 'fs';
import * as path from 'path';
import { test } from '@playwright/test';
import { discoverInteractiveElements } from '../../src/auditors/discovery';
import type { PageDiscovery } from '../../src/auditors/discovery';
import { defaultSite } from '../../src/config/sites';
import type { AuditResult } from '../../src/auditors/types';

const pages = defaultSite.pages ?? ['/'];

test.describe('Site discovery', { tag: ['@audit', '@discovery'] }, () => {
  // Single test iterates all pages so the JSON output is written atomically
  // once all pages have been visited, rather than in parallel workers.
  test('map interactive elements across all pages @discovery', async ({ page }, testInfo) => {
    testInfo.annotations.push({ type: 'description', description: "Mapped all interactive elements across the site (forms, buttons, links, input fields) and saved them to a structured inventory file. This catalogue is used to guide future testing and identify which areas of the site have and have not been covered." });
    const discoveries: PageDiscovery[] = [];
    const results: AuditResult[] = [];

    for (const pagePath of pages) {
      await page.goto(pagePath);

      const targetUrl = `${defaultSite.baseUrl}${pagePath === '/' ? '' : pagePath}`;
      const { result, discovery } = await discoverInteractiveElements(page, targetUrl);

      discoveries.push(discovery);
      results.push(result);
    }

    // ── Attach each AuditResult for the unified reporter ────────────────────

    for (const result of results) {
      await testInfo.attach('audit-result', {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(result)),
      });
    }

    // ── Write JSON element map ───────────────────────────────────────────────

    const outputDir = 'reports';
    fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(
      path.join(outputDir, 'discovery.json'),
      JSON.stringify(
        { generatedAt: new Date().toISOString(), targetUrl: defaultSite.baseUrl, pages: discoveries },
        null,
        2,
      ),
      'utf-8',
    );
  });
});
