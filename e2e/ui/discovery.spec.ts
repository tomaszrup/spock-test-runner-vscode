import { test, expect } from './fixtures/vscode.fixture';
import { TestExplorer } from './helpers/test-explorer';

test.describe('Test Discovery — UI', () => {
  test('Test Explorer shows Spock test tree', async ({ vscodePage }) => {
    const explorer = new TestExplorer(vscodePage);
    await explorer.open();
    await explorer.waitForTestTree(90_000);

    const items = await explorer.getTreeItems();
    expect(items.length).toBeGreaterThan(0);
  });

  test('CalculatorSpec appears in test tree', async ({ vscodePage }) => {
    const explorer = new TestExplorer(vscodePage);
    await explorer.open();
    await explorer.waitForTestTree(90_000);
    await explorer.expandToSpecs();

    const items = await explorer.getTreeItems();
    const hasCalculator = items.some((item) =>
      item.includes('CalculatorSpec'),
    );
    expect(hasCalculator).toBe(true);
  });

  test('test tree has hierarchical structure', async ({ vscodePage }) => {
    const explorer = new TestExplorer(vscodePage);
    await explorer.open();
    await explorer.waitForTestTree(90_000);
    await explorer.expandToSpecs();

    // Expand a spec file to see class and methods
    await explorer.expandNode('CalculatorSpec.groovy');
    await vscodePage.waitForTimeout(1_000);

    const items = await explorer.getTreeItems();
    // After expanding, we should see method-level items
    expect(items.length).toBeGreaterThan(3);
  });

  test('sub-module tests are discovered', async ({ vscodePage }) => {
    const explorer = new TestExplorer(vscodePage);
    await explorer.open();
    await explorer.waitForTestTree(90_000);

    // Expand root then sub-module
    await explorer.expandNode('spock-sample-project');
    await vscodePage.waitForTimeout(1_000);
    await explorer.expandNode('sub-module');
    await vscodePage.waitForTimeout(1_000);

    const items = await explorer.getTreeItems();
    // Sub-module packages should appear
    const hasSubModule = items.some(
      (item) => item.includes('submodule') || item.includes('MathHelper') || item.includes('StringHelper'),
    );
    expect(hasSubModule).toBe(true);
  });

  test('multiple spec files are discovered', async ({ vscodePage }) => {
    const explorer = new TestExplorer(vscodePage);
    await explorer.open();
    await explorer.waitForTestTree(90_000);
    await explorer.expandToSpecs();

    const items = await explorer.getTreeItems();
    // We should see more than just CalculatorSpec
    const specs = items.filter((item) => item.includes('.groovy'));
    expect(specs.length).toBeGreaterThan(3);
  });
});
