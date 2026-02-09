import { vi } from 'vitest';

/**
 * Shared test helper utilities.
 * Consolidates mock factories duplicated across 8+ test files.
 */

/**
 * Create a mock `vscode.LogOutputChannel` / `vscode.OutputChannel`.
 * Includes both OutputChannel methods (`append`, `clear`, `show`, `hide`,
 * `dispose`, `replace`) and LogOutputChannel methods (`debug`, `info`,
 * `warn`, `error`, `trace`, `logLevel`, `onDidChangeLogLevel`) so it can
 * be used seamlessly by all layers of the extension.
 */
export function createMockLogger() {
  return {
    name: 'test',
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    replace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    logLevel: 2,
    onDidChangeLogLevel: vi.fn(() => ({ dispose: vi.fn() })),
  } as any;
}

/**
 * Default configuration values used across tests.
 * Individual tests can spread overrides on top.
 */
export const DEFAULT_MOCK_CONFIG = {
  debugPort: 5005,
  testTimeout: 300,
  debugConnectionTimeout: 60,
  debugRetries: 3,
  additionalGradleArgs: [] as string[],
  additionalMavenArgs: [] as string[],
  showDiffView: false,
  testSourcePatterns: ['**/src/test/groovy/**/*.groovy'],
  maxTestFileSize: 500_000,
};

/**
 * Create a mock instance-based `IConfigurationService`.
 * Pass partial overrides to customise individual config values.
 */
export function createMockConfigurationService(overrides?: Record<string, any>) {
  return {
    getConfig: vi.fn(() => ({
      ...DEFAULT_MOCK_CONFIG,
      ...overrides,
    })),
  } as any;
}
