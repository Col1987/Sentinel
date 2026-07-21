# Sentinel Engineering Log

This log documents the reasoning, debugging, and decisions behind Sentinel's development — the "why" and "how," not just the "what." The README stays lean reference documentation; this log carries the narrative, root cause analyses, and the lessons that shaped the project's conventions.

Entries are in chronological order.

---

## Project genesis — CLAUDE.md-driven workflow and initial scaffold

### Context

The project began from a real frustration: using Claude Code in VS Code felt disconnected compared to working with Claude in a conversational chat interface, where context builds naturally over the course of a discussion. The gap wasn't Claude Code's capability — it was that Claude Code is instruction-driven, not conversation-driven, and without the right upfront context it produces generic scaffolding rather than something tailored to the actual project.

### Decision: build the CLAUDE.md first, before any code

Rather than jumping straight into scaffolding, the first deliverable was a `CLAUDE.md` file — a project brief covering purpose, tech stack, conventions, folder structure, and hard rules, written to be read automatically by Claude Code at the start of every session. The target site for the first real testing engagement — juelhaus.co.za, a hospitality tech platform for Airbnb/rental hosts, with explicit owner permission — was researched first so the brief reflected the actual product, not a generic template.

### What shipped

A single, well-scoped Claude Code prompt ("Read the CLAUDE.md, then scaffold the project structure with package.json, tsconfig, playwright config, and a basic broken-link auditor as the first module") produced a complete, working scaffold in one pass: `package.json`, `tsconfig.json` (correctly including the DOM lib, needed for `page.evaluate()` callbacks), `playwright.config.ts` with four projects (smoke, functional, regression, audit), `.eslintrc.json`, `.gitignore`, a GitHub Actions workflow, and a working broken-link auditor with its first passing smoke test — all against the real juelhaus.co.za site, immediately.

### Lesson

The CLAUDE.md file is what closed the gap between chat-based and Claude Code-based work. A well-written project brief, read automatically at the start of every session, turns Claude Code from "generic scaffolding tool" into something that behaves like it already has the context a long chat conversation would have built up. This became the foundational convention for everything that followed — every subsequent session started from CLAUDE.md, and every hard-won lesson eventually got written back into it.

---

## The broken-link false-positive — auditors need to render pages, not just request them

### Context

Early in the safe-mode testing buildout, the broken-link auditor began flagging `/account.html` as broken — a "should have no broken links" test started failing where it had passed before.

### Investigation

Manually navigating to `/account.html` in a real browser showed the page loading correctly, with an inline "please log in to view your account" message. The page was not actually broken.

### Root cause

The broken-link auditor was making raw HTTP requests (HEAD/GET) to check each link's status, rather than navigating with a full browser. `/account.html` relies on client-side JavaScript to render its content — a raw HTTP request receives a response, but that response doesn't reflect what a real browser (and a real visitor) would see, because the JavaScript that renders the actual page content never runs.

### Fix

The auditor was rebuilt with a two-tier approach: try a fast HTTP HEAD request first, and only if that fails, fall back to a full `page.goto()` browser navigation before concluding a link is genuinely broken. This preserves speed for the common case (most links are static and a HEAD request is sufficient) while eliminating false positives on JavaScript-rendered pages.

### Lesson

This became an important early lesson in trusting the suite's own output. Reporting an incorrect finding to a client — even once — is exactly the kind of thing that erodes confidence in an entire automation effort. The fix here also became the template for a recurring category of bug encountered throughout the project: any check that inspects a page without actually rendering it risks missing what real users experience.

---

## The reliability audit — eliminating flaky waits across the whole suite

### Context

As the auditor and journey-test suite grew, a dedicated pass was run specifically to find and eliminate sources of flakiness before they could cause silent failures in CI — race conditions, hardcoded `waitForTimeout()` calls standing in for real conditions, and inconsistent state between test runs.

### What was found and fixed

Every `waitForTimeout()` in the suite was audited and replaced with a deterministic wait — waiting for the actual DOM condition (an element becoming visible, a specific class disappearing, a network request completing) rather than guessing how long an operation would take. This eliminated an entire class of "works locally, flakes in CI" bugs before they had a chance to surface, since CI runners are typically slower and more variable than a local development machine.

### Lesson

This pass established what became one of the project's most consistently-referenced conventions: fixed-duration waits are never acceptable as a substitute for waiting on a real condition. Every later debugging session that involved a "mystery hang" — and there were several — eventually traced back to some variant of this same anti-pattern being reintroduced, which is why it kept getting re-documented and reinforced in CLAUDE.md over the life of the project.

---

## Phase 1 completion — comprehensive safe-mode coverage

### Context

Phase 1's goal was full safe-mode testing coverage: every category of check that could be built and verified without touching juelhaus.co.za's real backend — no real accounts, no real orders, no data written anywhere.

### What shipped

By the end of Phase 1, the suite covered five auditor modules (broken links, accessibility via axe-core, SEO, site discovery, and a code-quality auditor purpose-built to catch AI-generated code failure patterns), a unified branded HTML reporter, and 147 tests across five Playwright projects — smoke, functional, security, audit, and admin. Every outbound request in every test was intercepted before it left the browser, so the entire suite could run safely, repeatedly, with zero risk to production data.

Coverage was deliberately checked against the site owner's own `QA_CHECKLIST.md` document, with an honest gap analysis distinguishing what could genuinely be tested in safe mode from what would require real backend access — rather than claiming broader coverage than was actually achieved.

