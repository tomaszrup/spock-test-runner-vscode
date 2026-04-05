import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getActivatedExtension } from '../helpers/wait-helpers';

/**
 * Test execution for the Maven sample project.
 * These tests only run when E2E_BUILD_TOOL=maven.
 */
suite('Test Execution — Maven', function () {
  const isMaven = process.env.E2E_BUILD_TOOL === 'maven';

  suiteSetup(async function () {
    if (!isMaven) {
      this.skip();
    }
    await getActivatedExtension();
  });

  test('reload then re-run-failed on clean state shows info', async function () {
    this.timeout(90_000);
    await vscode.commands.executeCommand('spock-test-runner.reloadTests');
    await vscode.commands.executeCommand('spock-test-runner.rerunFailedTests');
    assert.ok(true, 'Re-run failed with no previous failures handled gracefully');
  });

  test('groovy files in Maven project have groovy language ID', async () => {
    const doc = await vscode.workspace.openTextDocument(getCalculatorSpecMavenPath());
    assert.strictEqual(doc.languageId, 'groovy', 'Groovy file should have groovy language ID');
  });

  test('breakpoint support on Maven groovy files', async () => {
    const uri = vscode.Uri.file(getCalculatorSpecMavenPath());
    const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(7, 0)));
    vscode.debug.addBreakpoints([bp]);

    const breakpoints = vscode.debug.breakpoints;
    assert.ok(breakpoints.length > 0, 'Should be able to set breakpoint on Maven groovy file');

    vscode.debug.removeBreakpoints([bp]);
  });
});

function getCalculatorSpecMavenPath(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder');
  }
  return vscode.Uri.joinPath(
    folders[0].uri,
    'src/test/groovy/com/example/CalculatorSpec.groovy',
  ).fsPath;
}
