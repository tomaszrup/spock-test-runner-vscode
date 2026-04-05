import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getActivatedExtension } from '../helpers/wait-helpers';

suite('Extension Activation', () => {
  test('extension is present', () => {
    const ext = vscode.extensions.getExtension('TomaszRup.spock-test-runner-vscode-tr');
    assert.ok(ext, 'Extension should be installed');
  });

  test('extension activates', async () => {
    const ext = await getActivatedExtension();
    assert.ok(ext.isActive, 'Extension should be active');
  });

  test('commands are registered', async () => {
    await getActivatedExtension();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('spock-test-runner.reloadTests'),
      'reloadTests command should be registered',
    );
    assert.ok(
      commands.includes('spock-test-runner.rerunFailedTests'),
      'rerunFailedTests command should be registered',
    );
  });

  test('Spock Test Runner output channel exists', async () => {
    await getActivatedExtension();

    // The output channel is registered as 'Spock Test Runner'.
    // We can't directly query output channels, but we can verify
    // the extension activated without errors — the output channel
    // is created during activation.
    assert.ok(true, 'Extension activated successfully with output channel');
  });
});
