import { Page, request } from '@playwright/test';
import type { AuditResult, AuditFinding } from './types';

// ─── Evaluate-layer types (compile-time only — erased before browser serialisation) ──

interface DuplicateId     { id: string; count: number }
interface OrphanedHandler { selector: string; attr: string; fnName: string }
interface DeadForm        { selector: string; hasButtons: boolean }
interface AssetRef        { type: 'stylesheet' | 'script' | 'preload'; url: string }
interface BadAria         { selector: string; label: string; reason: string }
interface DupMeta         { tag: string; count: number }
interface LocalhostRef    { kind: 'script' | 'attribute'; selector: string; value: string; match: string }
interface EmptyHrefLink   { selector: string; href: string; text: string }
interface MixedContent    { selector: string; attr: string; value: string }
interface TestDataRef     { pattern: string; count: number; context: string }

interface CodeQualityPageData {
  duplicateIds:     DuplicateId[];
  orphanedHandlers: OrphanedHandler[];
  deadForms:        DeadForm[];
  assets:           AssetRef[];
  badAria:          BadAria[];
  duplicateMeta:    DupMeta[];
  localhostRefs:    LocalhostRef[];
  emptyHrefLinks:   EmptyHrefLink[];
  consoleLogCount:  number;
  mixedContent:     MixedContent[];
  testDataRefs:     TestDataRef[];
}

const ASSET_TIMEOUT = 10_000;

