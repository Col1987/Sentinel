#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import { getDiff } from './lib/git-diff';

// Commit-time AI code reviewer. Wired into CI via .github/workflows/commit-review.yml —
// runs once per push, as a single scoped API call, not an autonomous agent. Diffs only
// the commits in the push (COMMIT_REVIEW_BASE..COMMIT_REVIEW_HEAD), sends that diff to
// Claude with a system prompt scoped to a fixed list of vibe-coding failure patterns,
// and exits non-zero only when a critical-severity finding is returned — everything
// else is printed as informational and does not fail the build.
//
// SCOPE LIMITATION — this reviews the diff only, nothing else. It cannot see cross-file
// usage, whether a changed function is called safely elsewhere, whether it duplicates
// something in a file this diff doesn't touch, or whether it contradicts an earlier
// architectural decision made outside this diff. A clean result means "no obvious local
// pattern found in this diff," not "this change is broadly safe." This is reprinted by
// the script on every run (see printScopeBanner) and stated in the system prompt itself
// so this is never mistaken for a more thorough review than it actually is.
//
// This is genuinely different from src/auditors/code-quality.ts: that auditor scans the
// DEPLOYED site's live DOM after the fact (rendered HTML, runtime script behavior). This
// script reviews the source diff itself, before deployment, at commit time. They check
// overlapping failure categories from two different vantage points — neither replaces
// the other, and having both is intentional, not redundant. See README.md.
//
// Local usage (requires ANTHROPIC_API_KEY and git refs to diff):
//   COMMIT_REVIEW_BASE=HEAD~1 COMMIT_REVIEW_HEAD=HEAD npx tsx scripts/commit-review.ts

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 4096;

// Cost control: large diffs are skipped rather than sent — this is a single scoped call
// per commit, not a budget that scales with diff size. 60,000 chars is a conservative
// ceiling well within a single non-streaming request.
const MAX_DIFF_CHARS = 60_000;

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'One or two sentence summary of what this diff does and what was found.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          category: {
            type: 'string',
            description:
              'One of: orphaned-handler, dead-form, hardcoded-credential, duplicate-id, ' +
              'placeholder-content, console-log, localhost-reference, stale-comment, ' +
              'duplicated-logic, other',
          },
          file: { type: 'string', description: "File path from the diff this finding applies to." },
          description: { type: 'string' },
        },
        required: ['severity', 'category', 'file', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'findings'],
  additionalProperties: false,
} as const;

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

interface Finding {
  severity: Severity;
  category: string;
  file: string;
  description: string;
}

interface ReviewResult {
  summary: string;
  findings: Finding[];
}

const SYSTEM_PROMPT = `You are a commit-time code reviewer for a Playwright test-automation project. You are shown a single git diff and nothing else — no other files, no repo history beyond what is in the diff, no runtime behavior.

Check specifically for these vibe-coding failure patterns, and only these — do not perform a general code review:
- Orphaned event handlers (onclick/addEventListener referencing a function that is not defined anywhere in the diff and does not appear to be an existing, already-defined function)
- Dead forms (a form with no visible submit handler or action)
- Hardcoded API keys, tokens, or credentials
- Duplicate HTML element IDs within the same file
- Placeholder content left in (Lorem ipsum, TODO, FIXME, "test@test.com", other obvious placeholder text)
- console.log statements left in (not console.error/console.warn used for legitimate logging)
- Hardcoded localhost/127.0.0.1 references outside of local-only config
- Comments that describe behavior the adjacent code does not actually implement
- Suspicious duplicated logic (near-identical code blocks that look copy-pasted rather than shared)

CRITICAL SCOPE LIMITATION — you can only see the lines in this diff. You cannot see whether a changed function is called safely elsewhere, whether it duplicates something in a file this diff does not touch, or whether it contradicts an earlier architectural decision made outside this diff. Reflect that limitation in your summary: never describe a clean result as "this change is safe" — describe it as "no findings of the listed pattern types in this diff." Do not comment on anything outside the fixed list above.

Only use "critical" severity for something that would cause real, immediate harm if merged as-is (a live hardcoded credential, a completely dead form on a production flow). Use high/medium/low for everything else. If you find nothing, return an empty findings array and say so plainly in the summary — do not manufacture findings to appear thorough.`;

function printScopeBanner(): void {
  console.log('='.repeat(72));
  console.log('COMMIT REVIEW — DIFF-SCOPED ONLY, NOT A FULL REVIEW');
  console.log(
    'This review sees only the changed lines in this push. It cannot see cross-file\n' +
      'usage, whether a changed function is called safely elsewhere, whether it\n' +
      'duplicates something in an untouched file, or whether it contradicts an earlier\n' +
      'architectural decision. A clean result means "no obvious local pattern found in\n' +
      'this diff," not "this change is broadly safe."',
  );
  console.log('='.repeat(72));
  console.log('');
}

async function main(): Promise<void> {
  printScopeBanner();

  const base = process.env.COMMIT_REVIEW_BASE ?? 'HEAD~1';
  const head = process.env.COMMIT_REVIEW_HEAD ?? 'HEAD';

  console.log(`Reviewing: git diff ${base}..${head}\n`);

  let diff: string;
  try {
    diff = getDiff(`${base}..${head}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (!diff.trim()) {
    console.log('No changes in this diff — nothing to review.');
    return;
  }

  if (diff.length > MAX_DIFF_CHARS) {
    console.log(
      `Diff is ${diff.length} chars, over the ${MAX_DIFF_CHARS}-char review ceiling — ` +
        'skipping automatic review for this push rather than sending an unbounded request. ' +
        'This is a scope/cost limit, not a finding.',
    );
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Missing key means this feature hasn't been configured yet, not that this run
    // failed — exit 0 so every commit doesn't show a red X until the secret is added.
    // See README.md ("Commit review (AI)") for how to configure ANTHROPIC_API_KEY.
    console.log(
      'ANTHROPIC_API_KEY is not set — commit review is inactive until this secret is ' +
        'configured (Settings → Secrets and variables → Actions). Skipping, not failing.',
    );
    return;
  }

  const client = new Anthropic({ apiKey });

  let result: ReviewResult;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: FINDINGS_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Diff to review:\n\n${diff}` }],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) {
      throw new Error('No text content in API response.');
    }
    result = JSON.parse(textBlock.text) as ReviewResult;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('Anthropic API authentication failed — check that ANTHROPIC_API_KEY is valid.');
    } else if (err instanceof Anthropic.APIError) {
      console.error(`Anthropic API error (${err.status}): ${err.message}`);
    } else {
      console.error('commit-review failed:', err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Summary: ${result.summary}\n`);

  if (result.findings.length === 0) {
    console.log('No findings.');
    return;
  }

  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...result.findings].sort((a, b) => order[a.severity] - order[b.severity]);

  for (const f of sorted) {
    console.log(`[${f.severity.toUpperCase()}] ${f.category} — ${f.file}`);
    console.log(`  ${f.description}\n`);
  }

  // Pass/fail is computed here from severities, not from any self-assessed verdict in
  // the model's own response — deterministic gate, not a judgment call left to the model.
  const criticalCount = result.findings.filter((f) => f.severity === 'critical').length;
  if (criticalCount > 0) {
    console.error(`${criticalCount} critical finding(s) — failing this check.`);
    process.exitCode = 1;
    return;
  }

  console.log(`${result.findings.length} finding(s) logged, none critical — not failing the build.`);
}

main().catch((err) => {
  console.error('commit-review failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
