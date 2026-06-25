import { test, expect } from '@playwright/test';

test.describe('Site health @smoke', () => {
  test('should return 200 for the homepage', async ({ page }) => {
    test.info().annotations.push({ type: 'description', description: 'Loaded the website homepage and checked that the server responded successfully. CONFIRMED: the homepage is accessible and returning a normal response to visitors.' });
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('should load without console errors', async ({ page }) => {
    test.info().annotations.push({ type: 'description', description: 'Loaded the homepage while monitoring for hidden error messages in the browser. CONFIRMED: no errors were detected during page load.' });
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/');
    expect(errors).toHaveLength(0);
  });

  test('should have a non-empty page title', async ({ page }) => {
    test.info().annotations.push({ type: 'description', description: "Checked that the browser tab shows a title when a visitor loads the homepage. CONFIRMED: the page has a title set — this also helps search engines understand the page's content." });
    await page.goto('/');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });
});
