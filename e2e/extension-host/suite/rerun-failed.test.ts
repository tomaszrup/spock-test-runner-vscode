import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getActivatedExtension } from '../helpers/wait-helpers';

/**
 * Re-run Failed Tests command behaviour.
 */
suite('Re-run Failed Tests', function () {
  suiteSetup(async function () {
    await getActivatedExtension();
  });

  test('re-run-failed with no previous failures is graceful', async function () {
    this.timeout(90_000);
    // Ensure the tree is loaded first
    await vscode.commands.executeCommand('spock-test-runner.reloadTests');

    // With no prior failures, this should show info, not crash
    await vscode.commands.executeCommand('spock-test-runner.rerunFailedTests');
    assert.ok(true, 'Re-run failed tests command handled gracefully on clean state');
  });

  test('re-run-failed command exists in command palette', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('spock-test-runner.rerunFailedTests'),
      'rerunFailedTests command should be available',
    );
  });
});