export async function auditCodeQuality(
  page: Page,
  paths: string[],
  baseUrl: string,
): Promise<AuditResult> {
  const start         = Date.now();
  const findings: AuditFinding[] = [];
  const checkedAssets = new Set<string>();  // deduplicate across pages
  const apiContext    = await request.newContext();

  try {
    for (const path of paths) {
      const pageUrl = `${baseUrl}${path === '/' ? '' : path}`;

      try {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
      } catch (err) {
        findings.push({
          url: pageUrl, severity: 'info', category: 'code-quality',
          message:  `Navigation to ${path} failed`,
          detail:   err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      let data: CodeQualityPageData;
      try {
        data = await page.evaluate((): CodeQualityPageData => {
          // ── 1. Duplicate IDs ────────────────────────────────────────────────
          const idCounts = new Map<string, number>();
          document.querySelectorAll('[id]').forEach(el => {
            const { id } = el;
            if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
          });
          const duplicateIds: DuplicateId[] = Array.from(idCounts.entries())
            .filter(([, n]) => n > 1)
            .map(([id, count]) => ({ id, count }));

          // ── 2. Orphaned event handlers ──────────────────────────────────────
          const SKIP = new Set([
            'function','return','if','else','for','while','do','switch','case',
            'try','catch','finally','throw','typeof','instanceof','void','delete',
            'new','this','class','let','const','var','import','export','async',
            'await','yield','of','in',
          ]);
          const HANDLER_ATTRS = ['onclick','onchange','onsubmit','onfocus','onblur'];
          const orphanedHandlers: OrphanedHandler[] = [];

          document.querySelectorAll(
            HANDLER_ATTRS.map(a => `[${a}]`).join(','),
          ).forEach(el => {
            const selector = el.id
              ? `#${CSS.escape(el.id)}`
              : el.tagName.toLowerCase();

            for (const attr of HANDLER_ATTRS) {
              const value = el.getAttribute(attr);
              if (!value) continue;
              const fnPattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
              const seen      = new Set<string>();
              let   match: RegExpExecArray | null;

              while ((match = fnPattern.exec(value)) !== null) {
                const fnName     = match[1];
                const charBefore = value[match.index - 1];
                if (charBefore === '.' || SKIP.has(fnName) || seen.has(fnName)) continue;
                seen.add(fnName);
                if (typeof (window as any)[fnName] === 'undefined') {
                  orphanedHandlers.push({ selector, attr, fnName });
                }
              }
            }
          });

          // ── 3. Dead forms ───────────────────────────────────────────────────
          const deadForms: DeadForm[] = [];
          document.querySelectorAll('form').forEach((form, i) => {
            const selector    = form.id
              ? `form#${CSS.escape(form.id)}`
              : `form:nth-of-type(${i + 1})`;
            const hasAction   = form.getAttribute('action') !== null;
            const hasOnsubmit = !!form.getAttribute('onsubmit');
            const hasOnclick  = !!form.querySelector('[onclick]');
            if (!hasAction && !hasOnsubmit && !hasOnclick) {
              const hasButtons = !!form.querySelector('button, input[type="submit"]');
              deadForms.push({ selector, hasButtons });
            }
          });

          // ── 4. Asset URLs (resolved to absolute for HEAD checks) ────────────
          const assets: AssetRef[] = [];
          const addAsset = (type: AssetRef['type'], raw: string | null) => {
            if (!raw) return;
            try {
              const resolved = new URL(raw, document.baseURI).href;
              if (/^https?:\/\//.test(resolved)) assets.push({ type, url: resolved });
            } catch { /* malformed URL — skip */ }
          };

          document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')
            .forEach(el => addAsset('stylesheet', el.getAttribute('href')));
          document.querySelectorAll<HTMLScriptElement>('script[src]')
            .forEach(el => addAsset('script', el.getAttribute('src')));
          document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][href]')
            .forEach(el => addAsset('preload', el.getAttribute('href')));

          // ── 5. Low-quality aria-label ───────────────────────────────────────
          const GENERIC = new Set([
            'click here','click','here','input','link','button','text',
            'submit','image','icon','label','field',
          ]);
          const badAria: BadAria[] = [];

          document.querySelectorAll('[aria-label]').forEach(el => {
            const raw   = el.getAttribute('aria-label') ?? '';
            const label = raw.trim();
            const tag   = el.tagName.toLowerCase();
            const selector = el.id
              ? `#${CSS.escape(el.id)}`
              : `${tag}[aria-label]`;

            let reason = '';
            if (label.length < 3) {
              reason = 'fewer than 3 characters';
            } else if (label.toLowerCase() === tag) {
              reason = `identical to tag name "${tag}"`;
            } else if (GENERIC.has(label.toLowerCase())) {
              reason = 'generic placeholder text';
            }

            if (reason) badAria.push({ selector, label, reason });
          });

          // ── 6. Duplicate meta tags ──────────────────────────────────────────
          const duplicateMeta: DupMeta[] = [];
          const checkMeta = (selector: string, tag: string) => {
            const n = document.querySelectorAll(selector).length;
            if (n > 1) duplicateMeta.push({ tag, count: n });
          };
          checkMeta('title',                    'title');
          checkMeta('meta[name="description"]', 'meta[name="description"]');
          checkMeta('meta[name="viewport"]',    'meta[name="viewport"]');

          // ── 7. Hardcoded localhost ──────────────────────────────────────────
          const LOCALHOST_PATTERNS = ['localhost', '127.0.0.1', '0.0.0.0'];
          const localhostRefs: LocalhostRef[] = [];

          // Inline scripts
          document.querySelectorAll('script:not([src])').forEach((script, i) => {
            const content = script.textContent ?? '';
            const seenInScript = new Set<string>();
            for (const match of LOCALHOST_PATTERNS) {
              if (!content.includes(match) || seenInScript.has(match)) continue;
              seenInScript.add(match);
              const lineIdx = content.indexOf(match);
              const lineStart = content.lastIndexOf('\n', lineIdx) + 1;
              const lineEnd   = content.indexOf('\n', lineIdx);
              const value = content
                .slice(lineStart, lineEnd === -1 ? lineIdx + 80 : lineEnd)
                .trim()
                .slice(0, 100);
              localhostRefs.push({ kind: 'script', selector: `script:nth-of-type(${i + 1})`, value, match });
            }
          });

          // href / src attributes
          document.querySelectorAll('[href], [src]').forEach(el => {
            for (const attr of ['href', 'src'] as const) {
              const val = el.getAttribute(attr);
              if (!val) continue;
              for (const match of LOCALHOST_PATTERNS) {
                if (!val.includes(match)) continue;
                const selector = el.id
                  ? `#${CSS.escape(el.id)}`
                  : `${el.tagName.toLowerCase()}[${attr}]`;
                localhostRefs.push({ kind: 'attribute', selector, value: val.slice(0, 100), match });
              }
            }
          });

          // ── 8. Empty href links ─────────────────────────────────────────────
          const emptyHrefLinks: EmptyHrefLink[] = [];
          document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(el => {
            const href     = el.getAttribute('href') ?? '';
            const hrefLow  = href.trim().toLowerCase();
            const isEmpty  = hrefLow === '' || hrefLow === '#' || hrefLow.startsWith('javascript:');
            if (!isEmpty) return;
            const text     = el.innerText?.trim() ?? '';
            const selector = el.id
              ? `#${CSS.escape(el.id)}`
              : 'a[href]';
            emptyHrefLinks.push({ selector, href, text: text.slice(0, 60) });
          });

          // ── 9. Console.log in production ────────────────────────────────────
          let consoleLogCount = 0;
          document.querySelectorAll('script:not([src])').forEach(script => {
            const matches = (script.textContent ?? '').match(/console\.log\s*\(/g);
            if (matches) consoleLogCount += matches.length;
          });

          // ── 10. Mixed content ────────────────────────────────────────────────
          const mixedContent: MixedContent[] = [];
          if (window.location.protocol === 'https:') {
            document.querySelectorAll('[src], [href]').forEach(el => {
              for (const attr of ['src', 'href'] as const) {
                const val = el.getAttribute(attr);
                if (val && val.startsWith('http://')) {
                  const selector = el.id
                    ? `#${CSS.escape(el.id)}`
                    : el.tagName.toLowerCase();
                  mixedContent.push({ selector, attr, value: val.slice(0, 120) });
                }
              }
            });
          }

          // ── 11. Hardcoded test data ─────────────────────────────────────────
          const TEST_STRINGS = [
            'lorem ipsum', 'test@test.com', 'test@example.com',
            'john doe', 'jane doe', 'foo bar', 'placeholder text',
            'TODO', 'FIXME',
          ];
          const testDataRefs: TestDataRef[] = [];
          const bodyText = (document.body as HTMLElement).innerText ?? '';

          for (const pattern of TEST_STRINGS) {
            const regex   = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            const matches = bodyText.match(regex);
            if (!matches) continue;
            const idx     = bodyText.search(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
            const context = bodyText
              .slice(Math.max(0, idx - 20), idx + pattern.length + 60)
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 80);
            testDataRefs.push({ pattern, count: matches.length, context });
          }

          return {
            duplicateIds, orphanedHandlers, deadForms, assets, badAria, duplicateMeta,
            localhostRefs, emptyHrefLinks, consoleLogCount, mixedContent, testDataRefs,
          };
        });
      } catch (err) {
        findings.push({
          url: pageUrl, severity: 'info', category: 'code-quality',
          message:  `Code quality evaluation failed on ${path}`,
          detail:   err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const push = (f: Omit<AuditFinding, 'url' | 'category'>) =>
        findings.push({ url: pageUrl, category: 'code-quality', ...f });

      // ── Duplicate IDs ────────────────────────────────────────────────────────
      for (const { id, count } of data.duplicateIds) {
        push({
          severity: 'medium',
          message:  `[code-quality-duplicate-id] id="${id}" appears ${count} times`,
          selector: `#${id}`,
        });
      }

      // ── Orphaned handlers ────────────────────────────────────────────────────
      for (const { selector, attr, fnName } of data.orphanedHandlers) {
        push({
          severity: 'high',
          message:  `[code-quality-orphaned-handler] ${attr} references undefined function "${fnName}"`,
          selector,
        });
      }

      // ── Dead forms ───────────────────────────────────────────────────────────
      for (const { selector, hasButtons } of data.deadForms) {
        if (hasButtons) {
          push({
            severity: 'info',
            message:  '[code-quality-dead-form] Form may use JavaScript event listeners for submission',
            selector,
          });
        } else {
          push({
            severity: 'medium',
            message:  '[code-quality-dead-form] Form has no action, onsubmit handler, onclick hook, or submit buttons',
            selector,
          });
        }
      }

      // ── Phantom assets (HTTP HEAD per new URL) ───────────────────────────────
      for (const asset of data.assets) {
        if (checkedAssets.has(asset.url)) continue;
        checkedAssets.add(asset.url);

        let status: number | undefined;
        let errMsg: string | undefined;

        try {
          let resp = await apiContext.head(asset.url, { timeout: ASSET_TIMEOUT });
          // Some servers reject HEAD — retry with GET
          if (resp.status() === 405) {
            resp = await apiContext.get(asset.url, { timeout: ASSET_TIMEOUT });
          }
          status = resp.status();
        } catch (err) {
          errMsg = err instanceof Error ? err.message : String(err);
        }

        if (errMsg || (status !== undefined && status >= 400)) {
          const urlPath  = (() => { try { return new URL(asset.url).pathname; } catch { return asset.url; } })();
          const filename = urlPath.split('/').pop() ?? urlPath;
          const selector = asset.type === 'script'
            ? `script[src*="${filename}"]`
            : `link[href*="${filename}"]`;

          push({
            severity: 'high',
            message:  `[code-quality-phantom-asset] ${asset.type} returns ${errMsg ? 'network error' : `HTTP ${status}`}`,
            selector,
            detail:   errMsg ? `${asset.url} — ${errMsg}` : asset.url,
          });
        }
      }

      // ── Low-quality aria ─────────────────────────────────────────────────────
      for (const { selector, label, reason } of data.badAria) {
        push({
          severity: 'medium',
          message:  `[code-quality-low-quality-aria] aria-label "${label.slice(0, 40)}" is ${reason}`,
          selector,
        });
      }

      // ── Duplicate meta tags ──────────────────────────────────────────────────
      for (const { tag, count } of data.duplicateMeta) {
        push({
          severity: 'medium',
          message:  `[code-quality-duplicate-meta] <${tag}> appears ${count} times`,
          selector: tag,
        });
      }

      // ── Hardcoded localhost ───────────────────────────────────────────────────
      for (const { kind, selector, value, match } of data.localhostRefs) {
        push({
          severity: 'high',
          message:  `[code-quality-hardcoded-localhost] "${match}" found in ${kind === 'script' ? 'inline script' : 'attribute'}`,
          selector,
          detail:   value,
        });
      }

      // ── Empty href links ─────────────────────────────────────────────────────
      for (const { selector, href, text } of data.emptyHrefLinks) {
        push({
          severity: 'medium',
          message:  `[code-quality-empty-href] Placeholder link — "${text || '(no visible text)'}"`,
          selector,
          detail:   `href="${href}"`,
        });
      }

      // ── Console.log in production ─────────────────────────────────────────────
      if (data.consoleLogCount > 5) {
        push({
          severity: 'medium',
          message:  `[code-quality-console-log] ${data.consoleLogCount} console.log calls found in inline scripts`,
        });
      }

      // ── Mixed content ─────────────────────────────────────────────────────────
      for (const { selector, attr, value } of data.mixedContent) {
        push({
          severity: 'high',
          message:  `[code-quality-mixed-content] HTTP resource on HTTPS page (${attr})`,
          selector,
          detail:   value,
        });
      }

      // ── Hardcoded test data ───────────────────────────────────────────────────
      for (const { pattern, count, context } of data.testDataRefs) {
        push({
          severity: 'medium',
          message:  `[code-quality-hardcoded-test-data] "${pattern}" found in visible page text${count > 1 ? ` (${count} times)` : ''}`,
          detail:   `…${context}…`,
        });
      }
    }
  } finally {
    await apiContext.dispose();
  }

  return {
    auditor:    'code-quality',
    targetUrl:  baseUrl,
    timestamp:  new Date().toISOString(),
    durationMs: Date.now() - start,
    passed:     true,
    warning:    findings.some(f => f.severity !== 'info'),
    findings,
  };
}