### Lesson

Phase 1 established the pattern that shaped everything after it: build broad, safe coverage first, and be explicit about what safe mode cannot prove. This is also where the project's core "mode-agnostic" design principle first took shape, though it wasn't formalised as a named convention until Phase 2 — even at this stage, tests were being written to observe what the client sent, in preparation for later verifying what the server actually did.

---

## Going live — flipping the switch, and the first real bug

### Context

Phase 2 began with the deliberate decision to run the existing safe-mode suite against real backends, with the site owner's explicit permission, using a `SENTINEL_LIVE_MODE` environment flag to control whether outbound requests were intercepted or allowed through.

### The first bug: LIVE_MODE silently doing nothing

The very first live-mode run produced a report clearly labelled "SAFE" despite `SENTINEL_LIVE_MODE=true` being set in `.env`. Root cause: `LIVE_MODE` was exported from `src/config/sites.ts` at module import time, but `dotenv`'s `.config()` call — which loads the `.env` file into `process.env` — hadn't run yet by the time that export was evaluated, due to how `playwright.config.ts` ordered its imports. The flag was permanently `false` regardless of the actual `.env` setting.

### Fix

`dotenv`'s `config()` call was moved directly into `src/config/sites.ts`, immediately before the `LIVE_MODE` export, guaranteeing the environment variable is loaded before it's read — regardless of import order elsewhere in the project. Node's module caching makes calling `config()` from multiple files harmless.

### The first real live-mode finding

Once live mode was genuinely working, the very first meaningful test — a real registration — immediately surfaced a genuine defect: registering an account produced no verification email at all, and the site's own "Resend verification email" button called a JavaScript function that didn't exist on the page. The entire email verification flow was broken for new users, and safe mode could never have found this, since it depends entirely on a real email actually arriving in a real inbox.

### Lesson

This was the moment the value of live-mode testing became concrete rather than theoretical — the very first real end-to-end test found a defect that would have blocked every new user from activating their account. It also reinforced why the mode-agnostic design mattered: the same test structure that worked in safe mode, once genuinely allowed through to the real backend, immediately proved its worth.

---

## Building the Gmail integration — full email round-trip automation

### Context

The broken email verification flow could only be partially diagnosed without actually reading the email a real user would receive. Manually checking an inbox during every test run wasn't sustainable, and it also meant a human was still in the loop for what should be an automated end-to-end check.

### What was built

`src/utils/gmail.ts` connects to a dedicated Gmail inbox (`sentinelqa2026@gmail.com`) via the Gmail API, using OAuth2 with a read-only scope. Gmail's `+` addressing (`sentinelqa2026+<tag>@gmail.com`) allows every test to use a unique, filterable email address while all mail still lands in one inbox Sentinel can poll. After a test registers an account, Sentinel polls the inbox for the real email, extracts the real verification (or order-confirmation) link from its content, and navigates to it — with no human clicking anything.

Setting this up required walking through Google Cloud Console's OAuth consent screen and client credential setup, then the OAuth Playground flow to generate a refresh token authorised specifically against the test Gmail account.

### The finding this immediately produced

The very first fully-automated email round-trip caught something a human manually testing the same flow would very plausibly never notice: the verification link redirected to `juelhaus-co-za.firebaseapp.com` — Firebase's raw hosting domain — rather than the site's actual custom domain. Chrome's own phishing heuristics flagged this as a suspicious lookalike site during account activation. A developer testing their own registration flow would likely recognise the domain as "probably fine" and click through without a second thought; an unfamiliar visitor, and their browser's own security warnings, would not extend the same benefit of the doubt.

### Lesson

Full automation of a flow a human would normally do manually doesn't just save time — it removes the human's tendency to unconsciously excuse things they already understand the context for. This became a recurring theme through the rest of the project: several of the most valuable findings came specifically from automating something that "obviously worked" when done manually.

---

## The code-quality auditor — testing for AI-generated code failure patterns

### Context

As AI-assisted and AI-generated frontend code became increasingly common, a hypothesis emerged: certain categories of defect are disproportionately likely to appear in AI-generated code specifically, distinct from ordinary human coding mistakes — patterns that traditional scanning tools (built before this shift) don't specifically target.

### What was built

A dedicated auditor module, built in stages and eventually covering eleven checks: duplicate element IDs, event handlers referencing undefined functions, forms with no working submission mechanism, broken asset references, low-quality accessibility labels, duplicate meta tags, hardcoded localhost URLs, placeholder links that go nowhere, excessive debug logging left in production, mixed HTTP content on an HTTPS page, and hardcoded placeholder text (Lorem ipsum, test emails, TODO comments).

### A false positive, caught and corrected

The "dead form" check initially flagged the demo booking form as having no submission mechanism, since it had no `action` attribute and no `onsubmit` handler in its HTML. Investigation showed the form actually submits correctly via a JavaScript `addEventListener` — a check based purely on HTML attributes couldn't see this. The check was corrected to also look for the presence of a submit button inside the form as a signal that JavaScript-based submission handling likely exists, downgrading this specific pattern to an informational note rather than a hard finding, while keeping the hard finding for forms with genuinely no interactive elements at all.

### A real finding: the resend-verification button, more precisely diagnosed

