import { rmSync } from 'node:fs';
import { build, context } from 'esbuild';

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  external: ['vscode'],
  logLevel: 'info',
};

async function main() {
  rmSync('out', { recursive: true, force: true });

  if (isWatch) {
    const watchContext = await context(buildOptions);
    await watchContext.watch();
    return;
  }

  await build(buildOptions);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}