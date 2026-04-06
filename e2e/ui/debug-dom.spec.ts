import { test } from './fixtures/vscode.fixture';
import { TestExplorer } from './helpers/test-explorer';

test('debug DOM structure', async ({ vscodePage }) => {
  const explorer = new TestExplorer(vscodePage);
  await explorer.open();
  await explorer.waitForTestTree(90_000);

  console.log('=== Before expand ===');
  let items = await explorer.getTreeItems();
  console.log('Items:', items);

  // Expand root node
  await explorer.expandNode('spock-sample-project');
  await vscodePage.waitForTimeout(2_000);

  console.log('=== After expand root ===');
  items = await explorer.getTreeItems();
  console.log('Items:', items);

  // If there's an intermediate level, expand it too
  if (items.length > 0 && !items.some(i => i.includes('Spec'))) {
    for (const item of items.slice(0, 3)) {
      if (item !== 'spock-sample-project') {
        await explorer.expandNode(item);
        await vscodePage.waitForTimeout(1_000);
      }
    }
    console.log('=== After expand children ===');
    items = await explorer.getTreeItems();
    console.log('Items:', items);
  }
});
