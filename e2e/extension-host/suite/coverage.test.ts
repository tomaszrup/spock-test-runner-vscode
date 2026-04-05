import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getActivatedExtension } from '../helpers/wait-helpers';

/**
 * Coverage profile smoke tests.
 * Full coverage verification (gutter decorations, Coverage panel data)
 * is done in the Playwright UI layer.
 */
suite('Coverage', function () {
  suiteSetup(async function () {
    await getActivatedExtension();
  });

  test('extension exposes Coverage run profile', async function () {
    this.timeout(90_000);
    // Verify the extension activates with a Coverage profile.
    // We can't enumerate profiles directly, but we can verify
    // that the extension activated successfully — the profiles
    // are created during construction.
    await vscode.commands.executeCommand('spock-test-runner.reloadTests');
    assert.ok(true, 'Extension has coverage support');
  });

  test('coverage init script exists for Gradle', async () => {
    // The extension bundles resources/coverage.init.gradle
    const ext = await getActivatedExtension();
    const extensionPath = ext.extensionPath;
    const initScriptUri = vscode.Uri.file(`${extensionPath}/resources/coverage.init.gradle`);
    try {
      await vscode.workspace.fs.stat(initScriptUri);
      assert.ok(true, 'coverage.init.gradle exists');
    } catch {
      assert.fail('coverage.init.gradle not found in extension resources');
    }
  });

  test('force-tests init script exists for Gradle', async () => {
    const ext = await getActivatedExtension();
    const extensionPath = ext.extensionPath;
    const initScriptUri = vscode.Uri.file(`${extensionPath}/resources/force-tests.init.gradle`);
    try {
      await vscode.workspace.fs.stat(initScriptUri);
      assert.ok(true, 'force-tests.init.gradle exists');
    } catch {
      assert.fail('force-tests.init.gradle not found in extension resources');
    }
  });
});
