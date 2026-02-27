import * as vscode from 'vscode';
import { BuildToolService } from './services/BuildToolService';
import { ConfigurationService } from './services/ConfigurationService';
import { CoverageService, SpockFileCoverage } from './services/CoverageService';
import { TestDiscoveryService } from './services/TestDiscoveryService';
import { TestExecutionService } from './services/TestExecutionService';
import { TestResultParser } from './services/TestResultParser';
import { TestTreeManager } from './TestTreeManager';
import { ResultProcessor } from './ResultProcessor';
import { TestRunCoordinator } from './TestRunCoordinator';

/**
 * Thin façade that wires together tree management, result processing,
 * and test execution coordination.  All heavy lifting is delegated to
 * {@link TestTreeManager}, {@link ResultProcessor}, and {@link TestRunCoordinator}.
 */
export class SpockTestController {
  private readonly controller: vscode.TestController;
  private readonly logger: vscode.LogOutputChannel;
  private readonly treeManager: TestTreeManager;
  private readonly resultProcessor: ResultProcessor;
  private readonly runCoordinator: TestRunCoordinator;
  private initialDiscoveryCompleted = false;
  private fullDiscoveryPromise: Promise<void> | undefined;

  constructor(context: vscode.ExtensionContext, logger: vscode.LogOutputChannel) {
    this.logger = logger;
    this.logger.appendLine('SpockTestController: Initializing...');

    this.controller = vscode.tests.createTestController(
      'spock-test-runner-vscode',
      'Spock Tests',
    );

    const testExecutionService = new TestExecutionService(this.logger);
    const testResultParser = new TestResultParser(this.logger);
    const coverageService = new CoverageService(this.logger);
    const buildToolService = new BuildToolService(context.extensionPath);
    const configurationService = new ConfigurationService();
    const testDiscoveryService = new TestDiscoveryService();

    this.treeManager = new TestTreeManager(
      this.controller, this.logger,
      buildToolService, configurationService, testDiscoveryService,
    );
    this.resultProcessor = new ResultProcessor(
      this.controller, this.logger, testResultParser,
      configurationService,
      this.treeManager.testData, this.treeManager.iterationItems,
    );
    this.runCoordinator = new TestRunCoordinator(
      this.controller, this.logger,
      testExecutionService, testResultParser, coverageService,
      this.treeManager, this.resultProcessor,
      buildToolService,
    );

    // Clear stale re-run-failed data when the test tree is rebuilt.
    this.treeManager.onDidRebuildTree(() => {
      this.runCoordinator.lastFailedTests.clear();
      this.logger.appendLine('SpockTestController: Cleared lastFailedTests after tree rebuild');
    });

    this.logger.appendLine('SpockTestController: TestController created');

    this.setupTestController();
    this.treeManager.setupFileWatchers();
    this.createRunProfiles();
    this.registerCommands(context);

    // Automatically discover tests on startup
    this.startInitialDiscovery();

    context.subscriptions.push(this.controller, { dispose: () => this.treeManager.dispose() });
  }

  private startInitialDiscovery(): void {
    this.logger.appendLine('SpockTestController: Starting automatic test discovery...');
    void this.ensureFullDiscovery(true, 'startup').catch(error => {
      this.logger.appendLine(`SpockTestController: Error during automatic discovery: ${error}`);
    });
  }

  private setupTestController(): void {
    this.controller.resolveHandler = async (test) => {
      this.logger.appendLine(`SpockTestController: resolveHandler called with test: ${test ? test.id : 'null'}`);

      if (test) {
        const data = this.treeManager.testData.get(test);
        if (data?.type === 'project' || data?.type === 'subproject' || data?.type === 'package') {
          this.logger.appendLine(`SpockTestController: Skipping resolve for ${data.type} node: ${test.label}`);
          return;
        }
        this.logger.appendLine(`SpockTestController: Discovering tests in file: ${test.uri?.fsPath}`);
        await this.treeManager.discoverTestsInFile(test);
        return;
      }
      await this.ensureFullDiscovery(false, 'resolveHandler');
    };

    this.controller.refreshHandler = async (token: vscode.CancellationToken) => {
      this.logger.appendLine('SpockTestController: refreshHandler triggered (Test Explorer refresh button)');
      if (token.isCancellationRequested) {
        return;
      }
      await this.ensureFullDiscovery(true, 'refreshHandler');
      this.logger.appendLine('SpockTestController: refreshHandler completed');
    };
  }

