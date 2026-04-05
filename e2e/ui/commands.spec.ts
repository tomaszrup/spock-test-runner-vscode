import { test, expect } from './fixtures/vscode.fixture';
import { TestExplorer } from './helpers/test-explorer';

test.describe('Commands — UI', () => {
  test('Reload Spock Tests command works via command palette', async ({ vscodePage }) => {
    const explorer = new TestExplorer(vscodePage);
    await explorer.open();

    // Execute reload command
    await explorer.runCommand('Spock Test Runner: Reload Spock Tests');
    await vscodePage.waitForTimeout(5_000);

    // After reload, test tree should be populated
    await explorer.waitForTestTree(90_000);
    const items = await explorer.getTreeItems();
    expect(items.length).toBeGreaterThan(0);
  });

  test('Re-run Failed Tests command exists in palette', async ({ vscodePage }) => {
    const explorer = new TestExplorer(vscodePage);

    // Open Command Palette
    await vscodePage.keyboard.press('Control+Shift+KeyP');
    await vscodePage.waitForTimeout(500);

    const input = vscodePage.locator('.quick-input-widget input[type="text"]');
    await input.fill('>Spock Test Runner: Re-run Failed Tests');
    await vscodePage.waitForTimeout(500);

    // Verify the command appears in the list
    const results = vscodePage.locator('.quick-input-list .monaco-list-row');
    const count = await results.count();
    expect(count).toBeGreaterThan(0);

    // Dismiss command palette
    await vscodePage.keyboard.press('Escape');
  });

  test('command palette shows Spock commands when filtering', async ({ vscodePage }) => {
    await vscodePage.keyboard.press('Control+Shift+KeyP');
    await vscodePage.waitForTimeout(500);

    const input = vscodePage.locator('.quick-input-widget input[type="text"]');
    await input.fill('>Spock');
    await vscodePage.waitForTimeout(500);

    const results = vscodePage.locator('.quick-input-list .monaco-list-row');
    const count = await results.count();
    // Should show at least "Reload Spock Tests" and "Re-run Failed Tests"
    expect(count).toBeGreaterThanOrEqual(2);

    await vscodePage.keyboard.press('Escape');
  });

  test('reload command refreshes the test tree', async ({ vscodePage }) => {
    const explorer = new TestExplorer(vscodePage);
    await explorer.open();
    await explorer.waitForTestTree(90_000);

    // Note the current items
    const itemsBefore = await explorer.getTreeItems();

    // Reload
    await explorer.runCommand('Spock Test Runner: Reload Spock Tests');
    await vscodePage.waitForTimeout(5_000);

    // Tree should still be populated after reload
    await explorer.waitForTestTree(90_000);
    const itemsAfter = await explorer.getTreeItems();
    expect(itemsAfter.length).toBeGreaterThan(0);
  });
});
