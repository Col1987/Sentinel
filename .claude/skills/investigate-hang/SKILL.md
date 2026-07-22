---
name: investigate-hang
description: Use when a Sentinel test is unexpectedly slow, times out, or appears to hang, before proposing a fix. Covers checking for known infrastructure bug patterns (waitForFunction argument order, missing .catch() logging, page.evaluate() missing return, wrong-origin storage clears) before trusting or attributing the failure to genuine site behaviour, requires real evidence (trace/log showing the actual mechanism, or reproduction under independent conditions) before concluding a failure is "environmental" as a final answer, and enforces the debugging circuit breaker after 2 failed live-patch attempts.
---

# Investigating a slow, timing-out, or hanging test

A test that looks like it's "hanging" or "slow but eventually resolves" may be masking a
real, fast, correctly-failing assertion underneath an infrastructure problem. Timeouts and
slow resolution are themselves suspicious and must be investigated before the result
underneath — pass or fail — is trusted either way. Do not propose a fix until this sequence
has been followed.

## 1. Get the full error, not just the timeout message

"Test timeout of Nms exceeded" tells you nothing on its own. Get the full stack trace and
identify the last thing that actually happened before the timeout fired — which locator,
which awaited call, which line. If a trace file is available (`--trace=on`), read it rather
than guessing from the summary line. For journey/flow tests, check
`reports/screenshots/{journey-id}-step-{N}.png` first — the journey runner screenshots on
step failure, and the screenshot often shows the actual page state immediately.

## 2. Check known bug patterns before assuming something new

Before treating this as a new problem, check whether it matches a pattern already
documented in CLAUDE.md's "Known-working patterns — check before debugging" section.
Recurring categories that have caused real hangs/timeouts in this codebase:

- **`page.waitForFunction(fn, options)` argument-order bug** — for a zero-argument `fn`,
  Playwright's real signature is `waitForFunction(fn, arg, options)`. Passing `options` as
  the second positional argument silently makes it the `arg`, so the real timeout is never
  applied. Invisible to TypeScript. Always `waitForFunction(fn, undefined, options)` for
  zero-arg functions.
- **`.catch(() => {})` silently swallowing a failure inside a loop/retry** — always log what
  was caught, even when the test is designed to continue past it. A silently swallowed
  error has previously caused a test to retry a broken action for 10 minutes before the
  real defect was found.
- **`page.evaluate()` calling an async function without `return`** — Playwright resolves
  the evaluate call before the browser-side promise settles, which can cause a subsequent
  navigation to race against work that hasn't actually finished.
- **Reading form/DOM state immediately after navigation or reload** — any page with
  async data loading (Firestore `getDoc()`, an auth listener, a Cloud Function call) renders
  its initial DOM before that data arrives. Reading state right after `page.goto()` /
  `page.reload()` risks reading stale/empty/default markup. Requires an explicit wait for a
  real-data signal, not an assumption that navigation resolving means the page's own async
  data resolved too.
- **Storage-clearing helpers targeting the wrong origin** — `page.evaluate()` always targets
  the *current* page's origin; if the browser may be on an external domain (e.g. a payment
  redirect), navigate back to the target origin first.
- **An unguarded page-level JS call blocking the event loop or triggering an untracked
  navigation** — e.g. calling a site's own function directly instead of driving it through
  the UI.

These five account for the majority of "mystery hangs" found in this project so far. If the
current failure doesn't match any of them, say so explicitly rather than silently treating
it as "probably one of the known ones."

## 3. Fix infrastructure causes, then re-run and trust the real result

If a masking timeout/infrastructure issue is found and fixed, re-run the test and look at
what actually happens now — a fast, clean failure with a real assertion error is a genuine
finding, not evidence the fix was wrong. Do not assume the underlying test logic is fine
just because the original failure presented as a timeout, and do not skip the re-run and
reason about the fix in the abstract.

## 4. Only attribute to genuine site behaviour after ruling out infrastructure

A slow-but-passing or failing test should only be attributed to the target site's actual
behaviour once known infrastructure causes have been checked and ruled out per steps 1–3.
Skipping straight to "the site is just slow" or "this is a real defect" without doing that
is not a supported conclusion.

## 5. Before concluding "environmental," get evidence that actually shows it

"Environmental," "known CI limitation," "confirmed environmental," and similar language are
a hypothesis, not a conclusion — see CLAUDE.md's "'Environmental' is a hypothesis, not a
conclusion." Before writing that verdict anywhere permanent (a log entry, a skip comment, a
commit message, a finding), answer explicitly: what would this look like if it were NOT
environmental, and have you actually ruled that out? A plausible-sounding external cause
(network blip, CI resource constraints, a third-party SDK's own reconnection behavior) does
not become evidence just because it's plausible and nearby in the logs. It needs one of:

- A trace, log, or screenshot showing the actual mechanism directly — not inferred from a
  console message that happened to appear near the failure.
- The identical failure reproduced under genuinely independent conditions (different day,
  different account, different network path) in a way that specifically rules out a
  code-level cause.

Two real bugs in this project were nearly misattributed to "the environment" this way before
evidence overturned it: a Firestore WebChannel reconnection message that looked like the
cause of a multi-minute hang, when the actual cause was an unbounded `getAttribute()` call
elsewhere in the same code path; and three consecutive nightly CI failures about to be
documented as a known CI-only limitation, before a trace revealed a genuine site-side
auth-state race condition. A third case (`admin-order-lookup-reliability.spec.ts`, 22 July)
looked like the same "same test, CI-only" shape at first glance — asking this question
directly led straight to the test's account-setup code, which turned out to use unverified
`registerForCheckout` instead of the already-proven `runVerifiedCheckoutFlow` fix, an
ordinary authoring gap fixed in minutes with no environmental mystery at all. If you catch
yourself about to write "environmental" anywhere permanent, treat that as the moment to get
one more piece of real evidence, not the moment to close the investigation.

## 6. Debugging circuit breaker — stop after 2 failed live-patch attempts

If a single test has required more than 2 consecutive live-debugging fixes in one session
(patch → run → still broken → patch again) without reaching a clean pass, stop immediately.
Do not attempt a third patch. Instead:

1. Revert the file(s) to the last known-good commit: `git checkout HEAD~1 -- <file>`.
2. State clearly that the debugging attempt is being abandoned for this session, and why.
3. Do not re-run the test again in this session. Wait for explicit instruction to resume.

This overrides any instruction to "keep trying" or "just one more fix" given in the heat of
a debugging session. If the person insists on continuing past 2 failed attempts, state this
rule back to them explicitly so the decision to continue is made knowingly, not by momentum.

Any test expected to take longer than 60 seconds must have that duration explicitly
justified in a comment before it is built. If a test's actual runtime exceeds its stated
justification by more than 2×, that is itself a signal to stop and investigate before adding
more timeout budget — not a cue to just raise the number.
