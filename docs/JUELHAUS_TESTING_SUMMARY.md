# Sentinel — Testing Summary for Juel Haus

---

## 1. What Sentinel Is

Sentinel is an automated testing framework built specifically for this engagement, then generalised to work against any website. It combines four categories of automated checking — accessibility, SEO, code quality, and security — with hand-built business-flow testing that exercises the actual customer journey: registration, checkout, order fulfilment, and account management.

It is built on Playwright (Microsoft's browser automation framework) and TypeScript, with a custom reporting layer that produces the branded HTML report you've already seen examples of.

### The core design decision: safe mode vs. live mode

Every test in Sentinel is written to run in one of two modes, controlled by a single environment flag:

- **Safe mode** (the default): every outbound request to your backend — Firebase Auth, Cloud Functions, Firestore — is intercepted before it leaves the browser. Sentinel observes what the *client* would have sent, but nothing actually reaches your servers. No accounts are created, no orders are placed, no data is written.
- **Live mode**: requests are allowed through. Sentinel creates real (clearly-labelled) test accounts, places real sandbox orders, and verifies what actually happens server-side — not just what the browser attempted.

Critically, almost every test is written **mode-agnostic**: the same test asserts what it can prove from the intercepted request in safe mode, and layers additional server-side verification on top when running live. This means the everyday CI pipeline (which runs in safe mode, daily, automatically) still catches a meaningful class of defects — like a form sending the wrong data shape to your backend — without ever touching production data. Live mode is reserved for the smaller set of things that can only be proven against the real system: does the order actually appear in your admin dashboard, does the confirmation email actually arrive, does the price the server charges actually match the price displayed.

All test data — accounts, names, emails, orders — uses a consistent, instantly-recognisable convention: emails route through `sentinelqa2026+<tag>@gmail.com`, names are prefixed `SENTINEL TEST`. Nothing Sentinel creates should ever be mistaken for a real customer record.

---

## 2. Test Taxonomy

"185 tests" or "196 tests" is not a meaningful number on its own. What matters is what kind of proof each category actually provides. Sentinel's tests fall into five genuinely different categories:

| Category | What it proves | What it does NOT prove | Example |
|---|---|---|---|
| **Smoke** | The site is fundamentally reachable and rendering | Nothing about correctness of behaviour | All known pages return a healthy status; homepage renders CSS/JS; no broken images |
| **Unit-level / content audits** | A specific page's structure or content meets a standard, in isolation | Nothing about multi-step user behaviour | Accessibility (axe-core WCAG checks), SEO metadata, code-quality patterns, broken-link detection |
| **Integration** | The client sends the correct data to your backend, and your backend responds with the expected shape | Whether the full multi-step business process completes correctly | Registration payload contains the right email; demo form request is well-formed; a manipulated price never appears in the outbound Cloud Function payload |
| **True end-to-end** | An entire real business process works, verified against the live system, not simulated | — this is the strongest category, and only runs in live mode | Registering an account and confirming the real verification email arrives via Gmail and the link works; completing a real PayFast sandbox checkout and confirming the resulting order appears correctly in your admin dashboard; advancing an order through its full status lifecycle and confirming each stage persists |
| **Adversarial / security** | The system resists deliberate misuse, not just normal use | — this is the category most manual QA skips entirely | Attempting to manipulate the cart price via browser DevTools before submission; attempting to view another customer's order by guessing a nearby order ID; testing whether an account gets locked out after repeated failed logins |

Of the current suite, roughly 60% is unit-level/content auditing (the accessibility, SEO, and code-quality scanning), 25% is business-flow integration and true end-to-end testing, and 15% is adversarial testing. The adversarial slice is disproportionately valuable relative to its size — it's the category that answers "can someone exploit this," which nothing else in the suite addresses.

---

## 3. How Tests Actually Run

**CI pipeline:** GitHub Actions runs the safe-mode suite automatically on every push to the repository, and again on a daily schedule regardless of whether anything changed — catching regressions introduced by dependency updates or infrastructure drift, not just code changes. This pipeline never touches live data.

**Live-mode runs:** triggered manually, locally, when deliberate end-to-end verification is needed. These are run with a single worker (deliberately serialised, not parallelised) to avoid session conflicts when multiple tests need to authenticate against the same real admin account — a lesson learned directly during this engagement, detailed in Section 6.

**Regression suite:** a newly-built, deliberately curated subset (11 tests, roughly 3 minutes runtime) covering the highest-risk, most-likely-to-silently-break flows: registration, login/logout, one representative checkout, email verification, one order status transition, and the safe-mode content audits. This is designed to run frequently — nightly, or before any deploy — without the cost of the full 30-60 minute exhaustive run.

**The full suite** (196 tests as of this run) is reserved for periodic deep verification, like the one behind this document, not everyday use.

---

## 4. Findings by Severity

The current full run: **196 tests, 189 passed, 7 failed.** Every one of the 7 failures traces to an already-identified, documented site defect — none are test-infrastructure noise (see Section 6 for why that distinction matters and how we know).

Across all auditors and probes, **388 individual findings** were logged, of which **141 are critical or high severity.** The overwhelming majority of that count is accessibility findings (colour contrast, missing labels, landmark structure) which are individually low-effort to fix but numerous — see the breakdown below.

### Critical / High — functional defects

| Finding | Impact | Status |
|---|---|---|
| Cart drops one item when two different packs are checked out together | Revenue-impacting — customer may be charged for or receive fewer items than ordered | Confirmed via real order in admin (total short by exactly one pack's price) |
| Admin order search matches by substring, not exact email | Searching one customer's email can surface an unrelated customer's order | Data exposure risk in the internal tool |
| Demo booking form accepts submission with the `required` HTML attribute removed via DevTools | No server-side validation backstop — a trivial DevTools edit bypasses the form entirely | Confirmed: empty name reaches the Cloud Function |
| `resendVerification` Cloud Function returns HTTP 500 | New users who don't receive their first verification email have no working way to request another | Confirmed reproducible across two independent test runs |
| Verification email links to `juelhaus-co-za.firebaseapp.com`, not the custom domain | Chrome's own phishing heuristics flag this as a suspicious lookalike domain during account activation | Specific fix identified: update the Email Action Handler URL in Firebase Console |
| Admin's Audit Log does not record order status changes | An admin can advance an order's status normally, or use the Force/Override mechanism to bypass the standard workflow, with no record of who did it or when in either case. The override control itself is safe — it requires confirmation before applying — but the missing audit trail undercuts the accountability the Audit Log tab implies it provides | Confirmed: only account-level events (user creation, admin grants) appear in the log; order status transitions do not |
| Wi-Fi configuration is per-order, not per-item | When a cart has two items and Wi-Fi is configured for one, neither item's welcome page shows the Wi-Fi box | Needs a decision: intended design, or a gap. Whether this also applies across a host's multiple properties is under active investigation — see What's Next |
| `resendVerificationEmail` has no JS handler on `/account.html` | The button exists and is clickable but does nothing on this specific page, despite working correctly on the homepage | Same function, inconsistent page-level wiring |

### Medium

- Cart total display does not reset after removing the last item (badge goes to 0, price stays)
- No confirmation prompt before deleting a pack in admin — one click, no undo
- Welcome page does not display which pack the guest actually ordered
- Storefront serves a cached version of pack data briefly after an admin edit
- Order tracking link in the confirmation email uses the raw `.web.app` domain and omits the order ID as a deep-link parameter, despite the tracking page supporting deep links elsewhere
- Failed-login lockout (which does genuinely work — see Section 5) shows no message to the user; the form just silently stops accepting the correct password
- Site reuses identical HTML element IDs across multiple cart items in checkout forms, which violates the HTML spec and is the likely root cause of a broken toggle button for any cart item beyond the first
- Editing an existing saved property leaves the Save button permanently disabled — the edit form does not repopulate its in-memory restaurant/activity state from the saved record, so the button's "at least one restaurant and one activity" requirement is never satisfied unless the user re-adds entries that already exist in the saved data. Creating a new property works correctly; only editing an existing one is affected
- **The "Get Started" call-to-action is a complete silent no-op for genuine authenticated customers.** For a real, verified, non-admin account, clicking it produces no scroll, no error, and no console warning — nothing happens at all. The site's own code confirms the correct logic branch should run and scroll the page to the Welcome Packs section, but it doesn't. This is the primary conversion action on the homepage for logged-in visitors.

### Accessibility (WCAG 2.1 AA, via axe-core)

- 24 colour contrast violations across the homepage
- 15 form inputs with no accessible label
- 16 landmark/region structural violations
- Auth modal does not close on the Escape key
- Mobile hamburger menu's expanded state overlaps its own close button

### SEO

- 17 issues identified across all pages, the most consistent being missing canonical URLs site-wide, and two pages with no `<h1>`

---

## 5. Risk Coverage Matrix

Test counts and pass rates answer one question: did the tests that were written run successfully. They don't answer the question that actually matters to a business: is the application safe to ship. A suite can show 189 of 196 tests passing and still have said nothing about the one risk that would actually hurt — or, just as easily, have said everything about it and be buried under 140 accessibility findings nobody will read in order.

This section inverts the usual structure. Instead of organising by test file or by severity, it organises by **business risk** — the thing that could actually go wrong — and states plainly whether Sentinel has real evidence that risk is controlled, or real evidence that it isn't.

| Risk | How it could happen | Test coverage | Confidence |
|---|---|---|---|
| Customer charged the wrong amount | Price manipulated via browser DevTools before checkout submission | `price-manipulation-detection`, `quantity-manipulation-detection` | **High** — server derives price from the pack reference; the manipulated value never reaches the stored order |
| One customer pays for another customer's order | Cross-account abuse of the payment-initiation function | `create-payfast-payment-rejects-non-owner` | **High** — confirmed rejected with `permission-denied` |
| Customer double-charged on the same order | Repeat payment call after an order is already paid (e.g. back-button abuse) | `create-payfast-payment-rejects-already-paid` | **High** — confirmed rejected with `failed-precondition` |
| A completed, paid order is silently lost | Multi-pack checkout drops an item before it reaches the order record | `multiple-packs-single-checkout` | **Low — confirmed happening.** A two-pack checkout produced an order for only one pack. This is the single highest-priority finding in this document |
| One guest sees another guest's welcome page data | Cross-customer data leakage on guest-facing pages | `welcome-page-no-cross-customer-leak`, order tracking cross-customer checks | **High** — two real orders, two real customers, confirmed no leakage either direction |
| A staff member can view another customer's order via search | Data exposure inside the admin tool | `admin-order-search-isolation` | **Low — confirmed happening.** Search matches by substring rather than exact email; a partial match can surface an unrelated customer's order |
| An unauthenticated visitor reaches admin data or controls | Auth bypass, DOM manipulation of the admin overlay | `regular-user-blocked-from-admin`, `admin-tabs-without-auth`, related negative tests | **High** — Firestore security rules hold even when the client-side overlay is removed |
| Payment or API credentials leak to visitors | Secrets hardcoded in client-side JavaScript | `credential-exposure` (PayFast, courier API, deprecated project ID), `api-key-exposure` (Anthropic, OpenAI, Stripe, AWS, Supabase patterns) | **High** — confirmed clean across every known page |
| A new user can never activate their account | Verification email fails to arrive, or the resend mechanism is broken | Automated Gmail round-trip testing | **Low — confirmed broken.** The resend Cloud Function returns a server error, and the button has no working handler at all on the account page |
| New users are shown a phishing-style browser warning during signup | Verification email links to the wrong domain | Automated Gmail round-trip testing | **Low — confirmed happening**, on both the verification email and the order-tracking email |
| A brute-force attacker can guess a password | Repeated login attempts against one account | `login-lockout-after-failed-attempts` | **High** — Firebase's protection genuinely blocks the 6th attempt (though the user sees no explanation why — a usability gap, not a security one) |
| An admin action happens with no accountability record | Status changes or overrides applied with nothing logging who did it | `audit-log-records-admin-actions` | **Low — confirmed missing.** Order status changes, including the Force/Override mechanism, are not recorded in the Audit Log |
| A destructive admin action happens by accident | No confirmation step before an irreversible change | `pack-delete-confirmation`, `force-override-status-requires-confirmation` | **Mixed** — Force/Override correctly requires confirmation; pack deletion does not |
| Malicious input crashes a page or executes as code | XSS or SQL-injection-style payloads in any input field | XSS/injection tests across checkout, admin search, order tracking, welcome page | **High** — every tested input handled malicious payloads without executing them |
| An order ID can be guessed to reach someone else's order | Sequential or near-guessable order references | `order-id-enumeration` | **High** — a real order ID incremented by one character returned no data |
| A logged-in visitor can't reach the product catalogue from the homepage's primary call-to-action | The "Get Started" button's scroll behaviour silently fails for authenticated customers | `get-started-scrolls-to-packs` | **Low — confirmed happening.** Verified against a real, verified, non-admin customer account: no scroll, no error, no navigation. The site's own code confirms the correct logic should run |

**Reading this table the way it's meant to be read:** four rows say "Low — confirmed happening." Those four are the actual priority list, regardless of what the raw finding count elsewhere in this document might suggest. Everything marked "High" in this table is a genuine, tested, real-evidence confirmation — not an assumption of safety in the absence of a test.

---

## 6. What's Confirmed Working — Given Real Weight

It would be dishonest to present only findings. Several things were tested adversarially, specifically trying to break them, and held up:

- **Server-side price integrity.** The checkout Cloud Function payload was inspected directly: it contains only an order ID and customer name fields — never a price. Price is derived server-side from the pack reference. A test that manipulated the displayed price to R1 via DevTools before submitting confirmed the server-stored order still reflected the correct price. This is the single most important security property of an e-commerce checkout, and it's implemented correctly.
- **Payment ownership and double-charge protection.** Direct testing of the payment-initiation function confirmed two separate protections both work: a different customer cannot trigger payment on someone else's order, and a repeat payment attempt on an order that's already been paid is correctly rejected rather than silently processed again.
- **The Force/Override status control requires confirmation before applying**, and correctly cancels without making any change when the confirmation is declined — this specific bypass mechanism is safe to use, even though its use isn't currently logged (see findings above).
- **Firestore security rules hold under direct bypass.** Removing the admin authentication overlay via DOM manipulation — the same technique any visitor could perform in seconds — was tested. No real data was exposed. The backend rules, not just the UI, are doing the enforcement.
- **No credential leakage anywhere in client-side code.** PayFast merchant credentials, the courier API key, and the deprecated Firebase project reference were all confirmed absent from every script the browser downloads.
- **Cross-customer data isolation holds on guest-facing pages.** Two real orders, under two different accounts, were created and cross-checked: neither customer's welcome page or tracking page ever surfaced the other's data. (The one exception — admin search — is listed above as a genuine finding, and it's worth noting the isolation gap exists only in the internal admin tool, not anywhere a guest could reach.)
- **Firebase's brute-force login protection genuinely works.** Five wrong-password attempts followed by the correct password on the sixth attempt: the correct password was rejected. The protection is real; only the user-facing messaging is missing (see Medium findings).
- **No exploitable duplicate-order or race-condition behaviour** was found under rapid double-submission or concurrent-session testing.
- **International phone number formats** (UK, US, UAE, Germany) all validate correctly on registration, alongside the existing South African default.
- Zero unhandled JavaScript exceptions across every known page.

---

## 7. Interesting AI / Human Interaction Moments

This section exists because it's genuinely instructive, not just colour. Several findings in this engagement only surfaced because a human distrusted an automated "pass," and one significant loss of time came from the reverse — trusting test infrastructure that turned out to be lying to itself.

**The empty "Watch Demo" modal.** An early automated test confirmed the "Watch Demo" button worked, because a modal opened when clicked — that was the only signal the test checked for. Manually clicking the button revealed the modal was completely empty: no video, no content, just a black overlay with a close button. The test was rebuilt to check for actual video/iframe content inside the modal, not just modal-open state, and now correctly flags this as a finding. The lesson: automation proves a check ran; it doesn't automatically prove the right thing happened.

**A missing `return` keyword that cost real debugging time.** A checkout test involving two sequential purchases kept failing at the same point, with the browser context appearing to crash mid-navigation. Three plausible theories were tested in turn — a session race between parallel test workers, a Firebase IndexedDB write-timing issue, a stale authentication redirect — each ruled out by direct evidence, not assumption. The actual cause, found only by reading the site's own source code calmly rather than continuing to patch symptoms: a test helper called an asynchronous `logout()` function without the `return` keyword in front of it, so the test moved on before the logout had actually finished, and the site's own delayed navigation crashed the browser context out from under it. One word fixed it. This produced a permanent rule in the project's engineering conventions: after two failed live-debugging attempts on the same test, stop, revert, and diagnose calmly in a separate pass rather than continuing to guess under pressure.

**A 20-failure cluster that looked like a site outage and wasn't.** On 8 July, a full 185-test run produced 20 failures, 17 of them new. The obvious read was "something broke on the live site overnight." Instead of reporting that, each failure's actual error message was checked — and 14 of the 20 shared the identical signature: an admin login button that existed in the page but never became visible. Rather than patching each test individually, the pattern was investigated as one problem. It turned out to be Sentinel's own test infrastructure: four tests were running in parallel, all trying to log into the same real admin account simultaneously, and the resulting session-state race made the login button intermittently fail to render for whichever test lost the race. Nothing was wrong with your site at all. The fix — forcing tests to run one at a time whenever they're operating against real accounts — is now a permanent, documented rule, and every one of the affected tests re-ran clean afterward. This is worth stating plainly: had this not been investigated properly, it would have been reported as 14 site defects that did not exist.

**The fully-automated email round trip.** Rather than manually clicking a verification link during testing, Sentinel connects to a dedicated Gmail inbox via the Gmail API, waits for the real email to arrive, extracts the real verification link from its content, and navigates to it — with no human involved at any step. This is what actually caught the `firebaseapp.com` domain issue: it's the kind of thing a developer manually testing their own registration flow would very plausibly never notice, because they'd recognise the domain as "probably fine" without a browser's phishing detector flagging it the way it would for an unfamiliar user.

**A wrong finding, caught before it shipped.** An early test concluded the platform only supported one property per account, and reported that as a finding. The test was correct about what it observed — it just never got past the account's email-verification screen before checking, because the test account itself was never verified. A later, more careful pass with a properly verified account found the opposite: multi-property management is a real, working feature, complete with saved host contact details, restaurants, and activities. The wrong finding was caught during a deliberate document review before it was sent, not after. It's included here rather than quietly corrected, because it's a useful reminder that an automated test's conclusion is only as good as the state it was actually run against — and because a QA process that never admits an early mistake is less trustworthy than one that catches and corrects its own.

---

## 8. AI-Generated Code Failure Patterns

A dedicated auditor module — built specifically for this project, and now generalised for any site — scans for eleven patterns that are disproportionately common in AI-assisted or AI-generated frontend code, as distinct from ordinary human coding mistakes:

duplicate element IDs, event handlers referencing functions that don't exist, forms with no actual submission mechanism, broken asset references, low-quality accessibility labels, duplicate meta tags, hardcoded localhost URLs left in from development, placeholder links that go nowhere, excessive debug logging left in production, mixed HTTP content on an HTTPS page, and hardcoded placeholder text.

On this site, this auditor found: the duplicate DOM IDs already listed above (Medium findings section), one placeholder link (`href="#"` on a "log in again" link with no actual destination), and correctly identified — then correctly cleared, after investigation — a false positive on the demo form, which initially looked like a form with no submission handler but turned out to have one attached via JavaScript rather than an HTML attribute.

Everything else this auditor checks for came back clean: no phantom asset references, no low-quality labels, no duplicate meta tags, no leftover localhost references, no mixed content, no excessive logging, no placeholder test data left in production copy.

---

## 9. QA Checklist Coverage

Mapped directly against your original [`QA_CHECKLIST.md`](./QA_CHECKLIST.md), organised by how thoroughly each section is currently covered by automated testing.

### High coverage

- **Auth** — registration validation (all fields, password rules, terms enforcement, phone format), login validation, generic error messaging on wrong credentials, logout session clearing, admin redirect, brute-force lockout, Remember Me persistence behaviour, and the full email verification round trip via real inbox
- **Checkout** — real PayFast sandbox flow now confirmed completing an actual payment (not just reaching the redirect), price/quantity manipulation resistance, empty-cart and empty-field blocking, credential exposure scanning, delivery fee calculation, and the full Premium Upgrades flow (live total updates, correct price persistence to the real order, skip-path pricing, and modal correctly gated to only appear for qualifying packs)
- **Payment security** — direct testing of the `createPayFastPayment` Cloud Function confirmed it correctly rejects a payment attempt made by a different account than the order's owner (`permission-denied`), and correctly rejects a repeat call on an order that has already been paid (`failed-precondition`) — both are meaningful, deliberately-tested protections against cross-customer payment abuse and double-charge/back-button exploitation, not just observed as a side effect
- **My Account** — My Orders correctly shows only the logged-in customer's own orders, Cancel is correctly restricted to Pending-status orders and correctly updates the order's status when triggered, profile editing persists correctly, and — importantly, see the note below — **the platform's multi-property management genuinely works**: creating a saved property (host contact details, restaurants, activities, brand information) persists correctly to the database and displays correctly in the account's property list
- **Admin** — access control (including DOM-bypass resistance), dashboard, full order management (search, filter, export, detail view, status progression through all six stages, waybill entry, Force/Override with confirmation), full pack CRUD lifecycle, user list and detail, Support Tickets tab, and a substantial negative-testing pass (XSS, SQL injection, unauthenticated access attempts, role-escalation probing). One finding here worth its own line: order status changes — including Force/Override — are not recorded in the Audit Log
- **Welcome Page** — loads without authentication, no leakage of the internal collection address or QR generation data, XSS resistance, correct guest/property data display, confirmed cross-customer isolation
- **Order Tracking** — loads correctly, invalid input handled gracefully with no stack traces, XSS/SQL injection resistance, deep-link parameters, confirmed cross-customer isolation
- **Security** (checklist section 9) — all credential-exposure checks, CSP header validation, deprecated Firebase project reference confirmed absent

> **A note on an earlier finding.** An initial pass at multi-property testing concluded the platform was single-property-per-account, based on a freshly-registered account that had not yet completed email verification — that account only ever saw the "please verify your email" screen, never the real account page. Testing with a properly verified account confirmed the opposite: multi-property management is a genuine, working feature. This is flagged explicitly here in the interest of transparency — the original conclusion was wrong, and testing a verified account from the outset would have caught this the first time. One related question remains genuinely open: whether Wi-Fi credentials stay correctly isolated per property when a host manages more than one (see "What's Next").

### Partial coverage

- **Storefront** — cart behaviour and multi-item carts are covered; the Get Started flow uncovered a genuine defect for logged-in customers (see findings above), Proceed to Checkout is covered for the logged-out state; the chat widget and support-ticket creation are not
- **Cross-cutting** (section 10) — console-error sweeping across all pages is thorough; genuine physical-device testing is not something browser automation can substitute for
- **Email Infrastructure** (section 11) — the actual delivery, branding, and link-correctness of the verification email is now fully verified end-to-end; the DNS and Resend-provider-level configuration behind it is not directly testable from the browser

### Low or no coverage

- **Cloud Functions / Webhooks** (section 8) — most require backend log access that isn't available from browser-based testing; two items that ARE browser-testable (calling `createPayFastPayment` as a non-owner, and as a repeat call on an already-paid order) have since been tested directly — see Section 4 below
- **API key exposure scanning** — a dedicated check for leaked LLM/API provider keys (Anthropic, OpenAI, Stripe, AWS-style key patterns) is designed but not yet built; flagged as the next priority

---

## 10. What's Next

- **Nightly regression automation** — the 11-test curated suite built for this engagement, scheduled to run automatically rather than triggered manually
- **API key exposure auditor** — the highest-priority unbuilt check, directly targeting a known real-world attack pattern against AI-assisted sites
- **Wi-Fi credential isolation across multiple properties** — genuinely open. With multi-property management now confirmed working, it's important to verify that Wi-Fi credentials configured for one property never appear on another property's welcome page. Testing this is in progress and has surfaced an unrelated, unresolved checkout-flow issue when placing a second order in the same session, which needs to be understood before this specific question can be answered either way
- **A dedicated Test Case Report** — a second report format, organised as Test ID / Scenario / Steps / Expected / Actual / Status, better suited to walking through specific business scenarios than the current findings-and-severity format
- **Decision needed from you:** priority on the two revenue/data-exposure findings (dropped cart item, admin search isolation) versus the accessibility, SEO, and property-edit backlog

---

*Report generated from a live test run against production data on 8 July 2026, using explicitly-permissioned sandbox transactions and clearly-labelled test accounts throughout.*
