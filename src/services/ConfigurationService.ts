import * as vscode from 'vscode';

const SECTION = 'spockTestRunner';

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
  /** Extra Maven CLI arguments. Default: [] */
  additionalMavenArgs: string[];
  /** (Preview) Show inline diff view for failed assertions. Default: false */
  showDiffView: boolean;
  /** Glob patterns for discovering test source files. Default: ['** /src/test/groovy/** /*.groovy'] */
  testSourcePatterns: string[];
}

/**
 * Interface for configuration access — enables mocking in tests.
 */
export interface IConfigurationService {
  getConfig(): SpockTestRunnerConfig;
  onConfigChange(callback: (cfg: SpockTestRunnerConfig) => void): vscode.Disposable;
}

/**
 * Centralised accessor for every user-configurable setting.
 *
 * Can be used as an instance (preferred for dependency injection)
 * or via static methods (backward-compatible convenience).
 *
 * Usage:
 *   const cfg = configService.getConfig();   // instance
 *   const cfg = ConfigurationService.getConfig(); // static (legacy)
 */
export class ConfigurationService implements IConfigurationService {
  /**
   * Snapshot of the current configuration.
   * Re-call this whenever you need fresh values (e.g. before each test run)
   * to pick up any changes made by the user at runtime.
   */
  getConfig(): SpockTestRunnerConfig {
    return ConfigurationService.getConfig();
  }

  /**
   * Register a listener that fires whenever any setting under
   * `spockTestRunner.*` changes.
   */
  onConfigChange(callback: (cfg: SpockTestRunnerConfig) => void): vscode.Disposable {
    return ConfigurationService.onConfigChange(callback);
  }

  // ── Static convenience methods (backward-compatible) ───────────────

  static getConfig(): SpockTestRunnerConfig {
    const cfg = vscode.workspace.getConfiguration(SECTION);

    return {
      debugPort: cfg.get<number>('debugPort', 5005),
      testTimeout: cfg.get<number>('testTimeout', 300),
      debugConnectionTimeout: cfg.get<number>('debugConnectionTimeout', 60),
      debugRetries: cfg.get<number>('debugRetries', 3),
      additionalGradleArgs: cfg.get<string[]>('additionalGradleArgs', []),
      additionalMavenArgs: cfg.get<string[]>('additionalMavenArgs', []),
      showDiffView: cfg.get<boolean>('showDiffView', false),
      testSourcePatterns: cfg.get<string[]>('testSourcePatterns', ['**/src/test/groovy/**/*.groovy']),
    };
  }

  static onConfigChange(callback: (cfg: SpockTestRunnerConfig) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(SECTION)) {
        callback(ConfigurationService.getConfig());
      }
    });
  }
}

