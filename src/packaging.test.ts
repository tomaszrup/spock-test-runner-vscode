/// <reference types="node" />

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

function readPackageJson(): {
  scripts?: Record<string, string>;
} {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
}

function readIgnorePatterns(): string[] {
  return fs
    .readFileSync(path.join(process.cwd(), '.vscodeignore'), 'utf8')
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0 && !line.startsWith('#'));
}

describe('.vscodeignore packaging rules', () => {
  it('should exclude repository and test artifacts from the VSIX', () => {
    const patterns = readIgnorePatterns();

    expect(patterns).toEqual(
      expect.arrayContaining([
        '.github/**',
        '.sonarcloud.properties',
        'coverage/**',
        'test-results/**',
        'node_modules/**',
        'scripts/**',
        'ui/**',
        'out/e2e/**',
        'out/__test_helpers__/**',
        '*.vsix',
      ]),
    );
  });

  it('should exclude dependency-only metadata and test folders from bundled node_modules', () => {
    const patterns = readIgnorePatterns();

    expect(patterns).toEqual(
      expect.arrayContaining([
        'node_modules/**/.github/**',
        'node_modules/**/.vscode/**',
        'node_modules/**/test/**',
        'node_modules/**/tests/**',
      ]),
    );
  });

  it('should build and package the bundled extension without runtime dependencies', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts?.compile).toContain('node scripts/build.mjs');
    expect(packageJson.scripts?.compile).toContain('npm run typecheck');
    expect(packageJson.scripts?.package).toContain('--no-dependencies');
  });
});