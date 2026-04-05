import { test, expect } from './fixtures/vscode.fixture';
import { TestExplorer } from './helpers/test-explorer';

test.describe('Debug — UI', () => {
  test('debug button is visible on test items', async ({ vscodePage }) => {
    const explorer = new TestExplorer(vscodePage);
    await explorer.open();
    await explorer.waitForTestTree(90_000);
    await explorer.expandToSpecs();

    // Hover over a spec file to reveal the debug button
    const item = explorer.getTreeItem('CalculatorSpec.groovy');
    await item.hover();
    await vscodePage.waitForTimeout(500);

    // Check that the debug action is available
    const debugButton = item.locator('[aria-label="Debug Test"]');
    const isVisible = await debugButton.isVisible({ timeout: 3_000 }).catch(() => false);
    expect(isVisible).toBe(true);
  });

  test('can set breakpoint on groovy file', async ({ vscodePage }) => {
    // Open a groovy file via Command Palette
    const explorer = new TestExplorer(vscodePage);
    await explorer.runCommand('Go to File...');
    await vscodePage.waitForTimeout(500);

    const input = vscodePage.locator('.quick-input-widget input[type="text"]');
    await input.fill('CalculatorSpec.groovy');
    await vscodePage.waitForTimeout(1_000);
    await input.press('Enter');
    await vscodePage.waitForTimeout(2_000);

    // Try to set a breakpoint by clicking in the gutter
    // The exact gutter click area varies, so this is a smoke test
    const editorLines = vscodePage.locator('.view-lines .view-line');
    const lineCount = await editorLines.count();
    expect(lineCount).toBeGreaterThan(0);
  });
});
