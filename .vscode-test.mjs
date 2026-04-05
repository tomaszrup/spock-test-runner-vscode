import { defineConfig } from '@vscode/test-cli';
import path from 'node:path';

export default defineConfig([
  {
    label: 'e2e-gradle',
    files: 'out/e2e/extension-host/suite/**/*.test.js',
    version: 'stable',
    workspaceFolder: path.resolve('sample/sample-project'),
    mocha: {
      timeout: 120_000,
      slow: 30_000,
    },
    env: {
      E2E_BUILD_TOOL: 'gradle',
    },
  },
  {
    label: 'e2e-maven',
    files: 'out/e2e/extension-host/suite/**/*.test.js',
    version: 'stable',
    workspaceFolder: path.resolve('sample/sample-maven-project'),
    mocha: {
      timeout: 120_000,
      slow: 30_000,
    },
    env: {
      E2E_BUILD_TOOL: 'maven',
    },
  },
]);