  private async ensureFullDiscovery(force: boolean, trigger: string): Promise<void> {
    if (!force) {
      if (this.initialDiscoveryCompleted) {
        this.logger.appendLine(`SpockTestController: Skipping full discovery for ${trigger} (already completed)`);
        return;
      }
      if (this.fullDiscoveryPromise) {
        this.logger.appendLine(`SpockTestController: Waiting for ongoing full discovery (${trigger})`);
        await this.fullDiscoveryPromise;
        return;
      }
    } else if (this.fullDiscoveryPromise) {
      this.logger.appendLine(`SpockTestController: Waiting for ongoing full discovery before forced reload (${trigger})`);
      await this.fullDiscoveryPromise;
    }

    this.logger.appendLine(`SpockTestController: Discovering all tests (${trigger})...`);

    const discoveryPromise = this.treeManager.discoverAllTests()
      .then(() => {
        this.initialDiscoveryCompleted = true;
      })
      .catch(error => {
        this.initialDiscoveryCompleted = false;
        throw error;
      })
      .finally(() => {
        if (this.fullDiscoveryPromise === discoveryPromise) {
          this.fullDiscoveryPromise = undefined;
        }
      });

    this.fullDiscoveryPromise = discoveryPromise;
    await discoveryPromise;
  }

  private createRunProfiles(): void {
    const runnableTag = new vscode.TestTag('runnable');

    const runProfile = this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runCoordinator.continuousRunHandler(false, request, token),
      true,
      runnableTag,
    );
    runProfile.supportsContinuousRun = true;

    this.controller.createRunProfile(
      'Debug',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.runCoordinator.runHandler(true, request, token),
      true,
      runnableTag,
    );

    const coverageProfile = this.controller.createRunProfile(
      'Coverage',
      vscode.TestRunProfileKind.Coverage,
      (request, token) => this.runCoordinator.continuousRunHandler(false, request, token, true),
      true,
      runnableTag,
    );
    coverageProfile.supportsContinuousRun = true;

    coverageProfile.loadDetailedCoverage = async (_testRun, fileCoverage, _token) => {
      if (fileCoverage instanceof SpockFileCoverage) {
        return fileCoverage.details;
      }
      return [];
    };

    this.controller.createRunProfile(
      'Re-run Failed Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runCoordinator.rerunFailedHandler(request, token),
      false,
      runnableTag,
    );
  }

  private registerCommands(context: vscode.ExtensionContext): void {
    const reloadCommand = vscode.commands.registerCommand('spock-test-runner.reloadTests', async () => {
      this.logger.appendLine('SpockTestController: Manual reload command triggered');
      await this.ensureFullDiscovery(true, 'manualReloadCommand');
      this.logger.appendLine('SpockTestController: Manual reload completed');
    });

    const rerunFailedCommand = vscode.commands.registerCommand('spock-test-runner.rerunFailedTests', async () => {
      this.logger.appendLine('SpockTestController: Re-run Failed Tests command triggered');

      if (this.runCoordinator.lastFailedTests.size === 0) {
        vscode.window.showInformationMessage('No failed tests to re-run.');
        return;
      }

      const failedItems: vscode.TestItem[] = [];
      const findFailedItems = (items: vscode.TestItemCollection) => {
        items.forEach(item => {
          const data = this.treeManager.testData.get(item);
          if (data?.className && data?.testName) {
            const classId = data.classFqn || data.className;
            if (this.runCoordinator.lastFailedTests.has(`${classId}#${data.testName}`)) {
              failedItems.push(item);
            }
          }
          if (item.children.size > 0) {
            findFailedItems(item.children);
          }
        });
      };
      findFailedItems(this.controller.items);

      if (failedItems.length === 0) {
        vscode.window.showInformationMessage('Previously failed tests are no longer in the test tree.');
        return;
      }

      this.logger.appendLine(`SpockTestController: Re-running ${failedItems.length} failed test(s) via command`);
      const request = new vscode.TestRunRequest(failedItems, undefined, undefined);
      const tokenSource = new vscode.CancellationTokenSource();
      await this.runCoordinator.runHandler(false, request, tokenSource.token);
      tokenSource.dispose();
    });

    context.subscriptions.push(reloadCommand, rerunFailedCommand);
  }
}
