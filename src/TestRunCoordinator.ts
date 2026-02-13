import * as vscode from 'vscode';
import { IBuildToolService, BuildToolService } from './services/BuildToolService';
import { ConfigurationService } from './services/ConfigurationService';
import { CoverageService } from './services/CoverageService';
import { DebugService } from './services/DebugService';
import { TestExecutionService } from './services/TestExecutionService';
import { TestResultParser } from './services/TestResultParser';
import { extractErrorForTest, hasErrorForTest } from './services/SpockErrorParser';
import { TestData, BuildTool } from './types';
import { TestTreeManager } from './TestTreeManager';
import { ResultProcessor } from './ResultProcessor';

/**
 * Orchestrates test execution: run profiles, batch execution, continuous run,
 * re-run-failed, progress reporting, and coverage collection.
 */
export class TestRunCoordinator {
  /**
   * Stores semantic keys (`className#testName`) of failing tests.
   * Using semantic keys instead of TestItem IDs ensures the set
   * survives tree rebuilds (where IDs change).
   */
  public lastFailedTests = new Set<string>();
  private debugService: DebugService;
  private notifiedBuildFailure = false;
  private notifiedCoverageMissing = false;

  constructor(
    private controller: vscode.TestController,
    private logger: vscode.LogOutputChannel,
    private testExecutionService: TestExecutionService,
    private testResultParser: TestResultParser,
    private coverageService: CoverageService,
    private treeManager: TestTreeManager,
    private resultProcessor: ResultProcessor,
    private buildToolService: IBuildToolService,
  ) {
    this.debugService = new DebugService(logger);
  }

  // ── Continuous run handler ─────────────────────────────────────────

