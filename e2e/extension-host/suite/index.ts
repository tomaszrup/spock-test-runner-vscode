/**
 * Mocha entry point executed by @vscode/test-cli inside the Extension Host.
 * Discovers and runs all *.test.js files in this directory.
 */
import * as path from 'node:path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 120_000,
    slow: 30_000,
  });

  const testsRoot = path.resolve(__dirname);
  const files = await glob('**/*.test.js', { cwd: testsRoot });

  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}
