/**
 * Standalone launcher for Extension Host integration tests.
 * Prefer using `npx vscode-test` (which reads .vscode-test.mjs) instead
 * of running this directly.  This file exists as a fallback / reference.
 */
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const buildTool = process.env.E2E_BUILD_TOOL ?? 'gradle';
  const workspacePath = buildTool === 'maven'
    ? path.resolve(extensionDevelopmentPath, 'sample/sample-maven-project')
    : path.resolve(extensionDevelopmentPath, 'sample/sample-project');

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      '--disable-extensions',
    ],
    extensionTestsEnv: {
      E2E_BUILD_TOOL: buildTool,
    },
  });
}

main().catch((err) => {
  console.error('Failed to run E2E tests', err);
  process.exit(1);
});
