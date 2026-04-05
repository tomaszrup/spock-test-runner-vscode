import * as vscode from 'vscode';

/**
 * Poll a condition until it returns a truthy value or the timeout expires.
 */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 60_000,
  intervalMs = 500,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) {
      return result;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get the Spock extension instance and ensure it's activated.
 */
export async function getActivatedExtension(): Promise<vscode.Extension<unknown>> {
  const ext = vscode.extensions.getExtension('TomaszRup.spock-test-runner-vscode-tr');
  if (!ext) {
    throw new Error('Extension TomaszRup.spock-test-runner-vscode-tr not found');
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  return ext;
}

/**
 * Collect all TestItem descendants from a TestItemCollection recursively.
 */
export function collectTestItems(
  collection: vscode.TestItemCollection,
): vscode.TestItem[] {
  const items: vscode.TestItem[] = [];
  collection.forEach((item) => {
    items.push(item);
    items.push(...collectTestItems(item.children));
  });
  return items;
}

/**
 * Find a TestItem by label anywhere in the tree. Searches breadth-first.
 */
export function findTestItemByLabel(
  collection: vscode.TestItemCollection,
  label: string,
): vscode.TestItem | undefined {
  const all = collectTestItems(collection);
  return all.find((item) => item.label === label);
}

/**
 * Find all TestItems whose label matches the given regex.
 */
export function findTestItemsByPattern(
  collection: vscode.TestItemCollection,
  pattern: RegExp,
): vscode.TestItem[] {
  return collectTestItems(collection).filter((item) => pattern.test(item.label));
}

/**
 * Wait until the test controller has discovered tests (items.size > 0).
 */
export async function waitForTestDiscovery(
  controller: vscode.TestController,
  timeoutMs = 90_000,
): Promise<void> {
  await waitFor(() => {
    let count = 0;
    controller.items.forEach(() => count++);
    return count > 0;
  }, timeoutMs);
}