  async continuousRunHandler(
    debug: boolean,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    coverage: boolean = false,
  ): Promise<void> {
    if (!request.continuous) {
      return this.runHandler(debug, request, token, coverage);
    }

    this.logger.appendLine('TestRunCoordinator: Continuous run started — tests will re-run on file changes');

    await this.runHandler(debug, request, token, coverage);

    if (token.isCancellationRequested) {
      return;
    }

    const watchers: vscode.FileSystemWatcher[] = [];
    const patterns = ['**/*.groovy', '**/*.java', '**/build.gradle', '**/build.gradle.kts', '**/pom.xml'];

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const debounceMs = 1000;
    let running = false;

    const triggerRun = () => {
      if (token.isCancellationRequested) {
        return;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested || running) {
          return;
        }
        running = true;
        this.logger.appendLine('TestRunCoordinator: Continuous run — file change detected, re-running tests...');
        try {
          await this.runHandler(debug, request, token, coverage);
        } finally {
          running = false;
        }
      }, debounceMs);
    };

    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        for (const pattern of patterns) {
          const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folder, pattern),
          );
          watcher.onDidChange(triggerRun);
          watcher.onDidCreate(triggerRun);
          watcher.onDidDelete(triggerRun);
          watchers.push(watcher);
        }
      }
    }

    token.onCancellationRequested(() => {
      this.logger.appendLine('TestRunCoordinator: Continuous run cancelled — disposing file watchers');
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      for (const watcher of watchers) {
        watcher.dispose();
      }
    });
  }

  // ── Tracking run wrapper ───────────────────────────────────────────

  createTrackingRun(run: vscode.TestRun): vscode.TestRun {
    const originalFailed = run.failed.bind(run);
    const originalPassed = run.passed.bind(run);
    const originalSkipped = run.skipped.bind(run);
    const originalErrored = run.errored.bind(run);
    const self = this;

    const semanticKey = (test: vscode.TestItem): string | undefined => {
      const data = self.treeManager.testData.get(test);
      if (data?.className && data?.testName) {
        return `${data.className}#${data.testName}`;
      }
      return undefined;
    };

    run.failed = function (test: vscode.TestItem, message: vscode.TestMessage | readonly vscode.TestMessage[], duration?: number) {
      const key = semanticKey(test);
      if (key) { self.lastFailedTests.add(key); }
      return originalFailed(test, message, duration);
    };

    run.passed = function (test: vscode.TestItem, duration?: number) {
      const key = semanticKey(test);
      if (key) { self.lastFailedTests.delete(key); }
      return originalPassed(test, duration);
    };

    run.skipped = function (test: vscode.TestItem) {
      const key = semanticKey(test);
      if (key) { self.lastFailedTests.delete(key); }
      return originalSkipped(test);
    };

    run.errored = function (test: vscode.TestItem, message: vscode.TestMessage | readonly vscode.TestMessage[], duration?: number) {
      const key = semanticKey(test);
      if (key) { self.lastFailedTests.delete(key); }
      return originalErrored(test, message, duration);
    };

    return run;
  }

  // ── Re-run failed handler ──────────────────────────────────────────

  async rerunFailedHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    if (this.lastFailedTests.size === 0) {
      this.logger.appendLine('TestRunCoordinator: Re-run Failed — no failed tests to re-run');
      vscode.window.showInformationMessage('No failed tests to re-run.');
      return;
    }

    this.logger.appendLine(`TestRunCoordinator: Re-run Failed — ${this.lastFailedTests.size} failed test(s) from last run`);

    const failedItems: vscode.TestItem[] = [];
    const matchesFailedKey = (item: vscode.TestItem): boolean => {
      const data = this.treeManager.testData.get(item);
      if (data?.className && data?.testName) {
        return this.lastFailedTests.has(`${data.className}#${data.testName}`);
      }
      return false;
    };

    const findFailedItems = (items: vscode.TestItemCollection) => {
      items.forEach(item => {
        if (matchesFailedKey(item)) {
          failedItems.push(item);
        }
        if (item.children.size > 0) {
          findFailedItems(item.children);
        }
      });
    };

    if (request.include) {
      for (const item of request.include) {
        if (matchesFailedKey(item)) {
          failedItems.push(item);
        }
        if (item.children.size > 0) {
          findFailedItems(item.children);
        }
      }
    } else {
      findFailedItems(this.controller.items);
    }

    if (failedItems.length === 0) {
      this.logger.appendLine('TestRunCoordinator: Re-run Failed — failed tests no longer exist in tree');
      vscode.window.showInformationMessage('Previously failed tests are no longer in the test tree.');
      return;
    }

    this.logger.appendLine(`TestRunCoordinator: Re-run Failed — re-running ${failedItems.length} test(s)`);

    const filteredRequest = new vscode.TestRunRequest(failedItems, request.exclude, request.profile);
    return this.runHandler(false, filteredRequest, token);
  }

  // ── Main run handler ───────────────────────────────────────────────

  async runHandler(
    debug: boolean,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    coverage: boolean = false,
  ): Promise<void> {
    this.notifiedBuildFailure = false;
    this.notifiedCoverageMissing = false;

    const run = this.controller.createTestRun(request);
    const trackingRun = this.createTrackingRun(run);

    this.logger.appendLine(`TestRunCoordinator: runHandler called. debug=${debug}, coverage=${coverage}`);
    this.logger.appendLine(`TestRunCoordinator: request.include=${request.include ? request.include.length + ' items' : 'undefined (run all)'}`);
    if (request.include) {
      for (const item of request.include) {
        const d = this.treeManager.testData.get(item);
        this.logger.appendLine(`TestRunCoordinator:   include item: id=${item.id}, label=${item.label}, type=${d?.type}, className=${d?.className}, testName=${d?.testName}`);
      }
    }

    // Phase 1: Collect all leaf test items
    const leafTests: Array<{test: vscode.TestItem; data: TestData}> = [];
    const queue: vscode.TestItem[] = [];

    if (request.include) {
      request.include.forEach(test => queue.push(test));
    } else {
      this.controller.items.forEach(test => queue.push(test));
    }

    while (queue.length > 0 && !token.isCancellationRequested) {
      const test = queue.pop()!;

      if (request.exclude?.includes(test)) {
        continue;
      }

      const data = this.treeManager.testData.get(test);
      if (!data) {
        continue;
      }

      switch (data.type) {
        case 'project':
          test.children.forEach(child => queue.push(child));
          break;
        case 'subproject':
          test.children.forEach(child => queue.push(child));
          break;
        case 'package':
          test.children.forEach(child => queue.push(child));
          break;
        case 'file':
          if (test.children.size === 0) {
            await this.treeManager.discoverTestsInFile(test);
          }
          test.children.forEach(child => queue.push(child));
          break;
        case 'class':
          test.children.forEach(child => queue.push(child));
          break;
        case 'test':
          if (test.tags.some(t => t.id === 'runnable')) {
            leafTests.push({test, data});
          } else {
            trackingRun.skipped(test);
          }
          break;
      }
    }

    if (token.isCancellationRequested || leafTests.length === 0) {
      trackingRun.end();
      return;
    }

    // Phase 2: Group by project root
    const groups = new Map<string, Array<{test: vscode.TestItem; data: TestData}>>();

    for (const item of leafTests) {
      if (!item.test.uri) { continue; }
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(item.test.uri);
      if (!workspaceFolder) { continue; }

      const projectRoot = await this.buildToolService.findProjectRoot(item.test.uri.fsPath, workspaceFolder.uri.fsPath);
      if (!projectRoot) { continue; }

      if (!groups.has(projectRoot)) { groups.set(projectRoot, []); }
      groups.get(projectRoot)!.push(item);
    }

    // Phase 3: Execute each group
    const totalTests = leafTests.length;
    let completedTests = 0;
    let lastReportedPct = 0;
    const runDebugPort = await this.resolveRunDebugPort(debug);
    const runCancellationSource = new vscode.CancellationTokenSource();
    const upstreamCancellation = token.onCancellationRequested(() => runCancellationSource.cancel());

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Running Spock Tests',
          cancellable: true,
        },
        async (progress, progressToken) => {
          const progressCancellation = progressToken.onCancellationRequested(() => {
            this.logger.appendLine('TestRunCoordinator: Run cancelled from progress notification');
            runCancellationSource.cancel();
          });

          try {
            progress.report({ message: `0 / ${totalTests} tests`, increment: 0 });

            for (const [projectRoot, tests] of groups) {
              if (runCancellationSource.token.isCancellationRequested) { break; }
              await this.runBatch(projectRoot, tests, trackingRun, debug, runCancellationSource.token, coverage, runDebugPort);
              completedTests += tests.length;
              const pct = Math.round((completedTests / totalTests) * 100);
              const delta = pct - lastReportedPct;
              lastReportedPct = pct;
              progress.report({ message: `${completedTests} / ${totalTests} tests`, increment: delta });
            }
          } finally {
            progressCancellation.dispose();
          }
        },
      );
    } finally {
      upstreamCancellation.dispose();
      runCancellationSource.dispose();
    }

    trackingRun.end();
  }

  // ── Batch execution ────────────────────────────────────────────────

  async runBatch(
    projectRoot: string,
    tests: Array<{test: vscode.TestItem; data: TestData}>,
    run: vscode.TestRun,
    debug: boolean,
    token: vscode.CancellationToken,
    coverage: boolean = false,
    debugPort?: number,
  ): Promise<void> {
    const start = Date.now();

    // Detect build tool & project layout
    const { buildTool, rootProject, subprojectPrefix } =
      await this.detectProjectLayout(projectRoot);

    for (const {test} of tests) {
      run.started(test);
    }

    // Build test filters & lookup table
    const { testFilters, testLookup } = this.buildTestLookup(tests);

    if (testFilters.length === 0) {
      this.logger.appendLine('TestRunCoordinator: No valid test filters, skipping batch');
      for (const {test} of tests) {
        run.skipped(test);
      }
      return;
    }

    // Compute per-class method counts from the full test tree for wildcard coalescing
    const classTestCounts = this.buildClassTestCounts(tests);

    // For Gradle, check if sub-batching is needed to avoid command-line-too-long
    if (buildTool === 'gradle') {
      await this.runGradleBatchWithSplitting(
        testFilters, classTestCounts, testLookup, tests,
        debug, rootProject, subprojectPrefix, coverage, buildTool,
        run, token, start, projectRoot, debugPort,
      );
    } else {
      // Maven: single batch (uses compact -Dtest= filter)
      await this.runSingleBatch(
        testFilters, testLookup, tests,
        debug, rootProject, subprojectPrefix, coverage, buildTool,
        run, token, start, projectRoot, debugPort,
      );
    }
  }

  /**
   * Run Gradle tests, automatically splitting into sub-batches if the
   * estimated command-line length would exceed the OS limit.
   */
  private async runGradleBatchWithSplitting(
    testFilters: string[],
    classTestCounts: Map<string, number>,
    testLookup: Map<string, {test: vscode.TestItem; data: TestData; resolved: boolean}>,
    tests: Array<{test: vscode.TestItem; data: TestData}>,
    debug: boolean,
    rootProject: string,
    subprojectPrefix: string | undefined,
    coverage: boolean,
    buildTool: BuildTool,
    run: vscode.TestRun,
    token: vscode.CancellationToken,
    start: number,
    projectRoot: string,
    debugPort?: number,
  ): Promise<void> {
    // Build a "probe" command to get the base args (without --tests entries)
    const probeArgs = await this.buildToolService.buildBatchCommandArgs(
      [], debug, rootProject, this.logger, subprojectPrefix, coverage, buildTool, debugPort,
    );

    // Apply wildcard coalescing first (reduces filter count significantly)
    const coalesced = BuildToolService.coalesceGradleFilters(testFilters, classTestCounts, this.logger);

    // Split into sub-batches based on estimated command-line length
    const batches = BuildToolService.splitGradleTestFilters(coalesced, probeArgs);

    if (batches.length > 1) {
      this.logger.appendLine(
        `TestRunCoordinator: Command line too long — splitting ${coalesced.length} filters into ${batches.length} sub-batches`,
      );
    }

    let combinedResult = { success: true, output: '' };

    for (let i = 0; i < batches.length; i++) {
      if (token.isCancellationRequested) { break; }

      const batchFilters = batches[i];
      const commandArgs = await this.buildToolService.buildBatchCommandArgs(
        batchFilters, debug, rootProject, this.logger, subprojectPrefix, coverage, buildTool,
        debugPort, classTestCounts,
      );

      if (batches.length > 1) {
        this.logger.appendLine(`TestRunCoordinator: Running sub-batch ${i + 1}/${batches.length} (${batchFilters.length} filters)`);
      }
      this.logger.appendLine(`TestRunCoordinator: Running batch of ${tests.length} test(s) in ${projectRoot}${coverage ? ' (with coverage)' : ''}`);
      this.logger.appendLine(`TestRunCoordinator: Build tool: ${buildTool}, root project: ${rootProject}`);
      this.logger.appendLine(`TestRunCoordinator: Command: ${commandArgs.join(' ')}`);
      this.logger.appendLine(`TestRunCoordinator: Test filters: ${JSON.stringify(batchFilters)}`);

      const result = await this.testExecutionService.executeBatch({
        commandArgs,
        workspacePath: rootProject,
        run,
        testItems: tests.map(t => t.test),
        debug,
        debugPort,
        token,
        onOutputLine: (line: string) => this.handleRealTimeOutputLine(line, testLookup, run, start),
      });

      // Merge results
      combinedResult.output += result.output + '\n';
      if (!result.success) {
        combinedResult.success = false;
      }
    }

    if (token.isCancellationRequested) {
      for (const [, entry] of testLookup) {
        if (!entry.resolved) {
          run.skipped(entry.test);
          entry.resolved = true;
        }
      }
      return;
    }

    const hasBuildFailureSignal = this.hasBuildFailureSignal(combinedResult.output);
    if (hasBuildFailureSignal) {
      this.notifyBuildFailure();
    }

    // Resolve remaining results through multiple strategies
    await this.resolveDataDrivenResults(testLookup, combinedResult, run, projectRoot, buildTool, start);
    await this.resolveViaXmlReports(testLookup, run, projectRoot, buildTool, start, hasBuildFailureSignal, combinedResult.output);
    this.resolveFinalFallback(testLookup, combinedResult, run, start, hasBuildFailureSignal);

    // Attach coverage data
    if (coverage) {
      await this.attachCoverageData(rootProject, run);
    }
  }

  /**
   * Run a single batch (no splitting). Used for Maven and small Gradle batches.
   */
  private async runSingleBatch(
    testFilters: string[],
    testLookup: Map<string, {test: vscode.TestItem; data: TestData; resolved: boolean}>,
    tests: Array<{test: vscode.TestItem; data: TestData}>,
    debug: boolean,
    rootProject: string,
    subprojectPrefix: string | undefined,
    coverage: boolean,
    buildTool: BuildTool,
    run: vscode.TestRun,
    token: vscode.CancellationToken,
    start: number,
    projectRoot: string,
    debugPort?: number,
  ): Promise<void> {
    // Execute tests
    const commandArgs = await this.buildToolService.buildBatchCommandArgs(
      testFilters, debug, rootProject, this.logger, subprojectPrefix, coverage, buildTool,
      debugPort,
    );

    this.logger.appendLine(`TestRunCoordinator: Running batch of ${tests.length} test(s) in ${projectRoot}${coverage ? ' (with coverage)' : ''}`);
    this.logger.appendLine(`TestRunCoordinator: Build tool: ${buildTool}, root project: ${rootProject}`);
    this.logger.appendLine(`TestRunCoordinator: Command: ${commandArgs.join(' ')}`);
    this.logger.appendLine(`TestRunCoordinator: Test filters: ${JSON.stringify(testFilters)}`);

    const result = await this.testExecutionService.executeBatch({
      commandArgs,
      workspacePath: rootProject,
      run,
      testItems: tests.map(t => t.test),
      debug,
      debugPort,
      token,
      onOutputLine: (line: string) => this.handleRealTimeOutputLine(line, testLookup, run, start),
    });

    if (token.isCancellationRequested) {
      for (const [, entry] of testLookup) {
        if (!entry.resolved) {
          run.skipped(entry.test);
          entry.resolved = true;
        }
      }
      return;
    }

    const hasBuildFailureSignal = this.hasBuildFailureSignal(result.output);
    if (hasBuildFailureSignal) {
      this.notifyBuildFailure();
    }

    // Resolve remaining results through multiple strategies
    await this.resolveDataDrivenResults(testLookup, result, run, projectRoot, buildTool, start);
    await this.resolveViaXmlReports(testLookup, run, projectRoot, buildTool, start, hasBuildFailureSignal, result.output);
    this.resolveFinalFallback(testLookup, result, run, start, hasBuildFailureSignal);

    // Attach coverage data
    if (coverage) {
      await this.attachCoverageData(rootProject, run);
    }
  }

  // ── runBatch helpers ───────────────────────────────────────────────

  private async detectProjectLayout(projectRoot: string): Promise<{
    buildTool: BuildTool;
    rootProject: string;
    subprojectPrefix: string | undefined;
  }> {
    const buildTool: BuildTool = await this.buildToolService.detectBuildTool(projectRoot) || 'gradle';

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot))
      ?? vscode.workspace.workspaceFolders?.[0];
    const rootProject = workspaceFolder
      ? await this.buildToolService.findRootProject(projectRoot, workspaceFolder.uri.fsPath)
      : projectRoot;

    const subprojectPrefix = buildTool === 'gradle'
      ? this.buildToolService.getSubprojectPrefix(rootProject, projectRoot)
      : this.buildToolService.getMavenModuleName(rootProject, projectRoot);

    if (subprojectPrefix) {
      this.logger.appendLine(`TestRunCoordinator: Multi-module detected — root: ${rootProject}, ${buildTool === 'gradle' ? 'subproject prefix' : 'module name'}: ${subprojectPrefix}`);
    }

    return { buildTool, rootProject, subprojectPrefix };
  }

  private buildTestLookup(tests: Array<{test: vscode.TestItem; data: TestData}>): {
    testFilters: string[];
    testLookup: Map<string, {test: vscode.TestItem; data: TestData; resolved: boolean}>;
  } {
    const testFilters: string[] = [];
    const testLookup = new Map<string, {test: vscode.TestItem; data: TestData; resolved: boolean}>();

    for (const item of tests) {
      if (item.data.className && item.data.testName) {
        testFilters.push(`${item.data.className}.${item.data.testName}`);
        const key = `${item.data.className}#${item.data.testName}`;
        testLookup.set(key, {...item, resolved: false});
      } else {
        this.logger.appendLine(`TestRunCoordinator: Skipping test with missing className=${item.data.className} testName=${item.data.testName}`);
      }
    }

    return { testFilters, testLookup };
  }

  /**
   * Build a map of `className → number of test methods` by inspecting
   * the parent class nodes of the selected tests.  This is used for
   * wildcard coalescing: when all methods of a class are selected we
   * can emit `--tests "ClassName.*"` instead of one `--tests` per method.
   */
  private buildClassTestCounts(
    tests: Array<{test: vscode.TestItem; data: TestData}>,
  ): Map<string, number> {
    const counts = new Map<string, number>();

    // Walk selected tests and inspect their parent (the class node)
    // to count total children.
    const visitedClasses = new Set<string>();

    for (const { test, data } of tests) {
      if (!data.className || visitedClasses.has(data.className)) {
        continue;
      }

      // The parent of a 'test' node is normally its class node
      const classNode = test.parent;
      if (classNode) {
        let methodCount = 0;
        classNode.children.forEach(() => { methodCount++; });
        counts.set(data.className, methodCount);
        visitedClasses.add(data.className);
      }
    }

    return counts;
  }

  private handleRealTimeOutputLine(
    line: string,
    testLookup: Map<string, {test: vscode.TestItem; data: TestData; resolved: boolean}>,
    run: vscode.TestRun,
    start: number,
  ): void {
    const gradleMatch = line.match(/^\s*(\S+)\s+>\s+(.+?)\s+(PASSED|FAILED|SKIPPED)\s*$/);
    if (!gradleMatch) { return; }

    const className = gradleMatch[1];
    const testPart = gradleMatch[2].trim();
    const status = gradleMatch[3];

    if (testPart.includes(' > ') || /\[.*#\d+\]$/.test(testPart)) {
      return;
    }

    // Try FQN key first (e.g. "com.example.CalculatorSpec#test name"),
    // then fall back to simple class name (e.g. "CalculatorSpec#test name")
    // because the test tree stores simple names while Gradle outputs FQN.
    const key = `${className}#${testPart}`;
    let entry = testLookup.get(key);
    if (!entry) {
      const simpleName = className.includes('.') ? className.substring(className.lastIndexOf('.') + 1) : undefined;
      if (simpleName) {
        entry = testLookup.get(`${simpleName}#${testPart}`);
      }
    }

    if (entry && !entry.resolved && !entry.data.isDataDriven) {
      entry.resolved = true;
      if (status === 'PASSED') {
        run.passed(entry.test, Date.now() - start);
      } else if (status === 'FAILED') {
        entry.resolved = false;
      } else {
        run.skipped(entry.test);
      }
    }
  }

  private async resolveDataDrivenResults(
    testLookup: Map<string, {test: vscode.TestItem; data: TestData; resolved: boolean}>,
    result: any,
    run: vscode.TestRun,
    projectRoot: string,
    buildTool: BuildTool,
    start: number,
  ): Promise<void> {
    for (const [, entry] of testLookup) {
      if (entry.data.isDataDriven && !entry.resolved) {
        try {
          await this.resultProcessor.handleDataDrivenTestResults(entry.test, entry.data, result, run, projectRoot, buildTool, start);
          entry.resolved = true;
        } catch (error) {
          this.logger.appendLine(`TestRunCoordinator: Error handling data-driven results: ${error}`);
        }
      }
    }
  }

  private async resolveViaXmlReports(
    testLookup: Map<string, {test: vscode.TestItem; data: TestData; resolved: boolean}>,
    run: vscode.TestRun,
    projectRoot: string,
    buildTool: BuildTool,
    start: number,
    hasBuildFailureSignal: boolean,
    output: string,
  ): Promise<void> {
    if (hasBuildFailureSignal) {
      this.logger.appendLine('TestRunCoordinator: Build failure detected — ignoring XML reports for unresolved tests');
      return;
    }

    const unresolvedClasses = new Set<string>();
    for (const [, entry] of testLookup) {
      if (!entry.resolved && entry.data.className) {
        unresolvedClasses.add(entry.data.className);
      }
    }

    for (const className of unresolvedClasses) {
      const xmlResults = await this.testResultParser.parseClassTestResults(projectRoot, className, buildTool);
      for (const [, entry] of testLookup) {
        if (!entry.resolved && entry.data.className === className && entry.data.testName) {
          const xmlResult = xmlResults.get(entry.data.testName);
          if (xmlResult) {
            entry.resolved = true;
            if (xmlResult.skipped) {
              run.skipped(entry.test);
            } else if (xmlResult.success) {
              run.passed(entry.test, Date.now() - start);
            } else {
              const xmlError = xmlResult.errorMessage?.trim();
              const consoleFallback = extractErrorForTest(output, entry.data.className, entry.data.testName);
              const fallbackError = consoleFallback !== 'Test failed'
                ? consoleFallback
                : `${entry.data.className}.${entry.data.testName} FAILED`;
              const finalError = xmlError && xmlError !== 'Test failed' ? xmlError : fallbackError;
              run.failed(entry.test, this.resultProcessor.createTestMessage(finalError, xmlResult.diff), Date.now() - start);
            }
          }
        }
      }
    }
  }

  private resolveFinalFallback(
    testLookup: Map<string, {test: vscode.TestItem; data: TestData; resolved: boolean}>,
    result: any,
    run: vscode.TestRun,
    start: number,
    hasBuildFailureSignal: boolean,
  ): void {
    for (const [, entry] of testLookup) {
      if (!entry.resolved) {
        if (result.success) {
          // Overall batch passed — all unresolved tests must have passed
          run.passed(entry.test, Date.now() - start);
        } else {
          // Batch failed — check if THIS SPECIFIC test failed, not just the class.
          // hasErrorForClass is too broad: it returns true for all tests in a class
          // even if only one test failed. We need per-test granularity.
          const testError = hasErrorForTest(result.output, entry.data.className!, entry.data.testName!);
          if (testError) {
            const errorMessage = extractErrorForTest(result.output, entry.data.className!, entry.data.testName!);
            run.failed(entry.test, this.resultProcessor.createTestMessage(errorMessage), Date.now() - start);
          } else if (hasBuildFailureSignal) {
            const buildFailureMessage = this.extractBuildFailureMessage(result.output);
            run.errored(
              entry.test,
              this.resultProcessor.createTestMessage(buildFailureMessage),
              Date.now() - start,
            );
          } else {
            // Batch failed but we have no per-test failure and no build signal.
            // Treat this as errored (execution uncertainty), never as passed.
            const fallbackMsg = this.extractBuildFailureMessage(result.output);
            const unresolvedMessage = fallbackMsg && !fallbackMsg.startsWith('Build failed')
              ? fallbackMsg
              : 'Test execution failed before the result for this test could be determined.';
            run.errored(entry.test, this.resultProcessor.createTestMessage(unresolvedMessage), Date.now() - start);
          }
        }
      }
    }
  }

  private hasBuildFailureSignal(output: string): boolean {
    if (!output) {
      return false;
    }

    return (
      /\bBUILD FAILED\b/i.test(output)
      || /\bBUILD FAILURE\b/i.test(output)
      || /Execution failed for task\s+['"]?:[^'"\s]+['"]?/i.test(output)
      || /\bCompilation failed; see the compiler error output for details\b/i.test(output)
      || /\bCOMPILATION ERROR\b/i.test(output)
      || /^\s*\[ERROR\]\s+Failed to execute goal\s+/im.test(output)
      || /^\s*>\s*Task\s+:[^\n\r]+\s+FAILED\s*$/im.test(output)
    );
  }

  private extractBuildFailureMessage(output: string): string {
    if (!output) {
      return 'Build failed (no details available in output).';
    }

    const rawLines = output.split('\n');
    const collected: string[] = [];

    // Noise = boilerplate lines that never carry useful diagnostic info.
    // Everything else is kept.
    const isNoiseLine = (line: string): boolean => {
      const t = line.trim();
      if (!t) { return true; }
      // Generic Gradle hints
      if (/^>?\s*Compilation failed; see the compiler error output for details\.?$/i.test(t)) { return true; }
      if (/^\* Try:/i.test(t)) { return true; }
      if (/^\* Get more help/i.test(t)) { return true; }
      if (/^>\s*Run with\s+--/i.test(t)) { return true; }
      if (/^Deprecated Gradle features/i.test(t)) { return true; }
      if (/^BUILD (FAILED|SUCCESSFUL)\b/i.test(t)) { return true; }
      if (/^FAILURE:\s+Build failed with an exception\.?\s*$/i.test(t)) { return true; }
      if (/^>\s*Task\s+:[^\s]+\s+FAILED\s*$/i.test(t)) { return true; }
      if (/^\d+ actionable task/i.test(t)) { return true; }
      if (/^BUILD FAILED in\s+/i.test(t)) { return true; }
      // Maven boilerplate
      if (/^\[ERROR\]\s+BUILD FAILURE\s*$/i.test(t)) { return true; }
      if (/^\[ERROR\]\s+COMPILATION ERROR\s*:?\s*$/i.test(t)) { return true; }
      if (/^\[ERROR\]\s+Tests run:/i.test(t)) { return true; }
      if (/^\[ERROR\]\s+There are test failures\.?$/i.test(t)) { return true; }
      if (/^\[ERROR\]\s+Please refer to\s+/i.test(t)) { return true; }
      if (/^\[ERROR\]\s+Re-run Maven using the\s+/i.test(t)) { return true; }
      if (/^\[ERROR\]\s+Failed to execute goal\s+/i.test(t)) { return true; }
      if (/^\[ERROR\]\s+->\s+\[Help /i.test(t)) { return true; }
      if (/^\[ERROR\]\s+For more information/i.test(t)) { return true; }
      // Standard log prefixes that are never diagnostics
      if (/^\[INFO\]/i.test(t)) { return true; }
      if (/^\[WARNING\]/i.test(t)) { return true; }
      if (/^\[DEBUG\]/i.test(t)) { return true; }
      // Test result summary lines
      if (/^\S+\s+>\s+\S+.*\s+(PASSED|SKIPPED)\s*$/i.test(t)) { return true; }
      return false;
    };

    for (const line of rawLines) {
      if (!isNoiseLine(line)) {
        collected.push(line.trim());
      }
    }

    // Limit stack trace depth: keep at most 3 'at ...' lines per block
    const trimmed = this.trimStackTraceDepth(collected, 3);

    if (trimmed.length > 0) {
      // Cap at ~25 lines to avoid overwhelming the UI
      return trimmed.slice(0, 25).join('\n');
    }

    return 'Build failed (no details available in output).';
  }

  private trimStackTraceDepth(lines: string[], maxPerBlock: number): string[] {
    const result: string[] = [];
    let consecutiveAt = 0;
    for (const line of lines) {
      if (/^\s*at\s+/.test(line)) {
        consecutiveAt++;
        if (consecutiveAt <= maxPerBlock) {
          result.push(line);
        } else if (consecutiveAt === maxPerBlock + 1) {
          result.push('  ...');
        }
      } else {
        consecutiveAt = 0;
        result.push(line);
      }
    }
    return result;
  }

  private async attachCoverageData(rootProject: string, run: vscode.TestRun): Promise<void> {
    this.logger.appendLine('TestRunCoordinator: Parsing JaCoCo coverage reports...');
    const reports = await this.coverageService.findAllJacocoXmlReports(rootProject);
    let totalEntries = 0;
    for (const { xmlPath, projectRoot: projRoot } of reports) {
      const fileCoverages = await this.coverageService.parseJacocoReport(xmlPath, projRoot);
      for (const fc of fileCoverages) {
        run.addCoverage(fc);
      }
      totalEntries += fileCoverages.length;
    }
    if (totalEntries > 0) {
      this.logger.appendLine(`TestRunCoordinator: Added ${totalEntries} file coverage entries from ${reports.length} report(s)`);
    } else {
      this.logger.appendLine('TestRunCoordinator: No JaCoCo XML reports found — coverage data unavailable');
      if (!this.notifiedCoverageMissing) {
        this.notifiedCoverageMissing = true;
        void vscode.window.showInformationMessage(
          'Spock Test Runner: Coverage data is unavailable because no JaCoCo XML report was found for this run.',
        );
      }
    }
  }

  private async resolveRunDebugPort(debug: boolean): Promise<number | undefined> {
    if (!debug) {
      return undefined;
    }

    const cfg = ConfigurationService.getConfig();
    try {
      const resolvedPort = await this.debugService.findFreePort(cfg.debugPort);
      if (resolvedPort !== cfg.debugPort) {
        void vscode.window.showInformationMessage(
          `Spock Test Runner: Preferred debug port ${cfg.debugPort} is in use; using ${resolvedPort} for this run.`,
        );
      }
      return resolvedPort;
    } catch (error) {
      this.logger.appendLine(`TestRunCoordinator: Could not find free debug port: ${error}`);
      void vscode.window.showWarningMessage(
        `Spock Test Runner: Could not find a free debug port near ${cfg.debugPort}; trying configured port ${cfg.debugPort}.`,
      );
      return cfg.debugPort;
    }
  }

  private notifyBuildFailure(): void {
    if (this.notifiedBuildFailure) {
      return;
    }
    this.notifiedBuildFailure = true;
    void vscode.window.showWarningMessage(
      'Spock Test Runner: Build failed before all test results were available. Some tests are marked as errored.',
    );
  }
}
