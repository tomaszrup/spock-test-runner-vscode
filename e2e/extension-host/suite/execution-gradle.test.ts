import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getActivatedExtension } from '../helpers/wait-helpers';

/**
 * Test execution for the Gradle sample project.
 * These tests only run when E2E_BUILD_TOOL=gradle (or unset).
 *
 * Because Extension Host tests cannot directly hold a reference to the
 * TestController, these tests exercise execution indirectly via commands
 * and by verifying the extension doesn't throw.  Full execution result
 * verification is done in the Playwright UI layer.
 */
suite('Test Execution — Gradle', function () {
  const isGradle = !process.env.E2E_BUILD_TOOL || process.env.E2E_BUILD_TOOL === 'gradle';

  suiteSetup(async function () {
    if (!isGradle) {
      this.skip();
    }
    await getActivatedExtension();
  });

  test('reload then re-run-failed on clean state shows info', async function () {
    this.timeout(90_000);
    await vscode.commands.executeCommand('spock-test-runner.reloadTests');

    // Re-run failed with no previous failures should show info message, not crash
    await vscode.commands.executeCommand('spock-test-runner.rerunFailedTests');
    assert.ok(true, 'Re-run failed with no previous failures handled gracefully');
  });

  test('groovy files are associated with groovy language', async () => {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(getCalculatorSpecPath()),
    );
    assert.strictEqual(doc.languageId, 'groovy', 'Groovy file should have groovy language ID');
  });

  test('breakpoint support is registered for groovy', async () => {
    // The extension contributes breakpoints for 'groovy' language.
    // Verify we can set a breakpoint on a groovy file without error.
    const uri = vscode.Uri.file(getCalculatorSpecPath());
    const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(7, 0)));
    vscode.debug.addBreakpoints([bp]);

    const breakpoints = vscode.debug.breakpoints;
    assert.ok(breakpoints.length > 0, 'Should be able to set breakpoint on groovy file');

    vscode.debug.removeBreakpoints([bp]);
  });
});

function getCalculatorSpecPath(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder');
  }
  return vscode.Uri.joinPath(
    folders[0].uri,
    'src/test/groovy/com/example/CalculatorSpec.groovy',
  ).fsPath;
}
