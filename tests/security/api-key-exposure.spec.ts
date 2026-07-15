import { test, expect } from '@playwright/test';
import { auditApiKeyExposure } from '../../src/auditors/api-key-exposure';
import { defaultSite } from '../../src/config/sites';

// Pure client-side scan — no backend interaction, so this behaves identically in safe mode
// and LIVE_MODE. No CF route interception is needed.
const AUDIT_PATHS = [
  '/',
  '/account.html',
  '/checkout.html',
  '/track.html',
  '/welcome.html',
  '/terms.html',
] as const;

test.describe('API key exposure', { tag: ['@security'] }, () => {

  test('api-key-exposure — no LLM/payment/cloud provider secret keys appear in client-accessible page source or scripts', async ({ page }, testInfo) => {
    test.slow();
    testInfo.annotations.push({
      type: 'description',
      description:
        'Scanned every known public page across three sources — the raw page HTML, every inline ' +
        '<script> tag, and every same-origin external script file — for secret API key patterns from ' +
        'Anthropic, OpenAI, Stripe, AWS, and Supabase, plus a generic Bearer-token-in-a-fetch-call ' +
        'pattern. This is a pure client-side scan with no backend dependency, so it runs identically ' +
        'in safe mode and LIVE_MODE. Any secret key visible in browser-downloadable code can be ' +
        'extracted by any visitor using nothing more than DevTools — these keys must exist only in ' +
        'server-side environment variables. Matched values are never shown in full in this report: ' +
        'only the first 8 characters are recorded, followed by "...redacted".',
    });

    const result = await auditApiKeyExposure(page, Array.from(AUDIT_PATHS), defaultSite.baseUrl);

    await testInfo.attach('audit-result', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(result, null, 2)),
    });

    for (const f of result.findings) {
      if (f.severity === 'info') {
        console.log(`[INFO] api-key-exposure [${f.url}]: ${f.message}`);
        continue;
      }
      console.error(
        `[FINDING][${f.severity}] api-key-exposure [${f.url}]: ${f.message}` +
          (f.detail   ? ` — ${f.detail}`   : '') +
          (f.selector ? ` (${f.selector})` : ''),
      );
    }

    const criticalFindings = result.findings.filter(f => f.severity === 'critical');
    console.log(
      `[INFO] api-key-exposure: ${criticalFindings.length} exposed key(s) found across ${AUDIT_PATHS.length} page(s).`,
    );

    // Hard fail, matching the established convention in this directory (credential-exposure.spec.ts)
    // — an exposed secret key is a genuine defect, not a review-only code-quality nitpick.
    expect(criticalFindings, 'No API key patterns must appear in client-accessible page source or scripts').toHaveLength(0);
  });

});
