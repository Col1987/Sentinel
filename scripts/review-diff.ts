#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

// Manual, on-demand diff review — not wired into CI, not a test, does not fail any
// process. Run this after a debugging session that involved 2+ live-patch attempts,
// before building more work on top, to catch:
//   (a) a change that contradicts or undoes an earlier fix in the same diff, and
//   (b) a specific CLAUDE.md convention the diff appears to violate.
//
// Usage:
//   npm run review                  # git diff HEAD (working tree vs last commit)
//   npm run review -- HEAD~3        # git diff HEAD~3
//   npm run review -- main...HEAD   # any valid git diff ref range
//
// Requires ANTHROPIC_API_KEY set locally (see .env.example). Never required in CI —
// this script is not referenced by any GitHub Actions workflow.

const MAX_DIFF_BUFFER = 20 * 1024 * 1024; // 20 MB — generous headroom for a large diff

function getDiff(ref: string): string {
  try {
    // execFileSync (no shell) rather than execSync — avoids shell interpolation
    // entirely, so the ref argument can't be misparsed regardless of its content.
    return execFileSync('git', ['diff', ref], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      maxBuffer: MAX_DIFF_BUFFER,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git diff ${ref} failed: ${message}`);
  }
}

function readClaudeMd(): string {
  const claudeMdPath = path.join(process.cwd(), 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    console.warn('Warning: CLAUDE.md not found at project root — reviewing without convention context.\n');
    return '';
  }
  return fs.readFileSync(claudeMdPath, 'utf-8');
}

function buildSystemPrompt(claudeMd: string): string {
  const conventions = claudeMd
    ? claudeMd
    : '(CLAUDE.md not found — no documented conventions available. Focus only on part (a): internal contradictions within the diff itself.)';

  return `You are reviewing a git diff from a Playwright test-automation project against its own documented engineering conventions and against itself for internal consistency.

Given this diff and this project's documented conventions, identify:
(a) Any change that appears to contradict or revert a previously-established fix pattern visible elsewhere in the diff or an accompanying file excerpt if provided.
(b) Any specific CLAUDE.md convention this diff appears to violate, citing the specific rule.

Be concise. If nothing is found, say so plainly — do not manufacture concerns.

=== CLAUDE.md ===
${conventions}`;
}

async function main(): Promise<void> {
  const ref = process.argv[2] ?? 'HEAD';

  console.log(`Reviewing: git diff ${ref}\n`);

  let diff: string;
  try {
    diff = getDiff(ref);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (!diff.trim()) {
    console.log(`No changes found for "git diff ${ref}" — nothing to review.`);
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      'ANTHROPIC_API_KEY is not set.\n' +
        'This is a local developer tool only — add ANTHROPIC_API_KEY to your local .env ' +
        '(see .env.example) before running it. It is never required in CI.',
    );
    process.exitCode = 1;
    return;
  }

  const claudeMd = readClaudeMd();
  const client = new Anthropic({ apiKey });

  let responseText = '';
  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: buildSystemPrompt(claudeMd),
      messages: [
        {
          role: 'user',
          content: `Here is the diff to review:\n\n${diff}`,
        },
      ],
    });

    for (const block of response.content) {
      if (block.type === 'text') {
        responseText += block.text;
      }
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('Anthropic API authentication failed — check that ANTHROPIC_API_KEY is valid.');
    } else if (err instanceof Anthropic.APIError) {
      console.error(`Anthropic API error (${err.status}): ${err.message}`);
    } else {
      console.error('review-diff failed:', err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
    return;
  }

  console.log('─'.repeat(72));
  console.log(responseText.trim() || '(No review text returned.)');
  console.log('─'.repeat(72));
}

main().catch((err) => {
  console.error('review-diff failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
