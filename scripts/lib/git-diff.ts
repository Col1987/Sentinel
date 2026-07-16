import { execFileSync } from 'node:child_process';

// Shared by scripts/review-diff.ts and scripts/commit-review.ts — one proven,
// shell-injection-safe way to read a git diff, rather than two copies of the same
// execFileSync call drifting apart.

const MAX_DIFF_BUFFER = 20 * 1024 * 1024; // 20 MB — generous headroom for a large diff

// execFileSync (no shell) rather than execSync — avoids shell interpolation entirely,
// so ref arguments can't be misparsed regardless of their content.
export function getDiff(...refArgs: string[]): string {
  try {
    return execFileSync('git', ['diff', ...refArgs], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      maxBuffer: MAX_DIFF_BUFFER,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git diff ${refArgs.join(' ')} failed: ${message}`);
  }
}
