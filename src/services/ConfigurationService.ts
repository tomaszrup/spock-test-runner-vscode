import * as vscode from 'vscode';

const SECTION = 'spockTestRunner';

export type LogLevel = 'off' | 'error' | 'info' | 'debug';

export interface SpockTestRunnerConfig {
  /** Port used for JVM debug agent (JDWP). Default: 5005 */
  debugPort: number;
  /** Test execution timeout in seconds. Default: 300 */
  testTimeout: number;
  /** Debug connection timeout in seconds. Default: 60 */
  debugConnectionTimeout: number;
  /** Number of debug-attach retries. Default: 3 */
  debugRetries: number;
  /** Extra Gradle CLI arguments. Default: [] */
  additionalGradleArgs: string[];
  /** Output channel log level. Default: 'info' */
  logLevel: LogLevel;
}

/**
 * Centralised accessor for every user-configurable setting.
 *
 * Usage:
 *   const cfg = ConfigurationService.getConfig();
 *   const port = cfg.debugPort;
 *
 * All values fall back to their declared defaults when the user has
 * not overridden them.
 */
export class ConfigurationService {
  /**
   * Snapshot of the current configuration.
   * Re-call this whenever you need fresh values (e.g. before each test run)
   * to pick up any changes made by the user at runtime.
   */
  static getConfig(): SpockTestRunnerConfig {
    const cfg = vscode.workspace.getConfiguration(SECTION);

    return {
      debugPort: cfg.get<number>('debugPort', 5005),
      testTimeout: cfg.get<number>('testTimeout', 300),
      debugConnectionTimeout: cfg.get<number>('debugConnectionTimeout', 60),
      debugRetries: cfg.get<number>('debugRetries', 3),
      additionalGradleArgs: cfg.get<string[]>('additionalGradleArgs', []),
      logLevel: cfg.get<LogLevel>('logLevel', 'info'),
    };
  }

  /**
   * Register a listener that fires whenever any setting under
   * `spockTestRunner.*` changes.
   */
  static onConfigChange(callback: (cfg: SpockTestRunnerConfig) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(SECTION)) {
        callback(ConfigurationService.getConfig());
      }
    });
  }
}
