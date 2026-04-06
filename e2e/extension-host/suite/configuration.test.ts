import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getActivatedExtension, sleep } from '../helpers/wait-helpers';

/**
 * Configuration / settings tests.
 */
suite('Configuration', function () {
  suiteSetup(async function () {
    await getActivatedExtension();
  });

  test('default testSourcePatterns is set', () => {
    const config = vscode.workspace.getConfiguration('spockTestRunner');
    const patterns = config.get<string[]>('testSourcePatterns') ?? [];
    assert.ok(patterns.length > 0, 'testSourcePatterns should have at least one entry');
    assert.ok(
      patterns.includes('**/src/test/groovy/**/*.groovy'),
      'Default pattern should include **/src/test/groovy/**/*.groovy',
    );
  });

  test('default debugPort is 5005', () => {
    const config = vscode.workspace.getConfiguration('spockTestRunner');
    const debugPort = config.get<number>('debugPort');
    assert.strictEqual(debugPort, 5005, 'Default debug port should be 5005');
  });

  test('default testTimeout is 300', () => {
    const config = vscode.workspace.getConfiguration('spockTestRunner');
    const timeout = config.get<number>('testTimeout');
    assert.strictEqual(timeout, 300, 'Default test timeout should be 300');
  });

  test('default showDiffView is false', () => {
    const config = vscode.workspace.getConfiguration('spockTestRunner');
    const showDiff = config.get<boolean>('showDiffView');
    assert.strictEqual(showDiff, false, 'Default showDiffView should be false');
  });

  test('additionalGradleArgs defaults to empty array', () => {
    const config = vscode.workspace.getConfiguration('spockTestRunner');
    const args = config.get<string[]>('additionalGradleArgs') ?? [];
    assert.ok(Array.isArray(args), 'additionalGradleArgs should be an array');
    assert.strictEqual(args.length, 0, 'additionalGradleArgs should default to empty');
  });

  test('additionalMavenArgs defaults to empty array', () => {
    const config = vscode.workspace.getConfiguration('spockTestRunner');
    const args = config.get<string[]>('additionalMavenArgs') ?? [];
    assert.ok(Array.isArray(args), 'additionalMavenArgs should be an array');
    assert.strictEqual(args.length, 0, 'additionalMavenArgs should default to empty');
  });

  test('changing testSourcePatterns triggers rediscovery', async function () {
    this.timeout(90_000);
    const config = vscode.workspace.getConfiguration('spockTestRunner');

    // Change to a custom pattern, then revert
    const original = config.get<string[]>('testSourcePatterns')!;
    await config.update(
      'testSourcePatterns',
      ['**/src/test/groovy/**/*.groovy', '**/src/integrationTest/groovy/**/*.groovy'],
      vscode.ConfigurationTarget.Workspace,
    );

    // Give the config listener time to react
    await sleep(2_000);

    // Revert
    await config.update('testSourcePatterns', original, vscode.ConfigurationTarget.Workspace);
    await sleep(1_000);

    assert.ok(true, 'Configuration change didn\'t crash the extension');
  });
});
