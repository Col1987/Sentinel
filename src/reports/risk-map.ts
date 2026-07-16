// Risk Coverage matrix — maps documented business risks to the tests that provide
// evidence for or against them. Confidence is NOT hardcoded here — it's computed at
// report-build time (see renderRiskCoverageSection in sentinel-reporter.ts) from the
// actual pass/fail results of the matched tests in the current run. This file only
// holds the static mapping: which risk, how it could happen, which test-name patterns
// are relevant, and a manually-authored rationale explaining what a clean or failing
// result actually demonstrates for that specific risk — the reporter can't infer that
// domain context from a bare test title.
//
// Patterns are matched via substring (string) or regex against each test's raw title —
// the "test-id — narrative" string passed to test(), matching this codebase's naming
// convention (see CLAUDE.md "Test names describe the expected behaviour").
//
// Source: risk/cause/coverage content supplied directly by Colin (this repo has no
// JUELHAUS_TESTING_SUMMARY.md — confirmed absent from the working tree and full git
// history before this file was written).

export interface RiskEntry {
  id: string;
  risk: string;
  couldItHappen: string;
  testPatterns: Array<string | RegExp>;
  confidenceRationale: string;
}

export const RISK_MAP: RiskEntry[] = [
  {
    id: 'wrong-charge-amount',
    risk: 'Customer charged wrong amount',
    couldItHappen: 'Client manipulates the price in DevTools before checkout, and the backend trusts the client-submitted value instead of re-deriving it server-side.',
    testPatterns: ['price-manipulation-detection'],
    confidenceRationale: 'Confirmed via the Cloud Function payload — pricing must be looked up server-side from the pack catalog, ignoring any client-supplied price field.',
  },
  {
    id: 'cross-account-payment',
    risk: 'One customer pays for another\'s order',
    couldItHappen: 'A customer calls createPayFastPayment with another customer\'s orderId, and the callable function processes it without verifying ownership.',
    testPatterns: ['create-payfast-payment-rejects-non-owner'],
    confidenceRationale: 'Confirmed by calling the callable Cloud Function directly with a mismatched customer/order pair and checking the server rejects it, not just hiding the action in the UI.',
  },
  {
    id: 'double-charge',
    risk: 'Customer double-charged',
    couldItHappen: 'createPayFastPayment is called a second time against an order already marked paid, generating a duplicate charge.',
    testPatterns: ['create-payfast-payment-rejects-already-paid'],
    confidenceRationale: 'Confirmed by calling the callable function again on an already-paid order and checking the server rejects it, independent of any client-side "already paid" UI state.',
  },
  {
    id: 'cross-guest-data-leak',
    risk: 'Guest sees another guest\'s data',
    couldItHappen: 'The welcome page or order tracking page renders data scoped to the wrong order or customer, exposing one guest\'s stay details, Wi-Fi credentials, or address to another.',
    testPatterns: ['welcome-page-no-cross-customer-leak', 'track-other-users-order', 'order-tracking-cross-customer-check'],
    confidenceRationale: 'Confirmed by loading each customer\'s own welcome/tracking page and checking it contains none of a second, real customer\'s data.',
  },
  {
    id: 'admin-search-leak',
    risk: 'Admin can see another customer\'s order via search',
    couldItHappen: 'The admin order search uses substring/prefix matching instead of exact-match, so searching for one customer\'s email also surfaces another customer\'s order (e.g. shared "+tag" email bases).',
    testPatterns: ['admin-order-search-isolation'],
    confidenceRationale: 'This is a known, already-documented finding (see README Roadmap) — the search has been confirmed to leak across customers with overlapping email prefixes; this is not a theoretical risk.',
  },
  {
    id: 'dropped-cart-item',
    risk: 'Order silently lost on multi-item checkout',
    couldItHappen: 'Adding two packs to the cart and completing one checkout, a race or overwrite in the order-creation logic drops one of the items — the customer is billed for two but receives only one.',
    testPatterns: ['multiple-packs-single-checkout'],
    confidenceRationale: 'This is a known, already-documented finding (see README Roadmap) — a real dropped-item defect confirmed via the admin order record, not a false alarm.',
  },
  {
    id: 'client-side-key-exposure',
    risk: 'Attacker steals API/LLM keys from client code',
    couldItHappen: 'A secret key (Anthropic, PayFast, TCG courier, or another provider) is hardcoded into a file the browser downloads, letting any visitor extract it via DevTools.',
    testPatterns: [
      'api-key-exposure',
      'no-payfast-credentials-in-source',
      'no-tcg-api-key-in-source',
      'no-md5-script-loaded',
      'no-deprecated-project-reference',
      'config-js-only-contains-safe-values',
    ],
    confidenceRationale: 'Confirmed by scanning every known public page\'s raw HTML, inline scripts, and same-origin external scripts for known secret-key formats and known credential patterns — a clean result means no known key format was found in browser-downloadable code, not that no secret could ever exist.',
  },
  {
    id: 'unauthorized-admin-access',
    risk: 'Unauthorized admin access',
    couldItHappen: 'A non-admin user reaches admin functionality or data by hiding the auth overlay via DOM manipulation, hitting admin-only tabs without a valid session, or exploiting a stale/expired session token.',
    testPatterns: ['regular-user-blocked-from-admin', 'admin-tabs-without-auth', 'expired-session-handling'],
    confidenceRationale: 'Confirmed by forcibly bypassing the UI-level auth overlay (DOM removal, forced clicks) and verifying the backend — not just the UI — rejects unauthenticated access; a pass means Firestore rules and callable-function auth checks hold independently of client-side gating.',
  },
];