The same auditor flagged the "resend verification email" handler as referencing an undefined function. Later, direct live-mode testing clarified the fuller picture: the function exists and works correctly on the homepage, but is genuinely missing on the account page specifically — the same button, in two different page contexts, with inconsistent JavaScript wiring. The Cloud Function it calls also independently returns an HTTP 500 error. Three related but distinct defects in the same feature, only fully separated through a combination of static auditing and live-mode behavioural testing.

### Lesson

Static auditing (does this pattern exist in the code) and dynamic testing (does this actually work when exercised) are complementary, not redundant — each caught something the other missed, and the false-positive correction here established the discipline of verifying an auditor's own findings before treating them as ground truth, a discipline that recurred throughout the rest of the project whenever a new automated check was built.

---

## July 7 — LIVE_MODE deep testing, abuse dimensions, and the debugging circuit breaker

### Context

Coming off a strong Phase 2 core (checkout, order lifecycle, welcome page, admin CRUD, session/lockout all confirmed working end-to-end against the real backend), the scope expanded deliberately. Rather than treating Phase 2 as "done," the question was asked: does the platform actually hold up across realistic customer variation and adversarial use, not just the golden path we'd already proven?

This produced four new testing dimensions:
- **Dimension 1** — customer/property variation (multiple properties, international phone formats)
- **Dimension 2** — cart/product combinations (multiple packs, every pack offering, per-item Wi-Fi config)
- **Dimension 3** — abuse/"beating the system" (price manipulation, duplicate orders, session conflicts, order ID enumeration)
- **Dimension 4** — data/customer boundary correctness (cross-customer leakage)

Dimension 3 was prioritized first, on the reasoning that financial and reputational risk outweighed feature-completeness risk.

### Decision: mode-agnostic test design

Early in the session, a question was raised that reshaped how every subsequent test got written: should tests be built exclusively for LIVE_MODE, or should every test work in both safe mode and LIVE_MODE by default?

The answer settled on: **every test should be mode-agnostic by default.** In safe mode, a test intercepts the outgoing request and asserts on what the *client* sends. In LIVE_MODE, it additionally asserts on what the *server* actually did (response, database state, admin visibility). `test.skip(!LIVE_MODE)` became the exception, reserved only for tests that are structurally impossible to verify without a real backend — like idempotency/race-condition checks that require two real concurrent requests.

This was added as a formal convention in CLAUDE.md and immediately proved its value: the price-manipulation test caught the same finding in both modes (no client-supplied price in the payload), with LIVE_MODE adding the deeper confirmation that the server-stored price matched the correct amount.

### Dimension 3 results — a clean bill of health on the highest-risk category

Every abuse test came back clean:
- **Price/quantity manipulation**: the Cloud Function payload contains only `orderId`, `origin`, `firstName`, `lastName` — no price or quantity. Price is derived server-side from the pack reference. Confirmed via intercepted payload inspection (both modes) and via checking the actual admin order record after submitting a manipulated client-side price of R1 (LIVE_MODE only) — the real price (R1,360) was what got stored.
- **Duplicate order idempotency**: tested, no double-order creation.
- **Concurrent sessions**: two browser contexts on the same account showed fully independent cart state — no data loss, no overwrite.
- **Order ID enumeration**: a real, valid order ID incremented by one character correctly returned "not found" with zero data leakage across all checked responses.

This is a genuinely strong result. The highest-stakes category — the one that could cost real money or real trust — held up under direct adversarial testing.

### Dimension 1 results — architecture clarified, not broken

Testing multi-property support revealed the platform appeared to be single-property-per-account by design — there was no "Add Property" mechanism visible on the account page tested. This wasn't flagged as a bug at the time; it reshaped how Dimension 2 was scoped (cart combinations for one property, not cross-property scenarios). This conclusion was later found to be incorrect — see the July 13 entry below.

### The `all-packs-full-pipeline` incident: sequential vs. parallel vs. smarter

Building Dimension 2's "test every pack offered" requirement led directly into the session's biggest process failure — and its most valuable lesson.

**What happened:** A test was built to run a full checkout flow sequentially for all 6 packs. Budgets were set generously (10-30 minutes) because "LIVE_MODE tests are naturally slower." The test then appeared to hang. Multiple rounds of live debugging followed — `.catch(() => {})` blocks were found silently swallowing failures, an unguarded `window.viewOrder()` call was found blocking the browser's event loop, a `waitForFunction({ timeout: 0 })` was waiting indefinitely on a Firebase auth state that never resolved as expected. Each diagnosis was individually correct. The cumulative cost of chasing them one at a time, live, under pressure, was a genuinely unacceptable amount of session budget burned across a single afternoon.

**The actual fix wasn't more patching — it was questioning the premise.** Did every pack genuinely need a full, expensive checkout flow repeated 6 times? No. The mechanism (checkout) is identical across packs; only the *data* (name, price) differs. That split into a two-tier design:
- **Tier 1** — fast, cheap, direct data verification for every pack (read `bh_cart` after `addToCart()`, no checkout needed)
- **Tier 2** — the full expensive checkout flow, but only for a representative sample (first and last pack), not all 6

This is now a formal CLAUDE.md convention: **test cost awareness** — before repeating an expensive operation across variations, ask whether cheap direct verification would prove the same thing, and default to the considered answer over the fast/easy one, explicitly, every time.

### The debugging circuit breaker

The same session that produced the test-cost lesson also produced a second, more fundamental one: **repeated live-patching under pressure is itself a failure mode**, independent of whether any individual fix is correct.

