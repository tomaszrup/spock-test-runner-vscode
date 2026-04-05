import { type Page } from '@playwright/test';

/**
 * Wait until a condition returns truthy.
 */
export async function pollUntil<T>(
  page: Page,
  fn: () => T | Promise<T>,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) {
      return result;
    }
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

/**
 * Wait for the active editor to show a specific file.
 */
export async function waitForActiveEditor(
  page: Page,
  filename: string,
  timeoutMs = 15_000,
): Promise<void> {
  await pollUntil(page, async () => {
    const activeTab = page.locator('.tab.active .label-name');
    const text = await activeTab.textContent().catch(() => '');
    return text?.includes(filename);
  }, timeoutMs);
}

/**
 * Wait for the Test Results panel to contain expected text.
 */
export async function waitForTestOutput(
  page: Page,
  text: string,
  timeoutMs = 60_000,
): Promise<void> {
  await pollUntil(page, async () => {
    // The test results panel uses various selectors across VS Code versions
    const panels = page.locator('.test-output-peek, .test-result-peek, [class*="testResults"]');
    const content = await panels.allTextContents().catch(() => []);
    return content.some((c) => c.includes(text));
  }, timeoutMs);
}
