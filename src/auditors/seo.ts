import { Page } from '@playwright/test';
import type { AuditResult, AuditFinding } from './types';

interface SeoPageData {
  title: string;
  metaDescription: string;
  h1Count: number;
  headingLevels: number[];
  hasOgTitle: boolean;
  hasOgDescription: boolean;
  hasOgImage: boolean;
  hasCanonical: boolean;
  htmlLang: string;
  imagesWithoutAlt: string[];
}

export async function auditSeo(
  page: Page,
  paths: string[],
  baseUrl: string,
): Promise<AuditResult> {
  const start    = Date.now();
  const findings: AuditFinding[] = [];

  for (const path of paths) {
    const pageUrl = `${baseUrl}${path === '/' ? '' : path}`;

    try {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      findings.push({
        url:      pageUrl,
        severity: 'info',
        category: 'seo',
        message:  `Navigation to ${path} failed`,
        detail:   err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let data: SeoPageData;
    try {
      data = await page.evaluate((): SeoPageData => {
        const title    = document.title ?? '';
        const metaDesc = document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? '';
        const headings = Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'));

        const imagesWithoutAlt = Array.from(
          document.querySelectorAll<HTMLImageElement>('img:not([alt])'),
        ).map((img, i) => {
          if (img.id) return `img#${CSS.escape(img.id)}`;
          const src  = img.getAttribute('src') ?? '';
          const file = src.split('/').pop()?.split('?')[0] ?? '';
          return file && file.length < 40 ? `img[src*="${file}"]` : `img:nth-of-type(${i + 1})`;
        });

        return {
          title,
          metaDescription: metaDesc,
          h1Count: document.querySelectorAll('h1').length,
          headingLevels: headings.map(h => parseInt(h.tagName.slice(1), 10)),
          hasOgTitle:       !!document.querySelector('meta[property="og:title"]'),
          hasOgDescription: !!document.querySelector('meta[property="og:description"]'),
          hasOgImage:       !!document.querySelector('meta[property="og:image"]'),
          hasCanonical:     !!document.querySelector('link[rel="canonical"]'),
          htmlLang: document.documentElement.getAttribute('lang') ?? '',
          imagesWithoutAlt,
        };
      });
    } catch (err) {
      findings.push({
        url:      pageUrl,
        severity: 'info',
        category: 'seo',
        message:  `SEO evaluation failed on ${path}`,
        detail:   err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const push = (finding: Omit<AuditFinding, 'url' | 'category'>) =>
      findings.push({ url: pageUrl, category: 'seo', ...finding });

    // ── Title ──────────────────────────────────────────────────────────────────
    if (!data.title) {
      push({ severity: 'medium', message: '[seo-title] Page title missing or out of range',
        detail: 'Title is empty — add a <title> element inside <head>' });
    } else if (data.title.length < 10 || data.title.length > 60) {
      push({ severity: 'medium', message: '[seo-title] Page title missing or out of range',
        detail: `Title is ${data.title.length} chars (expected 10–60): "${data.title.slice(0, 80)}"` });
    }

    // ── Meta description ───────────────────────────────────────────────────────
    if (!data.metaDescription) {
      push({ severity: 'medium', message: '[seo-meta-description] Meta description missing or out of range',
        detail: 'No <meta name="description"> found' });
    } else if (data.metaDescription.length < 50 || data.metaDescription.length > 160) {
      push({ severity: 'medium', message: '[seo-meta-description] Meta description missing or out of range',
        detail: `Meta description is ${data.metaDescription.length} chars (expected 50–160)` });
    }

    // ── Single H1 ─────────────────────────────────────────────────────────────
    if (data.h1Count === 0) {
      push({ severity: 'medium', message: '[seo-h1] Page must have exactly one <h1> heading',
        detail: 'No <h1> element found' });
    } else if (data.h1Count > 1) {
      push({ severity: 'medium', message: '[seo-h1] Page must have exactly one <h1> heading',
        detail: `${data.h1Count} <h1> elements found — consolidate to one` });
    }

    // ── Heading hierarchy ─────────────────────────────────────────────────────
    const levelJumps: string[] = [];
    const levels = data.headingLevels;
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] > levels[i - 1] + 1) {
        levelJumps.push(`h${levels[i - 1]}→h${levels[i]}`);
      }
    }
    if (levelJumps.length > 0) {
      push({ severity: 'low', message: '[seo-heading-order] Heading hierarchy skips a level',
        detail: `Level jump(s): ${levelJumps.join(', ')}` });
    }

    // ── Open Graph ────────────────────────────────────────────────────────────
    const missingOg: string[] = [];
    if (!data.hasOgTitle)       missingOg.push('og:title');
    if (!data.hasOgDescription) missingOg.push('og:description');
    if (!data.hasOgImage)       missingOg.push('og:image');
    if (missingOg.length > 0) {
      push({ severity: 'low', message: '[seo-open-graph] Open Graph tags missing',
        detail: `Missing: ${missingOg.join(', ')}` });
    }

    // ── Canonical ─────────────────────────────────────────────────────────────
    if (!data.hasCanonical) {
      push({ severity: 'medium', message: '[seo-canonical] Canonical URL missing',
        detail: 'No <link rel="canonical"> found in <head>' });
    }

    // ── HTML lang ─────────────────────────────────────────────────────────────
    if (!data.htmlLang) {
      push({ severity: 'medium', message: '[seo-lang] <html> lang attribute missing',
        detail: 'The <html> element has no lang attribute' });
    }

    // ── Image alt attributes ──────────────────────────────────────────────────
    for (const selector of data.imagesWithoutAlt) {
      push({ severity: 'medium', message: '[seo-img-alt] Image missing alt attribute',
        selector });
    }
  }

  return {
    auditor:    'seo',
    targetUrl:  baseUrl,
    timestamp:  new Date().toISOString(),
    durationMs: Date.now() - start,
    passed:     true,
    warning:    findings.some(f => f.severity !== 'info'),
    findings,
  };
}