A hard rule was added to CLAUDE.md: if a single test requires more than 2 consecutive live-debugging attempts without reaching a clean pass, stop. Revert the file to its last known-good commit. Report clearly why. Do not attempt a third patch in the same session, regardless of how close the fix seems.

This rule got tested in the same session it was written. Rebuilding the two-tier pack test hit exactly 2 failed attempts on `representative-checkout-sample` — a test that consistently crashed at `#reg-terms.click()` during the second pack's checkout. The circuit breaker triggered correctly: work stopped, the failure was reported precisely (page context closing mid-flow), and no third live patch was attempted that session.

### Root cause, found calmly the next attempt: the missing `return`

Rather than a third live patch, the actual site source (`/js/auth.js`) was read directly:

```javascript
window.logout = async function() {
  await signOut(auth);
  window.currentUser = null;
  localStorage.removeItem('bh_loggedIn');
  localStorage.removeItem(ACTIVE_KEY);
  window.location.href = '/';
};
```

The test's `page.evaluate()` call was invoking `window.logout()` — an async function — without `return`ing the promise:

```typescript
// Wrong — promise discarded, evaluate resolves before logout() actually finishes
await page.evaluate(() => {
  if (typeof (window as any).logout === 'function') (window as any).logout();
});
```

Because the promise wasn't returned, Playwright's `evaluate()` resolved immediately while `signOut(auth)` was still running in the browser. The test proceeded into the next step (`registerForCheckout` → `page.goto('/')`) while logout was still mid-flight. Moments later, the real `window.location.href = '/'` fired from the *original* logout call — now completely untracked by Playwright — crashing the page context Playwright was already navigating.

The fix was one word:

```typescript
await page.evaluate(() => {
  if (typeof (window as any).logout === 'function') return (window as any).logout();
});
```

This is a textbook example of why the circuit breaker exists. The bug was invisible from logs and symptom-chasing alone — every earlier theory (session state, redirect loops, Firebase auth timing) was a plausible-sounding but incorrect explanation for the same symptom. It only became obvious once the actual source was read calmly, without the pressure of a live debugging loop demanding an immediate fix.

### What shipped

- Full LIVE_MODE checkout, order lifecycle (all 6 statuses + waybill), welcome page verification, admin pack CRUD lifecycle, login lockout and session persistence — all confirmed against the real backend
- Gmail API integration for fully automated email verification testing (no manual link-clicking required)
- Dimension 3 (abuse testing) — clean across price/quantity manipulation, duplicate orders, concurrent sessions, order ID enumeration
- Dimension 1 (property/phone variation) — clean, with the platform architecture clarified (later corrected — see July 13)
- `all-packs-data-integrity` (Tier 1) — fast, deterministic, covers every pack's data correctness
- Three new CLAUDE.md conventions: mode-agnostic test design, test cost awareness, and the debugging circuit breaker
- Real findings: Firebase Hosting domain leakage in two separate email templates (verification link, order tracking link), the resend-verification Cloud Function returning HTTP 500, a silent login lockout with no user-facing message, and a storefront caching delay on pack edits

---

## July 13 — a wrong finding, caught and corrected: multi-property support does exist

### Context

While building a test to check whether Wi-Fi credentials stay correctly isolated across a host's multiple properties — itself a follow-on from the Dimension 2 Wi-Fi-per-order finding — the test needed an account with more than one saved property. Attempting to build this exposed that the July 7 finding ("platform is single-property-per-account") had never actually been re-verified since it was first observed.

### Investigation

The original test that produced the single-property finding used a freshly-registered account and checked `/account.html` immediately. What it actually observed was the "please verify your email" screen — the account had never completed email verification, so it never saw the real account page at all. The absence of a multi-property UI wasn't evidence the feature didn't exist; it was evidence the test never got far enough to check.

Testing again with a properly verified account found a complete My Properties section: host contact details (behind a collapsed accordion), restaurants, activities, and brand information, with full create/edit/delete functionality. Creating a new property was confirmed working end-to-end, with the resulting record verified directly via a raw Firestore read.

### Correction

The July 7 finding was retracted. This had a cascading effect on other work: the QA checklist coverage table for "My Account" moved from "low or no coverage" (the feature was believed not to exist) to "high coverage, tested and working." A client-facing document draft that had already incorporated the incorrect finding was caught and corrected before it was shared.

### A secondary, genuine finding this surfaced

While verifying the edit path for an existing property (not just creation), a real defect was found: editing a saved property leaves its Save button permanently disabled, because the edit form doesn't repopulate its in-memory restaurant/activity state from the already-saved record — the same "at least one restaurant and one activity" validation that gates creation also gates editing, but nothing pre-fills it on edit. Create works correctly; only Edit is affected.

### Lesson

This is arguably the most important process lesson of the whole engagement: an automated test's conclusion is only as trustworthy as the state it was actually run against, and a "confirmed absent" finding deserves the same scrutiny as a "confirmed present" one before it's reported as fact. The correction is documented here plainly, rather than quietly fixed and forgotten, because a testing process that never admits an early mistake is less trustworthy than one that catches and corrects its own — and this was caught specifically because a later, unrelated task (the Wi-Fi isolation test) needed the feature to exist and forced a second look, not because anyone set out to re-audit the original finding.

