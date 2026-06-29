import * as fs from 'fs';
import * as path from 'path';
import { Page, expect, test } from '@playwright/test';
import type { Journey, Action } from '../config/journeys';

const SCREENSHOT_DIR = 'reports/screenshots';

async function executeStep(page: Page, action: Action): Promise<void> {
  switch (action.kind) {
    case 'click':
      await page.locator(action.selector).click({ force: action.force });
      break;

    case 'fill':
      await page.locator(action.selector).fill(action.value);
      break;

    case 'select':
      await page.locator(action.selector).selectOption({ label: action.label });
      break;

    case 'waitFor':
      // No explicit timeout — uses Playwright's configured action default (30 s).
      // Per-step hard caps from journey config are intentionally not forwarded here;
      // they create independent caps that fire before the test's own timeout and mask
      // real failures with misleading "Timeout Xms exceeded" errors in LIVE_MODE.
      await page.locator(action.selector).waitFor({ state: action.state });
      break;

    case 'assertVisible':
      await expect(page.locator(action.selector)).toBeVisible();
      break;

    case 'assertHidden':
      await expect(page.locator(action.selector)).toBeHidden();
      break;

    case 'assertText':
      await expect(page.locator(action.selector)).toContainText(action.contains);
      break;
  }
}

export async function runJourney(journey: Journey, page: Page): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  test.info().annotations.push({ type: 'description', description: journey.clientDescription });

  for (let i = 0; i < journey.steps.length; i++) {
    const step = journey.steps[i];
    const stepLabel = `[${i + 1}/${journey.steps.length}] ${step.description}`;

    console.log(`  → ${stepLabel}`);

    try {
      await executeStep(page, step.action);
    } catch (err) {
      const filename = `${journey.id}-step-${String(i + 1).padStart(2, '0')}.png`;
      const screenshotPath = path.join(SCREENSHOT_DIR, filename);

      try {
        await page.screenshot({ path: screenshotPath, fullPage: false });
        console.error(`  ✗ Step failed — screenshot saved to ${screenshotPath}`);
      } catch {
        // Don't mask the original error if the screenshot itself fails
      }

      const original = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[${journey.id}] Step ${i + 1} failed — "${step.description}"\n${original}`,
      );
    }
  }
}
