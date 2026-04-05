import { test as base, type ElectronApplication, type Page, _electron } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';

export type VscodeFixtures = {
  vscodeApp: ElectronApplication;
  vscodePage: Page;
};

/**
 * Playwright fixture that launches VS Code as an Electron app with the
 * Spock Test Runner extension loaded and a sample workspace opened.
 */
export const test = base.extend<VscodeFixtures>({
  // eslint-disable-next-line no-empty-pattern
  vscodeApp: async ({}, use, testInfo) => {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const workspace = testInfo.project.metadata?.workspace
      ?? path.resolve(extensionDevelopmentPath, 'sample/sample-project');

    // Download VS Code (cached after first run).
    const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
    const cliArgs = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    // cliArgs[0] is the wrapper shell script; cliArgs[1..] contain --user-data-dir and --extensions-dir.
    const dataDirFlags = cliArgs.slice(1);

    // Extract user-data-dir from cliArgs so we can write settings before launch.
    const userDataFlag = dataDirFlags.find(f => f.startsWith('--user-data-dir='));
    const userDataDir = userDataFlag?.split('=')[1]
      ?? path.resolve(extensionDevelopmentPath, '.vscode-test/user-data');

    // Pre-create VS Code settings to disable dialogs that block automation.
    const settingsDir = path.join(userDataDir, 'User');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
      'security.workspace.trust.enabled': false,
      'workbench.welcomePage.walkthroughs.openOnInstall': false,
      'workbench.startupEditor': 'none',
      'extensions.autoUpdate': false,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
    }, null, 2));

    const app = await _electron.launch({
      executablePath: vscodeExecutablePath,
      args: [
        ...dataDirFlags,
        `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
        '--disable-gpu',
        '--no-sandbox',
        '--disable-updates',
        '--skip-release-notes',
        '--skip-welcome',
        workspace,
      ],
      env: {
        ...process.env,
        VSCODE_SKIP_PRELAUNCH: '1',
        DONT_PROMPT_WSL_INSTALL: '1',
      },
      timeout: 60_000,
    });

    await use(app);
    await app.close();
  },

  vscodePage: async ({ vscodeApp }, use) => {
    // Wait for the first BrowserWindow (main window)
    const page = await vscodeApp.firstWindow();

    // Wait for VS Code to be ready (workbench loaded)
    await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });

    // Dismiss any remaining startup dialogs
    await dismissStartupDialogs(page);

    await use(page);
  },
});

export { expect } from '@playwright/test';

/**
 * Dismiss startup dialogs, welcome tabs, and notification toasts.
 */
async function dismissStartupDialogs(page: Page): Promise<void> {
  // Wait a moment for dialogs to appear
  await page.waitForTimeout(2_000);

  // Dismiss "Trust this workspace" dialog if it appears despite the setting
  const trustButton = page.locator('button:has-text("Yes, I trust the authors")');
  if (await trustButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await trustButton.click();
    await page.waitForTimeout(500);
  }

  // Close Welcome tab if it's open
  const welcomeTab = page.locator('.tab:has-text("Welcome")');
  if (await welcomeTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const closeBtn = welcomeTab.locator('.codicon-close');
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    }
  }

  // Dismiss notification toasts (e.g. "All installed extensions are temporarily disabled")
  const dismissButtons = page.locator('.notifications-toasts .codicon-notifications-clear-all, .notifications-toasts .codicon-close');
  const count = await dismissButtons.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    await dismissButtons.nth(i).click().catch(() => {});
  }
}