Two further, distinct technical issues were found and fixed while chasing this investigation, both folded into CLAUDE.md's known-working-patterns section: a toggle/panel control (`#pf-addr-breakdown-btn`) that doesn't respond reliably for a second form instance in the same session — the same category of bug as an earlier, similar fix in the checkout flow, just in a different location that hadn't received the same fix yet — and confirmation that reading DOM/form state immediately after a navigation or reload risks reading stale data before the page's own asynchronous data-loading has actually resolved, a pattern that recurred at least three separate times across different pages over the course of the project.

The Wi-Fi cross-property isolation question that prompted this whole investigation remains open — a separate, still-unresolved checkout-flow issue (a second order in the same session unexpectedly triggering a "billing summary" state) has blocked the test from ever reaching the actual question it was built to answer.

---

## July 15-20 — the timing investigation, a systemic bug found and eliminated, and closing the QA punch list

### Context

With the four testing dimensions complete and the multi-property retraction resolved, focus shifted to closing out remaining gaps: an API key exposure auditor, a nightly regression suite, a security self-review of Sentinel's own codebase, and a second report format organised around business risk rather than raw pass/fail. This period also produced the session's most valuable single discovery, buried inside what started as a routine performance investigation.

### The Risk Coverage Matrix and its own near-miss

A new report section was built mapping every test back to a specific business risk (can a customer be double-charged, can one customer see another's data) with a confidence rating derived from live results, not a static claim. While validating the logic, the tool caught itself about to mislabel a setup failure as a confirmed security pass — a test had failed early in its own preconditions and logged a `[FINDING][critical]` via the same convention used for genuine observed defects, and the draft logic would have shown that risk as fully covered. A fourth state was added specifically for this ambiguity: "Passed with findings — review," rather than forcing a false verdict either way. The very next real run using the corrected logic caught an actual data exposure issue (the admin search substring-match leak) that a flat pass/fail view would have buried under unrelated findings.

### Security self-review of Sentinel's own codebase

A deliberate, evidence-first audit of the framework itself: zero npm vulnerabilities across the full dependency tree; the HTML reporter's escaping was checked interpolation-by-interpolation and found correct everywhere a target site's content could reach the report, with two small hardening fixes applied regardless (single-quote encoding, escaping two previously-unescaped-but-safe severity fields); and a full credential-handling audit, including a git-history pickaxe search across every commit for the literal values of every credential in use, confirmed none had ever been committed. The one gap that couldn't be verified from code alone — the actual granted scope of the live Gmail OAuth token — was confirmed manually via Google's own account permissions page: read-only, exactly as intended.

### The timing investigation that found a 65-instance bug

A full LIVE_MODE run was taking roughly 85 minutes. Rather than accept that as "the suite is just big now," a diagnostic pass broke down every test's duration and found the real story: two tests alone accounted for nearly half the total runtime, both routinely failing at their own multi-minute timeout ceilings. Investigation showed both were doing exhaustive, expensive checkout runs that a cheaper, already-existing test (checking pack data directly, or checking one representative pack rather than all six) already covered more reliably. Both were retired, cutting total runtime by 45% with no loss of real coverage — the removed tests weren't just slow, they were failing anyway.

That investigation surfaced something bigger. One of the retired tests' replacement, once genuinely exercised, kept timing out on `#cfg-property` — a field used across most of the checkout suite. Tracing it down revealed the real error wasn't a hang at all: `get-started-scrolls-to-packs` had been failing its actual assertion in about 12 seconds, but a separate bug was silently disabling the safety timeout wrapped around it, so the test burned its full 180-second budget before that fast, genuine failure ever surfaced. The cause: `page.waitForFunction(fn, { timeout: N })` silently treats the options object as the function's own argument when `fn` takes no parameters — Playwright's real signature is `waitForFunction(fn, arg, options)`, and a zero-argument function will happily accept anything in the `arg` slot, discarding the intended timeout entirely. TypeScript never flags this, since a no-parameter function accepts any argument shape.

A codebase-wide search found the identical bug at 40 further locations, including inside the shared `loginAsAdmin`/`signOutCurrentUser` helpers relied on throughout the suite. All 65 instances were fixed in staged, verified batches — grouped by directory, with representative already-passing tests re-run after each batch to confirm no behavioural change — rather than one large, unverified sweep.

### The real defect this bug had been hiding

With the timeout bug gone, `get-started-scrolls-to-packs` now failed cleanly in 12 seconds instead of hanging for 180. But the test itself was using an admin session to test a customer-facing button, which is not a scenario any real customer is ever in. Rewritten to use a genuine, Gmail-verified customer account, the test revealed the real defect: for an authenticated customer, clicking "Get Started" does nothing at all. No scroll, no error, no navigation — despite the site's own `handleGetStarted()` source confirming the correct branch (`currentUser` set, `emailVerified` true) should call `scrollIntoView()`. The primary conversion call-to-action on the homepage was a silent no-op for exactly the users it exists to serve, and it had been invisible for as long as the timeout bug made every run of this test look like an infrastructure problem rather than a fast, legitimate failure.

### Two new conventions, and the honest reasoning behind them

Two lessons were written into CLAUDE.md directly from this investigation. First: a test's setup must use the account type that actually matches the real-world scenario being verified, not whichever authenticated helper happens to already exist and be convenient — using `loginAsAdmin()` to test a customer flow is a common, easy mistake that produces a plausible-looking but meaningless result. Second: when a test presents as slow or hanging, that symptom itself must be investigated and resolved before trusting whatever the assertion underneath it reports — an infrastructure problem can mask a real, fast, correctly-failing assertion, exactly as happened here.

### A second, related scalability bug, found via the same discipline

Later the same investigation, two more tests were found running with almost no headroom against their timeout budgets — not yet failing, but close enough to warrant the same "don't assume it's fine because it's still passing" scrutiny that found the Get Started defect. Tracing live timing showed a shared helper, `findOrderByEmail`, performing a full linear scan of the admin orders table, checking every row one at a time until it found a match. Early in any session, with few orders in the table, this was fast enough to go unnoticed. By this point in the project — hundreds of live tests having each created a real order over many sessions — the scan was hitting a wall past roughly the 45th row, with each subsequent row taking the browser's full default action timeout. This was not a one-off slow run; it was a genuine scalability defect that would keep getting worse indefinitely, both from Sentinel's own continued testing and from the site's real, growing order volume.

The fix followed a standard, well-established automation pattern: use the admin page's own search input to filter the table down to the matching record first, rather than pulling the whole table back and filtering client-side — the same principle behind "search, don't scan" in any system where a data set can grow unbounded. Applying the fix and re-deriving each affected test's timeout budget from honest, current trace data (rather than the original estimates, which had drifted significantly out of date) restored both tests to comfortable, reliable margins. Investigating the same pattern elsewhere in the codebase found six further files sharing the identical defect, two of which were fixed immediately given their shared/high-exposure status; the remainder were catalogued precisely — including one genuine correctness risk distinct from the performance risk, and two locations using a filter term the site's search doesn't actually support — as scoped future work rather than rushed through in the same session.

### An accidental false positive, caught by the fix itself proving too much

Applying the same settle-and-filter fix to a cross-customer data isolation test produced an unexpected, genuine-looking `[FINDING][high]` — searching for either of two test customers surfaced both. Investigation showed this wasn't a real leak: both test accounts had been created using a shared default account name, a detail of the test's own setup that the previous, broken version of the search had never actually exercised closely enough to expose. The fix wasn't to weaken the assertion — it was to give the two test customers genuinely distinct account names, at which point the isolation check ran cleanly and confirmed real, correct separation. This is a clean illustration of a fix correctly surfacing a problem with the test itself, rather than the fix being wrong.

### An independent external evaluation, and how it was triaged

A separate AI tool was asked to evaluate Sentinel's README and CLAUDE.md independently, without context from this project's own history. It returned a genuinely fair assessment: real, well-evidenced praise for the reliability conventions and adversarial security testing, alongside real, fair criticism — most notably that the README's claim to work against "any website" sits in tension with how much of the current known-working-patterns library is Firebase-specific, and that the framework's real operating costs (API usage, Cloud Function invocations, CI compute) were nowhere documented.

The proposed fixes that came with this evaluation were, almost without exception, full architectural rewrites — a plugin system with dependency injection, JSON-first reporting, isolated per-run account provisioning, compile-time-enforced timeout wrappers — sized for an open-source framework serving many unknown future users, not a solo, single-client engagement. Rather than accept or reject the evaluation wholesale, each point was triaged individually: two genuinely right-sized fixes were made immediately (an honest scoping note in the README distinguishing what's actually generic today from what's JuelHaus-specific, and a lean operations-cost document), while the larger architectural ideas were recorded precisely as Phase 3 considerations — valid, but premature until there is an actual second site to build for. One idea, a compile-time-enforced wrapper that would make the entire waitForFunction argument-order bug class structurally impossible to reintroduce, was flagged as worth real consideration even before Phase 3, given how expensive that exact bug class had already proven to be.

### A first project skill

Late in this stretch, the diagnostic-first investigation discipline that found both the Get Started defect and the orders-table scalability bug — get the full error before proposing anything, check known bug patterns before assuming something new, fix infrastructure and re-observe before trusting the result underneath it, stop after two failed live-patch attempts — was packaged as a Claude Code project skill (`.claude/skills/investigate-hang/`), rather than left as prose in CLAUDE.md that has to be manually re-applied by memory each time a test misbehaves. This was framed as the first instance of a standing rule: when a genuinely repeatable procedure emerges from a session, package it as a skill rather than letting it live only as a convention to be remembered.

### Lesson

Nearly every substantial finding in this stretch of work came from refusing to accept "still passing" or "eventually resolves" as good enough — the two retired tests were failing anyway, the timeout bug was hiding a genuine defect behind 168 seconds of nothing, and the orders-table scan was a slow-motion failure that hadn't fully arrived yet only because it hadn't been looked at closely enough. The throughline across all of it, restated here because it kept proving true: a green result and a correct result are not the same claim, and the value of a testing framework lies specifically in refusing to conflate them.

---

## July 20 — The #cfg-property CI mystery, and the auth-verification race it was hiding

### Context

Three consecutive nightly regression runs, on three separate nights, failed identically: `#cfg-property` — the first field of the checkout config step — never became fillable, 5/5 retry attempts exhausted, across all 3 of CI's own automatic test-level retries. The failure hit two different tests (`representative-checkout-completes` and `order-status-progression-and-email-trigger`), both of which reach this element through the same shared helper, `runCheckoutFlow`. The same test, run locally against the same live backend, passed reliably every time it was checked. On the surface this had every hallmark of an environmental, CI-only problem.

### Investigation: two genuine attempts, both cleanly falsified

The first theory: a missing readiness guard. Five other call sites in the codebase that also chain `registerForCheckout()` into `window.addToCart()` already guard against a documented race (`registerForCheckout` uses `waitUntil:'domcontentloaded'`, so `addToCart` may not be in scope yet) with a `waitForFunction` check — one shared helper, `addPackAndGoToCheckout`, was the one place missing it. Applying the exact same proven pattern was a reasonable, well-evidenced first move, not a guess. It was verified to have actually shipped into the failing run — the run's `head_sha` was checked against the fix commit directly, ruling out a stale checkout — and it had no effect. Both tests failed identically again, on the same element, at the same 100% rate.

The second theory: a headless-vs-headed difference between local runs and CI. A full codebase search for `headless`, `launchOptions`, `chromium.launch`, and `--headed` returned zero matches anywhere in the repository — `playwright.config.ts` applies the same `devices['Desktop Chrome']` preset to every project with no environment-conditional override, and Playwright's own default (headless) applies identically to both local and CI runs. This was also verified rather than assumed: the exact failing test had already been run locally, headless, and passed. The theory was ruled out cleanly, not left as a maybe.

With both theories falsified and the circuit breaker's two-attempt limit reached, the next move mattered: rather than guess a third time, or settle for "environmental, can't reproduce locally" as the conclusion, `trace: 'retain-on-failure'` was enabled in `playwright.config.ts` and `nightly-regression.yml` was updated to upload `test-results/**/trace.zip` as its own artifact on failure — observability only, no attempt yet to touch `#cfg-property` itself. The point was to get one real look at the page before drawing any conclusion, rather than continuing to reason from log text and GitHub's generic `"Process completed with exit code 1"` annotation.

### Root cause

The next local run reproduced the failure directly, trace and all — and the trace's page snapshot showed the answer immediately: at the moment `#cfg-property` timed out, the page was not showing the checkout config form at all. It was showing a "Verify Your Email" gate. The field wasn't slow, or absent for some obscure rendering reason — it structurally could not exist, because `checkout.html` had decided this session was unverified and never rendered the config step in the first place.

Reading `checkout.js` directly (fetched from the live site) confirmed why, and confirmed this is a genuine site defect, not a test artifact. Its `DOMContentLoaded` handler sets up a Firebase `onAuthStateChanged` listener — the correct, race-free way to know when auth state has actually resolved — and then never uses it: the callback body is empty, and it's unsubscribed without ever having consumed an event. The real check instead polls `auth.currentUser` synchronously every 100ms, exiting on `user !== undefined || waited >= 3000`. Firebase's `auth.currentUser` is typed `User | null` — it is essentially never literally `undefined` — so that exit condition is satisfied on the very first 100ms tick almost every time, regardless of whether Firebase's real auth-state hydration has actually finished. Whatever `auth.currentUser` happens to hold at that instant decides the outcome: a hydrated-but-unverified user shows the gate; a not-yet-hydrated `null` falls straight through to rendering the config form as if no one were even logged in.

This is a real, previously unknown, race condition in the site's own code — not Sentinel's. An actual customer who reaches checkout very quickly after registering, before their session's auth state has hydrated, is subject to the identical coin flip: the intended email-verification gate can be silently bypassed depending on page-load timing that has nothing to do with whether their email is actually verified. It also explains an earlier note in `my-account-live.spec.ts` that "checkout.html... does not block unverified accounts" — that finding wasn't wrong, it was one side of a race that hadn't been recognised as a race yet, observed under whatever timing happened to apply a week earlier.

The strongest piece of evidence that this is genuinely a race, and not a fixed rule that just happened to look inconsistent, came from a single local run: `representative-checkout-completes` and `order-status-progression-and-email-trigger` both register a fresh, identically-unverified account through the same helper, moments apart, in the same test process. In that run, one hit the gate and the other didn't — same setup, same code, same machine, different outcome. That split is inconsistent with any theory involving a fixed rule, environment difference, or network condition; it's only consistent with a genuine timing race resolved independently on each page load.

### The fix

Two distinct things needed fixing, and only one of them was Sentinel's to fix. The site-side race in `checkout.js` is the site owner's code and is out of scope here — reported as its own finding, not touched.

On Sentinel's side, the test suite's own helper had a related but distinct gap: `runCheckoutFlow` used a plain, unverified `registerForCheckout()`, when a genuinely verified account sidesteps the race entirely (`!user.emailVerified` can never be true once verification is real, regardless of hydration timing). `registerVerifiedAccount` already existed for exactly this reason elsewhere in the suite (`my-account-live.spec.ts`, `get-started-scrolls-to-packs`) — this was a case of an already-proven pattern not having been applied everywhere it was needed. A new `runVerifiedCheckoutFlow` was added (avoiding a circular import between `checkout-helpers.ts` and `account-helpers.ts` by implementing the verification poll directly), and the two affected regression tests were switched to it, scoped narrowly rather than changed everywhere `runCheckoutFlow` is used.

The first attempt at this fix surfaced a second, distinct, already-documented race in the process: after the verification-link round trip, `addToCart` was being called on a fresh navigation with no natural delay for the async pack catalog to load — the exact scenario `my-account-live.spec.ts`'s `checkoutAsVerifiedCustomer` already had a comment for ("observed twice as a real race during discovery, not a one-off flake"), just not yet applied to this new helper. Adding the same proven `waitForFunction` guard (checking `window.PRODUCTS` is populated, not just that `addToCart` exists) resolved it. Confirmed with 10 consecutive clean local runs (5× each affected test) — zero occurrences of the original timeout, the verification-gate race, or the catalog-load race across any of them.

### Lesson

The decision to stop investigating and call something an environmental limitation has to be earned with evidence, not reached by default when patience or attempts run out. It would have been easy, and defensible-sounding, to stop right after the two falsified theories: two clean rule-outs, a circuit breaker at its limit, a failure that only reproduces in CI — that combination reads exactly like "confirmed environmental" if that's the conclusion being reached for. The only reason it didn't end there is that the evidence gathered specifically to justify stopping — the trace — was actually opened and looked at first, and it said something different than expected. The instinct to get real evidence before concluding "this is just how it is" is what caught a genuine, previously-invisible site defect that two rounds of reasonable, well-executed investigation had both missed by looking one layer too deep.

---

## July 21 — Clearing the remaining six admin-lookup call sites, and two that went further than a mechanical fix

### Context

Earlier work on `findAndOpenOrderInAdmin` and `searchAndCheckIsolation` had already identified and fixed the same underlying pattern once: an admin orders table that loads real data asynchronously, filtered or scanned before that data settles, producing either a silent no-op (filter applied to placeholder data) or a full-timeout scan (rows raced against the table's own in-progress render). That earlier investigation catalogued six further call sites sharing the identical pattern, deliberately left unfixed at the time so each could be treated as a real investigation rather than a mechanical find-and-replace. This entry covers working through all six.

### The mechanical five

Four of the six were exactly the cause already understood: add a settle-wait before filtering, re-apply the filter after any refresh, and — in one case (`checkout-abuse-live.spec.ts`'s shared helper) — correct a comment that said "search by email" when the code, correctly, already searched by name. Each was fixed, verified against a live run, and passed cleanly. One of these live runs (`duplicate-order-idempotency`) happened to exercise its own rare anomaly branch — two Cloud Function calls, only one distinct order ID returned — and correctly confirmed genuine server-side deduplication, rather than a false report from scanning a not-yet-settled table.

### getWelcomeUrlFromAdmin — the settle-wait fix surfaced a real, previously-invisible site defect

Applying the same settle-wait fix here produced a new failure mode: a Playwright trace showed the code waiting forever on `getAttribute('href')` against a locator matching zero elements, because the order detail modal — opened via a direct `viewOrder(id)` call — simply never became visible in the first place. This was not the settle-wait pattern's fault; it was a gap the settle-wait fix incidentally exposed, because previously an unrelated Firestore-connectivity investigation had been chasing the wrong layer entirely (documented in the July 20 entry above).

Confirmed live, twice, independently, in two different files (`data-boundary-live.spec.ts`'s `getWelcomeUrlFromAdmin` and `welcome-page-live.spec.ts`'s local `findAndOpenOrderInAdmin`): opening an admin order directly by ID does not always render the detail modal. The fix in both places was the same — check the modal's own visibility explicitly rather than swallowing a timeout silently, and when it doesn't appear, skip straight to the already-existing search-by-name fallback instead of attempting to read from a modal known to be absent. Once fixed, `welcome-page-live.spec.ts`'s two tests both passed and correctly surfaced two already-known findings (missing pack name, missing Wi-Fi box on the welcome page) that had previously been unreachable behind the crash. This is a genuine, minor admin-tool reliability finding — the underlying order data is always correct and reachable via search, only one specific way of opening it is inconsistent — recorded in the testing summary as such, not as a functional or security defect.

### checkout-property-a-vs-property-b — the settle-wait fix retracted a finding instead of confirming one

The sixth call site looked, on the surface, like the lowest-risk of the six: a `rows[0]` read after a name-filtered search, catalogued as a correctness risk rather than a scan/timeout risk, since it doesn't loop or scan at all. Applying the settle-wait fix alone produced a hard, specific assertion failure: the admin order showed a generic placeholder property name instead of the custom name entered at checkout, exactly the shape of a real finding.

It wasn't one. The admin modal actually opened belonged to a different customer's order from three weeks earlier — `rows[0]`, even against a fully-settled table, is not "the order this test just created," it's simply whatever the table's own sort order happens to put first, and nothing in the code had ever verified that assumption. Worse, the test's own checkout email had never been captured into a variable in the first place, so there was no way to check. The real fix went past the settle-wait: capture the checkout email, filter by name as usual, then scan the settled rows for the one containing that specific email — the same proven pattern already used everywhere else in this cluster of fixes, just not yet applied here. Once corrected, the same live run opened the actual just-created order and showed the custom property name persisting and displaying correctly. The original `[FINDING][high]` never reached a formal report and is recorded in the testing summary as a retracted test artifact, the same way the July 13 multi-property finding was — not deleted, not quietly replaced, stated plainly.

### Lesson

Both of the two deeper cases here were caught by the same discipline the earlier entries in this log keep returning to: apply the mechanical fix, then actually look at what happens next rather than assuming a clean pass or a clean failure both mean what they appear to. A settle-wait fix that produces a *new* kind of failure is not evidence the fix is wrong — it can be evidence the fix removed a layer of noise that was hiding a real, separate problem underneath, as with `getWelcomeUrlFromAdmin`. And a settle-wait fix that produces a clean, specific, high-severity assertion failure is not automatically a confirmed finding either — it can be evidence the test's remaining assumptions were never actually sound, as with `checkout-property-a-vs-property-b`. Six call sites sharing one cataloged pattern turned out to need three different depths of scrutiny, and the depth required was never predictable in advance from how the pattern was originally categorized.
