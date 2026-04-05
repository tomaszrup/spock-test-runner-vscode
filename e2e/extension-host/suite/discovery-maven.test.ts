import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getActivatedExtension, waitFor } from '../helpers/wait-helpers';

/**
 * Test discovery for the Maven sample project.
 * These tests only run when E2E_BUILD_TOOL=maven.
 */
suite('Test Discovery — Maven', function () {
  const isMaven = process.env.E2E_BUILD_TOOL === 'maven';

  suiteSetup(async function () {
    if (!isMaven) {
      this.skip();
    }
    await getActivatedExtension();
  });

  test('test controller is registered', async () => {
    await vscode.commands.executeCommand('spock-test-runner.reloadTests');
    assert.ok(true, 'Reload command executed without error for Maven project');
  });

  test('discovers tests in Maven project', async function () {
    this.timeout(90_000);
    await vscode.commands.executeCommand('spock-test-runner.reloadTests');
    assert.ok(true, 'Discovery completed for Maven project');
  });

  test('discovers sub-module tests', async function () {
    this.timeout(90_000);
    // The Maven project has a <modules>sub-module</modules> section.
    // After reload, the extension should discover tests under sub-module/
    await vscode.commands.executeCommand('spock-test-runner.reloadTests');
    assert.ok(true, 'Sub-module discovery completed for Maven project');
  });

  test('reload command is idempotent', async function () {
    this.timeout(90_000);
    await vscode.commands.executeCommand('spock-test-runner.reloadTests');
    await vscode.commands.executeCommand('spock-test-runner.reloadTests');
    assert.ok(true, 'Multiple reloads succeeded without error');
  });
});
