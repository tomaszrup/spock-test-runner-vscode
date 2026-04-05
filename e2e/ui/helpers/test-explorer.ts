import { type Page, type Locator } from '@playwright/test';

/**
 * Page object for interacting with VS Code's Test Explorer sidebar.
 *
 * The extension registers its test controller under the view
 * `workbench.view.extension.test`.
 */
export class TestExplorer {
  private readonly page: Page;
  /** Root selector for the Testing sidebar view pane body */
  private readonly viewSelector = '[id="workbench.view.extension.test"] .pane-body';

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Open the Testing view via the Command Palette.
   */
  async open(): Promise<void> {
    await this.runCommand('Testing: Focus on Test Explorer View');
    await this.page.waitForTimeout(2_000);
  }

  /**
   * Wait for the test tree to contain at least one item.
   */
  async waitForTestTree(timeoutMs = 90_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const items = await this.getTreeItems();
      if (items.length > 0) {
        return;
      }
      await this.page.waitForTimeout(1_000);
    }
    throw new Error(`Test tree did not populate within ${timeoutMs}ms`);
  }

  /**
   * Expand the tree from root down to package level so spec files are visible.
   * Typical hierarchy: project → package → SpecFile.groovy → methods
   */
  async expandToSpecs(): Promise<void> {
    // Expand root
    await this.expandNode('spock-sample-project');
    // Wait for child nodes to appear after expanding
    await this.waitForItemContaining('com.', 10_000);

    // Expand all package nodes that appeared
    const items = await this.getTreeItems();
    for (const item of items) {
      if (item.startsWith('com.') || item.startsWith('org.')) {
        await this.expandNode(item);
        await this.page.waitForTimeout(1_000);
      }
    }
  }

  /**
   * Wait until at least one tree item contains the given substring.
   */
  private async waitForItemContaining(substring: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const items = await this.getTreeItems();
      if (items.some(i => i.includes(substring))) return;
      await this.page.waitForTimeout(500);
    }
  }

  /**
   * Get all visible tree items in the Test Explorer.
   */
  async getTreeItems(): Promise<string[]> {
    // VS Code testing tree renders names in .testing-stdtree-container .label
    const items = this.page.locator(`${this.viewSelector} .monaco-list-row .testing-stdtree-container .label`);
    const count = await items.count();
    const labels: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).textContent();
      if (text) {
        labels.push(text.trim());
      }
    }
    return labels;
  }

  /**
   * Find a tree item by its exact label text.
   */
  getTreeItem(label: string): Locator {
    return this.page.locator(`${this.viewSelector} .monaco-list-row`, {
      has: this.page.locator(`.testing-stdtree-container .label:text-is("${label}")`),
    }).first();
  }

  /**
   * Expand a tree node by selecting it and pressing Right arrow.
   */
  async expandNode(label: string): Promise<void> {
    const item = this.getTreeItem(label);
    // Click the label to select the tree item
    const labelEl = item.locator('.testing-stdtree-container .label');
    await labelEl.click();
    await this.page.waitForTimeout(300);
    // Press Right arrow to expand the node
    await this.page.keyboard.press('ArrowRight');
    await this.page.waitForTimeout(1_000);
  }

  /**
   * Click the run button (▶) next to a test item.
   */
  async runTest(label: string): Promise<void> {
    const item = this.getTreeItem(label);
    await item.hover();
    const runButton = item.locator('[aria-label="Run Test"]');
    await runButton.click();
  }

  /**
   * Click the debug button next to a test item.
   */
  async debugTest(label: string): Promise<void> {
    const item = this.getTreeItem(label);
    await item.hover();
    const debugButton = item.locator('[aria-label="Debug Test"]');
    await debugButton.click();
  }

  /**
   * Get the test status icon class for a test item.
   * Returns 'passed', 'failed', 'skipped', 'running', or 'unset'.
   */
  async getTestStatus(label: string): Promise<string> {
    const item = this.getTreeItem(label);
    const icon = item.locator('.computed-state');

    const classList = await icon.getAttribute('class').catch(() => '');
    if (!classList) {
      return 'unset';
    }
    if (classList.includes('codicon-testing-passed-icon')) {
      return 'passed';
    }
    if (classList.includes('codicon-testing-failed-icon')) {
      return 'failed';
    }
    if (classList.includes('codicon-testing-skipped-icon')) {
      return 'skipped';
    }
    if (classList.includes('codicon-loading') || classList.includes('codicon-testing-queued-icon')) {
      return 'running';
    }
    return 'unset';
  }

  /**
   * Run a command via the Command Palette.
   */
  async runCommand(command: string): Promise<void> {
    // Open Command Palette with Ctrl+Shift+P
    await this.page.keyboard.press('Control+Shift+KeyP');
    await this.page.waitForTimeout(500);

    // Type the command — use fill with '>' prefix to stay in command mode
    const input = this.page.locator('.quick-input-widget input[type="text"]');
    await input.fill(`>${command}`);
    await this.page.waitForTimeout(500);

    // Press Enter to execute
    await input.press('Enter');
    await this.page.waitForTimeout(1_000);
  }

  /**
   * Wait for a specific test to reach a final state (passed/failed/skipped).
   */
  async waitForTestResult(
    label: string,
    timeoutMs = 120_000,
  ): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.getTestStatus(label);
      if (['passed', 'failed', 'skipped'].includes(status)) {
        return status;
      }
      await this.page.waitForTimeout(1_000);
    }
    throw new Error(`Test "${label}" did not reach a final state within ${timeoutMs}ms`);
  }

  /**
   * After a test has failed, click it to open the peek error view,
   * then return the text content of the error message shown in the peek.
   *
   * VS Code renders the error peek inside a `.zone-widget` with
   * `.test-output-peek` containing the failure message.
   * Falls back to the "Test Results" output panel if the peek doesn't appear.
   */
  async getFailedTestMessage(label: string, timeoutMs = 15_000): Promise<string> {
    // Click the failed test item to open the peek view
    const item = this.getTreeItem(label);
    const labelEl = item.locator('.testing-stdtree-container .label');
    await labelEl.click();
    await this.page.waitForTimeout(500);

    // Try to open peek via "Testing: Peek Output" command
    await this.runCommand('Testing: Peek Output');
    await this.page.waitForTimeout(2_000);

    // Look for the peek widget that VS Code shows for test errors
    const peekSelectors = [
      '.test-output-peek',
      '.zone-widget .preview-text',
      '.zone-widget .test-peek-message',
      '.zone-widget',
    ];

    for (const selector of peekSelectors) {
      const el = this.page.locator(selector).first();
      const visible = await el.isVisible({ timeout: 3_000 }).catch(() => false);
      if (visible) {
        const text = await el.textContent({ timeout: 5_000 }).catch(() => '');
        if (text && text.trim().length > 0) {
          return text.trim();
        }
      }
    }

    // Fallback: open Test Results panel and grab output from there
    await this.runCommand('Testing: Focus on Test Results View');
    await this.page.waitForTimeout(2_000);

    // The Test Results output panel renders in various containers
    const outputSelectors = [
      '[id="workbench.panel.testResults"] .view-lines',
      '[id="workbench.panel.testResults"]',
      '.test-result-output',
    ];

    for (const selector of outputSelectors) {
      const el = this.page.locator(selector).first();
      const visible = await el.isVisible({ timeout: 3_000 }).catch(() => false);
      if (visible) {
        const text = await el.textContent({ timeout: 5_000 }).catch(() => '');
        if (text && text.trim().length > 0) {
          return text.trim();
        }
      }
    }

    return '';
  }
}
