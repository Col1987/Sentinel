# Operating costs

A summary-level reference for what running Sentinel actually costs, so a maintainer can reason about spend without digging through workflow YAML. Not a budget-enforcement system — no alerting or caps are implemented against any of this.

## Safe mode

Safe mode (`SENTINEL_LIVE_MODE=false`, the default) — smoke, functional, security, audit, admin projects, 206 tests — intercepts every outbound backend request before it leaves the browser. Cost is Playwright/GitHub Actions CI minutes only. No external API is ever called.

## LIVE_MODE (nightly regression)

`nightly-regression.yml` runs the 12-test `regression` project against the real backend once daily (02:00 UTC) plus on-demand `workflow_dispatch`.

- **Firebase Cloud Functions:** a full run triggers on the order of a handful to low-teens real invocations — one checkout (`createOrder`), a couple of admin status advances, plus whatever the site's own backend triggers off those writes (e.g. confirmation email send). Sentinel doesn't independently meter this — treat it as an order-of-magnitude estimate, not a billed total pulled from GCP.
- **Gmail API:** polled every 3s (`POLL_INTERVAL_MS`) up to 30s for verification-email checks and up to 60s for order-confirmation-email checks (`POLL_TIMEOUT_MS` / `ORDER_POLL_TIMEOUT_MS` in `src/utils/gmail.ts`) — at most ~10–20 `messages.list` calls per check, fewer if the email arrives early. Gmail API's default quota is generous relative to this volume; it is not a practical constraint at current test count.
- **GitHub Actions runner minutes:** `playwright.config.ts` forces `workers: 1` whenever `SENTINEL_LIVE_MODE=true` (real backend + shared admin account — see [CLAUDE.md](../CLAUDE.md)), so LIVE_MODE runs are strictly sequential, not parallelized for speed. The full suite (safe-mode audit + LIVE_MODE regression) currently takes **~47 minutes** end-to-end in CI under this constraint.

## Commit review workflow (optional, Anthropic API)

`commit-review.yml` sends one diff per push to Claude in a single scoped API call. **Currently dormant** — `ANTHROPIC_API_KEY` is not configured as a repo secret, so the workflow logs itself as disabled and exits 0 without calling the API. Cost is zero as-is. If the secret is added, cost becomes one API call per push (diff-sized input, small structured JSON output) — no batching, no retries, no agentic loop.

## Gmail OAuth maintenance

The refresh token (`GMAIL_REFRESH_TOKEN`) periodically expires or is revoked and needs re-authorization unless the OAuth consent screen is published — it has been published, which considerably extends token lifetime, but occasional re-authorization can still be required. When the token is refreshed, it must be updated in **both** places — local `.env` and the repo's GitHub Actions secret — or the two environments silently drift out of sync and CI starts failing with an infrastructure error that local runs don't reproduce.
