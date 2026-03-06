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
import { showInfoStatus, showWarningStatus } from './statusBar';

/** Entry tracked per test in the lookup map during a batch run. */
interface TestLookupEntry {
  test: vscode.TestItem;
  data: TestData;
  resolved: boolean;
  /** Status seen during real-time Gradle output parsing (`undefined` if never seen). */
  seenStatus?: TestExecutionStatus;
}

type TestExecutionStatus = 'PASSED' | 'FAILED' | 'SKIPPED';

interface RunBatchOptions {
  coverage?: boolean;
  debugPort?: number;
  runWholeProjectTask?: boolean;
}

interface BatchRunContext {
  testLookup: Map<string, TestLookupEntry>;
  tests: Array<{test: vscode.TestItem; data: TestData}>;
  debug: boolean;
  rootProject: string;
  subprojectPrefix?: string;
  coverage: boolean;
  buildTool: BuildTool;
  run: vscode.TestRun;
  token: vscode.CancellationToken;
  start: number;
  projectRoot: string;
  debugPort?: number;
  classTestCounts?: Map<string, number>;
}

const BUILD_FAILURE_NOISE_PATTERNS: RegExp[] = [
  /^>\s*Task\s+/i,
  /^>\s*Configure project\s+/i,
  /^>?\s*Compilation failed; see the compiler error output for details\.?$/i,
  /^\* Try:/i,
  /^\* Get more help/i,
  /^>\s*Run with\s+--/i,
  /^Deprecated Gradle features/i,
  /^BUILD (FAILED|SUCCESSFUL)\b/i,
  /^FAILURE:\s+Build failed with an exception\.?\s*$/i,
  /^\d+ actionable task/i,
  /^BUILD FAILED in\s+/i,
  /^\[ERROR\]\s+BUILD FAILURE\s*$/i,
  /^\[ERROR\]\s+COMPILATION ERROR\s*:?\s*$/i,
  /^\[ERROR\]\s+Tests run:/i,
  /^\[ERROR\]\s+There are test failures\.?$/i,
  /^\[ERROR\]\s+Please refer to\s+/i,
  /^\[ERROR\]\s+Re-run Maven using the\s+/i,
  /^\[ERROR\]\s+Failed to execute goal\s+/i,
  /^\[ERROR\]\s+->\s+\[Help /i,
  /^\[ERROR\]\s+For more information/i,
  /^\[INFO\]/i,
  /^\[WARNING\]/i,
  /^\[DEBUG\]/i,
  /^\S+\s+>\s+\S+.*\s+(PASSED|SKIPPED)\s*$/i,
  /Failed to map supported failure/i,
  /with mapper.*OpenTest/i,
];

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
  private readonly debugService: DebugService;
  private notifiedBuildFailure = false;
  private notifiedCoverageMissing = false;
  /** Buffers error lines after a FAILED marker so the failure can be
   *  reported with full error details as soon as the next test boundary
   *  arrives (or the batch ends). */
  private pendingFailure: {
    entry: TestLookupEntry;
    failedLine: string;
    errorLines: string[];
  } | null = null;

  constructor(
    private readonly controller: vscode.TestController,
    private readonly logger: vscode.LogOutputChannel,
    private readonly testExecutionService: TestExecutionService,
    private readonly testResultParser: TestResultParser,
    private readonly coverageService: CoverageService,
    private readonly treeManager: TestTreeManager,
    private readonly resultProcessor: ResultProcessor,
    private readonly buildToolService: IBuildToolService,
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

    const semanticKey = (test: vscode.TestItem): string | undefined => {
      const data = this.treeManager.testData.get(test);
      const classId = data?.classFqn || data?.className;
      if (classId && data?.testName) {
        return `${classId}#${data.testName}`;
      }
      return undefined;
    };

    run.failed = (test: vscode.TestItem, message: vscode.TestMessage | readonly vscode.TestMessage[], duration?: number) => {
      const key = semanticKey(test);
      if (key) { this.lastFailedTests.add(key); }
      return originalFailed(test, message, duration);
    };

    run.passed = (test: vscode.TestItem, duration?: number) => {
      const key = semanticKey(test);
      if (key) { this.lastFailedTests.delete(key); }
      return originalPassed(test, duration);
    };

    run.skipped = (test: vscode.TestItem) => {
      const key = semanticKey(test);
      if (key) { this.lastFailedTests.delete(key); }
      return originalSkipped(test);
    };

    run.errored = (test: vscode.TestItem, message: vscode.TestMessage | readonly vscode.TestMessage[], duration?: number) => {
      const key = semanticKey(test);
      if (key) { this.lastFailedTests.delete(key); }
      return originalErrored(test, message, duration);
    };

    return run;
  }

  // ── Re-run failed handler ──────────────────────────────────────────

  async rerunFailedHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    if (this.lastFailedTests.size === 0) {
      this.logger.appendLine('TestRunCoordinator: Re-run Failed — no failed tests to re-run');
      showInfoStatus('No failed tests to re-run.');
      return;
    }

    this.logger.appendLine(`TestRunCoordinator: Re-run Failed — ${this.lastFailedTests.size} failed test(s) from last run`);

    const failedItems: vscode.TestItem[] = [];
    const matchesFailedKey = (item: vscode.TestItem): boolean => {
      const data = this.treeManager.testData.get(item);
      if (data?.className && data?.testName) {
        const classId = data.classFqn || data.className;
        return this.lastFailedTests.has(`${classId}#${data.testName}`);
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
      showInfoStatus('Previously failed tests are no longer in the test tree.');
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

    const runWholeProjectTask = this.shouldRunWholeProjectTask(request);
    this.logger.appendLine(`TestRunCoordinator: whole-project fast path=${runWholeProjectTask}`);

    const leafTests = await this.collectLeafTests(request, token, trackingRun);

    if (token.isCancellationRequested || leafTests.length === 0) {
      trackingRun.end();
      return;
    }

    const groups = await this.groupLeafTestsByProject(leafTests, trackingRun);

    // Phase 3: Execute each group
    const totalTests = leafTests.length;
    const runDebugPort = await this.resolveRunDebugPort(debug);
    const runCancellationSource = new vscode.CancellationTokenSource();
    const upstreamCancellation = token.onCancellationRequested(() => runCancellationSource.cancel());

    try {
      await this.executeGroupsWithProgress(
        groups,
        trackingRun,
        totalTests,
        debug,
        runCancellationSource,
        { coverage, debugPort: runDebugPort, runWholeProjectTask },
      );
    } finally {
      upstreamCancellation.dispose();
      runCancellationSource.dispose();
    }

    trackingRun.end();
  }

  private async collectLeafTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    trackingRun: vscode.TestRun,
  ): Promise<Array<{test: vscode.TestItem; data: TestData}>> {
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

      await this.collectLeafTestsFromNode(test, data, queue, leafTests, trackingRun);
    }

    return leafTests;
  }

  private async collectLeafTestsFromNode(
    test: vscode.TestItem,
    data: TestData,
    queue: vscode.TestItem[],
    leafTests: Array<{test: vscode.TestItem; data: TestData}>,
    trackingRun: vscode.TestRun,
  ): Promise<void> {
    if (data.type === 'test') {
      if (test.tags.some(t => t.id === 'runnable')) {
        leafTests.push({ test, data });
      } else {
        trackingRun.skipped(test);
      }
      return;
    }

    if (data.type === 'file' && test.children.size === 0) {
      await this.treeManager.discoverTestsInFile(test);
    }

    test.children.forEach(child => queue.push(child));
  }

  private async groupLeafTestsByProject(
    leafTests: Array<{test: vscode.TestItem; data: TestData}>,
    trackingRun: vscode.TestRun,
  ): Promise<Map<string, { workspaceFolder: vscode.WorkspaceFolder; tests: Array<{test: vscode.TestItem; data: TestData}> }>> {
    const groups = new Map<string, {
      workspaceFolder: vscode.WorkspaceFolder;
      tests: Array<{test: vscode.TestItem; data: TestData}>;
    }>();

    for (const item of leafTests) {
      if (!item.test.uri) {
        continue;
      }
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(item.test.uri);
      if (!workspaceFolder) {
        this.logger.appendLine(`TestRunCoordinator: Unable to resolve workspace folder for test URI: ${item.test.uri.toString()}`);
        trackingRun.errored(item.test, new vscode.TestMessage('Unable to resolve workspace folder for this test in a multi-root workspace.'));
        continue;
      }

      const projectRoot = await this.buildToolService.findProjectRoot(item.test.uri.fsPath, workspaceFolder.uri.fsPath);
      if (!projectRoot) {
        this.logger.appendLine(`TestRunCoordinator: Unable to resolve project root for test file: ${item.test.uri.fsPath}`);
        trackingRun.errored(item.test, new vscode.TestMessage('Unable to resolve project root for this test.'));
        continue;
      }

      if (!groups.has(projectRoot)) {
        groups.set(projectRoot, { workspaceFolder, tests: [] });
      }
      groups.get(projectRoot)!.tests.push(item);
    }

    return groups;
  }

  private async executeGroupsWithProgress(
    groups: Map<string, { workspaceFolder: vscode.WorkspaceFolder; tests: Array<{test: vscode.TestItem; data: TestData}> }>,
    trackingRun: vscode.TestRun,
    totalTests: number,
    debug: boolean,
    runCancellationSource: vscode.CancellationTokenSource,
    runOptions: RunBatchOptions,
  ): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Running Spock Tests',
        cancellable: true,
      },
      async (progress, progressToken) => {
        let completedTests = 0;
        let lastReportedPct = 0;
        const completedTestIds = new Set<string>();

        const reportCompletedTest = (test: vscode.TestItem) => {
          if (completedTestIds.has(test.id)) {
            return;
          }
          completedTestIds.add(test.id);
          completedTests += 1;
          const pct = Math.round((completedTests / totalTests) * 100);
          const delta = pct - lastReportedPct;
          lastReportedPct = pct;
          progress.report({ message: `${completedTests} / ${totalTests} tests`, increment: Math.max(0, delta) });
        };

        const originalPassed = trackingRun.passed.bind(trackingRun);
        const originalFailed = trackingRun.failed.bind(trackingRun);
        const originalSkipped = trackingRun.skipped.bind(trackingRun);
        const originalErrored = trackingRun.errored.bind(trackingRun);

        trackingRun.passed = (test: vscode.TestItem, duration?: number) => {
          reportCompletedTest(test);
          return originalPassed(test, duration);
        };
        trackingRun.failed = (test: vscode.TestItem, message: vscode.TestMessage | readonly vscode.TestMessage[], duration?: number) => {
          reportCompletedTest(test);
          return originalFailed(test, message, duration);
        };
        trackingRun.skipped = (test: vscode.TestItem) => {
          reportCompletedTest(test);
          return originalSkipped(test);
        };
        trackingRun.errored = (test: vscode.TestItem, message: vscode.TestMessage | readonly vscode.TestMessage[], duration?: number) => {
          reportCompletedTest(test);
          return originalErrored(test, message, duration);
        };

        const progressCancellation = progressToken.onCancellationRequested(() => {
          this.logger.appendLine('TestRunCoordinator: Run cancelled from progress notification');
          runCancellationSource.cancel();
        });

        try {
          progress.report({ message: `0 / ${totalTests} tests`, increment: 0 });
          for (const [projectRoot, group] of groups) {
            if (runCancellationSource.token.isCancellationRequested) {
              break;
            }
            await this.runBatch(
              projectRoot,
              group.workspaceFolder,
              group.tests,
              trackingRun,
              debug,
              runCancellationSource.token,
              runOptions,
            );
          }
        } finally {
          trackingRun.passed = originalPassed;
          trackingRun.failed = originalFailed;
          trackingRun.skipped = originalSkipped;
          trackingRun.errored = originalErrored;
          progressCancellation.dispose();
        }
      },
    );
  }

  // ── Batch execution ────────────────────────────────────────────────

  async runBatch(
    projectRoot: string,
    workspaceFolder: vscode.WorkspaceFolder,
    tests: Array<{test: vscode.TestItem; data: TestData}>,
    run: vscode.TestRun,
    debug: boolean,
    token: vscode.CancellationToken,
    options: RunBatchOptions = {},
  ): Promise<void> {
    const { coverage = false, debugPort, runWholeProjectTask = false } = options;
    const start = Date.now();
    this.pendingFailure = null;

    // Detect build tool & project layout
    let buildTool: BuildTool;
    let rootProject: string;
    let subprojectPrefix: string | undefined;
    try {
      ({ buildTool, rootProject, subprojectPrefix } =
        await this.detectProjectLayout(projectRoot, workspaceFolder));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.appendLine(`TestRunCoordinator: Failed to detect project layout for ${projectRoot}: ${msg}`);
      for (const {test} of tests) {
        run.errored(test, new vscode.TestMessage(`Failed to detect project layout: ${msg}`));
      }
      return;
    }

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

    // Fast path for whole-project Gradle runs: invoke project test task without --tests filters.
    if (runWholeProjectTask && buildTool === 'gradle') {
      this.logger.appendLine('TestRunCoordinator: Execution mode = whole-project task (Gradle, no --tests filters)');
      this.logger.appendLine(`TestRunCoordinator: Execution target = ${this.getExecutionTarget(subprojectPrefix)} (root=${rootProject}, group=${projectRoot})`);
      await this.runSingleBatch(
        [],
        {
          testLookup,
          tests,
          debug,
          rootProject,
          subprojectPrefix,
          coverage,
          buildTool,
          run,
          token,
          start,
          projectRoot,
          debugPort,
        },
      );
      return;
    }

    this.logger.appendLine('TestRunCoordinator: Execution mode = filtered batch (explicit test filters)');
    this.logger.appendLine(`TestRunCoordinator: Execution target = ${this.getExecutionTarget(subprojectPrefix)} (root=${rootProject}, group=${projectRoot})`);

    // For Gradle, check if sub-batching is needed to avoid command-line-too-long
    if (buildTool === 'gradle') {
      await this.runGradleBatchWithSplitting(
        testFilters,
        {
          testLookup,
          tests,
          debug,
          rootProject,
          subprojectPrefix,
          coverage,
          buildTool,
          run,
          token,
          start,
          projectRoot,
          debugPort,
          classTestCounts,
        },
      );
    } else {
      // Maven: single batch (uses compact -Dtest= filter)
      await this.runSingleBatch(
        testFilters,
        {
          testLookup,
          tests,
          debug,
          rootProject,
          subprojectPrefix,
          coverage,
          buildTool,
          run,
          token,
          start,
          projectRoot,
          debugPort,
        },
      );
    }
  }

  private shouldRunWholeProjectTask(request: vscode.TestRunRequest): boolean {
    if (request.exclude && request.exclude.length > 0) {
      return false;
    }

    if (!request.include || request.include.length === 0) {
      return true;
    }

    return request.include.every(item => {
      const type = this.treeManager.testData.get(item)?.type;
      return type === 'project' || type === 'subproject';
    });
  }

  private getExecutionTarget(subprojectPrefix?: string): string {
    return subprojectPrefix ? `${subprojectPrefix}:test` : 'test';
  }

  /**
   * Run Gradle tests, automatically splitting into sub-batches if the
   * estimated command-line length would exceed the OS limit.
   */
  private async runGradleBatchWithSplitting(
    testFilters: string[],
    context: BatchRunContext,
  ): Promise<void> {
    const {
      classTestCounts = new Map<string, number>(),
      testLookup,
      debug,
      rootProject,
      subprojectPrefix,
      coverage,
      buildTool,
      run,
      token,
      start,
      projectRoot,
      debugPort,
    } = context;
    // Build a "probe" command to get the base args (without --tests entries)
    const probeArgs = await this.buildToolService.buildBatchCommandArgs(
      [], debug, rootProject, this.logger, subprojectPrefix, { coverage, buildTool, debugPort },
    );

    // Apply wildcard coalescing first (reduces filter count significantly)
    const coalesced = BuildToolService.coalesceGradleFilters(testFilters, classTestCounts, this.logger);

    // Split into sub-batches based on estimated command-line length
    const batches = BuildToolService.splitGradleTestFilters(coalesced, probeArgs);

    if (batches.length > 1) {
      this.logger.appendLine(
        `TestRunCoordinator: Command line too long — splitting ${coalesced.length} filters into ${batches.length} sub-batches`,
      );
      this.logger.appendLine('TestRunCoordinator: Execution mode detail = filtered batch (split into sub-batches)');
    }

    let combinedResult = { success: true, output: '' };

    for (let i = 0; i < batches.length; i++) {
      if (token.isCancellationRequested) { break; }

      const batchFilters = batches[i];
      const result = await this.executeGradleSubBatch({
        batchFilters,
        batchIndex: i,
        batchCount: batches.length,
        context,
      });

      // Flush the last pending failure from this sub-batch
      this.flushPendingFailure(run, start);

      // Merge results
      combinedResult.output += result.output + '\n';
      if (!result.success) {
        combinedResult.success = false;
      }
    }

    if (token.isCancellationRequested) {
      this.markUnresolvedAsSkipped(testLookup, run);
      return;
    }

    await this.finalizeBatchResults(
      testLookup,
      combinedResult,
      run,
      projectRoot,
      buildTool,
      start,
      combinedResult.output,
    );

    // Attach coverage data
    if (coverage) {
      await this.attachCoverageData(rootProject, run);
    }
  }

  private async executeGradleSubBatch(args: {
    batchFilters: string[];
    batchIndex: number;
    batchCount: number;
    context: BatchRunContext;
  }): Promise<{ success: boolean; output: string }> {
    const { batchFilters, batchIndex, batchCount, context } = args;
    const { testLookup, tests, debug, rootProject, subprojectPrefix, coverage, buildTool, run, token, start, projectRoot, debugPort, classTestCounts } = context;
    const commandArgs = await this.buildToolService.buildBatchCommandArgs(
      batchFilters,
      debug,
      rootProject,
      this.logger,
      subprojectPrefix,
      { coverage, buildTool, debugPort, classTestCounts },
    );

    if (batchCount > 1) {
      this.logger.appendLine(`TestRunCoordinator: Running sub-batch ${batchIndex + 1}/${batchCount} (${batchFilters.length} filters)`);
    }
    this.logger.appendLine(`TestRunCoordinator: Running batch of ${tests.length} test(s) in ${projectRoot}${coverage ? ' (with coverage)' : ''}`);
    this.logger.appendLine(`TestRunCoordinator: Build tool: ${buildTool}, root project: ${rootProject}`);
    this.logger.appendLine(`TestRunCoordinator: Command: ${commandArgs.join(' ')}`);
    this.logger.appendLine(`TestRunCoordinator: Test filters: ${JSON.stringify(batchFilters)}`);

    return this.testExecutionService.executeBatch({
      commandArgs,
      workspacePath: rootProject,
      run,
      testItems: tests.map((t) => t.test),
      debug,
      debugPort,
      token,
      onOutputLine: (line: string) => this.handleRealTimeOutputLine(line, testLookup, run, start),
    });
  }

  private markUnresolvedAsSkipped(testLookup: Map<string, TestLookupEntry>, run: vscode.TestRun): void {
    for (const [, entry] of testLookup) {
      if (!entry.resolved) {
        run.skipped(entry.test);
        entry.resolved = true;
      }
    }
  }

  private async finalizeBatchResults(
    testLookup: Map<string, TestLookupEntry>,
    result: { success: boolean; output: string },
    run: vscode.TestRun,
    projectRoot: string,
    buildTool: BuildTool,
    start: number,
    output: string,
  ): Promise<void> {
    const hasBuildFailureSignal = this.hasBuildFailureSignal(output);
    if (hasBuildFailureSignal) {
      this.notifyBuildFailure();
    }

    await this.resolveDataDrivenResults(
      testLookup,
      result,
      run,
      { projectRoot, buildTool, start, hasBuildFailureSignal, output },
    );
    await this.resolveViaXmlReports(testLookup, run, projectRoot, buildTool, start, hasBuildFailureSignal, output);
    this.resolveFinalFallback(testLookup, result, run, start, hasBuildFailureSignal);
  }

  /**
   * Run a single batch (no splitting). Used for Maven and small Gradle batches.
   */
  private async runSingleBatch(
    testFilters: string[],
    context: BatchRunContext,
  ): Promise<void> {
    const {
      classTestCounts,
      testLookup,
      tests,
      debug,
      rootProject,
      subprojectPrefix,
      coverage,
      buildTool,
      run,
      token,
      start,
      projectRoot,
      debugPort,
    } = context;
    // Execute tests
    const commandArgs = await this.buildToolService.buildBatchCommandArgs(
      testFilters, debug, rootProject, this.logger, subprojectPrefix,
      { coverage, buildTool, debugPort, classTestCounts },
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

    // Flush the last pending failure from this batch
    this.flushPendingFailure(run, start);

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
    await this.resolveDataDrivenResults(
      testLookup,
      result,
      run,
      { projectRoot, buildTool, start, hasBuildFailureSignal, output: result.output },
    );
    await this.resolveViaXmlReports(testLookup, run, projectRoot, buildTool, start, hasBuildFailureSignal, result.output);
    this.resolveFinalFallback(testLookup, result, run, start, hasBuildFailureSignal);

    // Attach coverage data
    if (coverage) {
      await this.attachCoverageData(rootProject, run);
    }
  }

  // ── runBatch helpers ───────────────────────────────────────────────

  private async detectProjectLayout(projectRoot: string, workspaceFolder: vscode.WorkspaceFolder): Promise<{
    buildTool: BuildTool;
    rootProject: string;
    subprojectPrefix: string | undefined;
  }> {
    const buildTool: BuildTool = await this.buildToolService.detectBuildTool(projectRoot) || 'gradle';

    const rootProject = await this.buildToolService.findRootProject(projectRoot, workspaceFolder.uri.fsPath);

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
    testLookup: Map<string, TestLookupEntry>;
  } {
    const testFilters: string[] = [];
    const testLookup = new Map<string, TestLookupEntry>();

    for (const item of tests) {
      const classId = item.data.classFqn || item.data.className;
      if (classId && item.data.testName) {
        testFilters.push(`${classId}.${item.data.testName}`);
        const key = `${classId}#${item.data.testName}`;
        testLookup.set(key, {...item, resolved: false, seenStatus: undefined});
      } else {
        this.logger.appendLine(`TestRunCoordinator: Skipping test with missing className=${item.data.className} classFqn=${item.data.classFqn} testName=${item.data.testName}`);
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
    testLookup: Map<string, TestLookupEntry>,
    run: vscode.TestRun,
    start: number,
  ): void {
    const parsed = this.parseGradleResultLine(line);

    if (parsed) {
      // A new test-result boundary — flush any buffered failure first
      // so the previous failing test is reported with its error details.
      this.flushPendingFailure(run, start);
    } else {
      // Non-boundary line: if we're buffering a failure, capture it.
      // Skip Gradle "> Task" noise lines — they don't contribute to
      // error details and drown out the actual exception in per-test output.
      if (this.pendingFailure && !/^\s*>\s*Task\s+/i.test(line)) {
        this.pendingFailure.errorLines.push(line);
      }
      return;
    }

    const { className, testPart, status } = parsed;

    if (testPart.includes(' > ') || /\[.*#\d+\]$/.test(testPart)) {
      return;
    }

    const entry = this.findLookupEntry(testLookup, className, testPart);
    this.applyRealTimeStatus(entry, status, run, start, line);
  }

  private parseGradleResultLine(line: string): { className: string; testPart: string; status: TestExecutionStatus } | null {
    const match = /^\s*(\S+)\s+>\s+(.+?)\s+(PASSED|FAILED|SKIPPED)\s*$/.exec(line);
    if (!match) {
      return null;
    }
    return {
      className: match[1],
      testPart: match[2].trim(),
      status: match[3] as TestExecutionStatus,
    };
  }

  private findLookupEntry(
    testLookup: Map<string, TestLookupEntry>,
    className: string,
    testPart: string,
  ): TestLookupEntry | undefined {
    const direct = testLookup.get(`${className}#${testPart}`);
    if (direct) {
      return direct;
    }

    const simpleName = className.includes('.')
      ? className.substring(className.lastIndexOf('.') + 1)
      : undefined;
    if (simpleName) {
      const simpleMatch = testLookup.get(`${simpleName}#${testPart}`);
      if (simpleMatch) {
        return simpleMatch;
      }
    }

    if (className.includes('.')) {
      return undefined;
    }
    const suffix = `.${className}#${testPart}`;
    for (const [lookupKey, lookupEntry] of testLookup) {
      if (lookupKey.endsWith(suffix)) {
        return lookupEntry;
      }
    }
    return undefined;
  }

  private applyRealTimeStatus(
    entry: TestLookupEntry | undefined,
    status: TestExecutionStatus,
    run: vscode.TestRun,
    start: number,
    line: string,
  ): void {
    if (!entry || entry.resolved || entry.data.isDataDriven) {
      return;
    }

    entry.seenStatus = status;

    if (status === 'PASSED') {
      entry.resolved = true;
      run.passed(entry.test, Date.now() - start);
      return;
    }
    if (status === 'FAILED') {
      this.pendingFailure = {
        entry,
        failedLine: line,
        errorLines: [],
      };
      return;
    }

    entry.resolved = true;
    run.skipped(entry.test);
  }

  /**
   * Flush the buffered pending failure (if any), reporting it as failed
   * with the error details accumulated from subsequent output lines.
   */
  private flushPendingFailure(run: vscode.TestRun, start: number): void {
    if (!this.pendingFailure) { return; }

    const { entry, failedLine, errorLines } = this.pendingFailure;
    this.pendingFailure = null;

    if (entry.resolved) { return; }

    const classId = entry.data.classFqn || entry.data.className!;
    const scopedOutput = [failedLine, ...errorLines].join('\n');
    const errorMessage = extractErrorForTest(scopedOutput, classId, entry.data.testName!);

    entry.resolved = true;
    run.failed(entry.test, this.resultProcessor.createTestMessage(errorMessage), Date.now() - start);
  }

  private async resolveDataDrivenResults(
    testLookup: Map<string, TestLookupEntry>,
    result: any,
    run: vscode.TestRun,
    options: {
      projectRoot: string;
      buildTool: BuildTool;
      start: number;
      hasBuildFailureSignal: boolean;
      output: string;
    },
  ): Promise<void> {
    const { projectRoot, buildTool, start, hasBuildFailureSignal, output } = options;
    if (hasBuildFailureSignal) {
      const buildFailureMessage = this.extractBuildFailureMessage(output);
      this.logger.appendLine('TestRunCoordinator: Build failure detected — skipping data-driven parsing and marking unresolved data-driven tests as errored');
      for (const [, entry] of testLookup) {
        if (entry.data.isDataDriven && !entry.resolved) {
          run.errored(
            entry.test,
            this.resultProcessor.createTestMessage(buildFailureMessage),
            Date.now() - start,
          );
          entry.resolved = true;
        }
      }
      return;
    }

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
    testLookup: Map<string, TestLookupEntry>,
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

    const unresolvedClasses = this.collectUnresolvedClasses(testLookup);

    for (const className of unresolvedClasses) {
      const xmlResults = await this.testResultParser.parseClassTestResults(projectRoot, className, buildTool);
      this.applyXmlResultsForClass(testLookup, xmlResults, className, run, start, output);
    }
  }

  private collectUnresolvedClasses(testLookup: Map<string, TestLookupEntry>): Set<string> {
    const unresolvedClasses = new Set<string>();
    for (const [, entry] of testLookup) {
      if (!entry.resolved && entry.data.className) {
        unresolvedClasses.add(entry.data.classFqn || entry.data.className);
      }
    }
    return unresolvedClasses;
  }

  private applyXmlResultsForClass(
    testLookup: Map<string, TestLookupEntry>,
    xmlResults: Map<string, { success: boolean; skipped: boolean; errorMessage?: string; diff?: { expected: string; actual: string } | null }>,
    className: string,
    run: vscode.TestRun,
    start: number,
    output: string,
  ): void {
    for (const [, entry] of testLookup) {
      const entryClass = entry.data.classFqn || entry.data.className;
      if (entry.resolved || entryClass !== className || !entry.data.testName) {
        continue;
      }

      const xmlResult = xmlResults.get(entry.data.testName);
      if (!xmlResult) {
        continue;
      }

      entry.resolved = true;
      if (xmlResult.skipped) {
        run.skipped(entry.test);
        continue;
      }
      if (xmlResult.success) {
        run.passed(entry.test, Date.now() - start);
        continue;
      }

      const xmlError = xmlResult.errorMessage?.trim();
      const consoleFallback = extractErrorForTest(output, entryClass, entry.data.testName);
      const fallbackError = consoleFallback === 'Test failed'
        ? `${entryClass}.${entry.data.testName} FAILED`
        : consoleFallback;
      const finalError = xmlError && xmlError !== 'Test failed' ? xmlError : fallbackError;
      run.failed(entry.test, this.resultProcessor.createTestMessage(finalError, xmlResult.diff ?? undefined), Date.now() - start);
    }
  }

  private resolveFinalFallback(
    testLookup: Map<string, TestLookupEntry>,
    result: any,
    run: vscode.TestRun,
    start: number,
    hasBuildFailureSignal: boolean,
  ): void {
    for (const [, entry] of testLookup) {
      if (entry.resolved) {
        continue;
      }

      // ── 1. Test was seen as PASSED in real-time output ──────────────
      // Belt-and-suspenders: real-time handler already resolved these,
      // but in case XML resolution un-resolved them, honour the status.
      if (entry.seenStatus === 'PASSED') {
        run.passed(entry.test, Date.now() - start);
        continue;
      }

      // ── 2. Test was seen as FAILED in real-time output ─────────────
      // Extract only THIS test's error — never show the whole batch.
      if (entry.seenStatus === 'FAILED') {
        const classId = entry.data.classFqn || entry.data.className!;
        const errorMessage = extractErrorForTest(result.output, classId, entry.data.testName!);
        run.failed(entry.test, this.resultProcessor.createTestMessage(errorMessage), Date.now() - start);
        continue;
      }

      // ── 3. Test was never seen in real-time output ─────────────────
      if (result.success) {
        // Overall batch passed — test must have passed too.
        run.passed(entry.test, Date.now() - start);
      } else {
        // Batch failed (non-zero exit).  First, check whether the
        // output contains a per-test failure line for THIS test.
        const classId = entry.data.classFqn || entry.data.className!;
        const testError = hasErrorForTest(result.output, classId, entry.data.testName!);
        if (testError) {
          const errorMessage = extractErrorForTest(result.output, classId, entry.data.testName!);
          run.failed(entry.test, this.resultProcessor.createTestMessage(errorMessage), Date.now() - start);
        } else if (hasBuildFailureSignal) {
          // Compilation / build failure — mark errored.
          const buildFailureMessage = this.extractBuildFailureMessage(result.output);
          run.errored(
            entry.test,
            this.resultProcessor.createTestMessage(buildFailureMessage),
            Date.now() - start,
          );
        } else {
          // No evidence this test failed and no build failure signal —
          // the non-zero exit code is from OTHER tests.
          // Mark as passed rather than errored.
          run.passed(entry.test, Date.now() - start);
        }
      }
    }
  }

  private hasBuildFailureSignal(output: string): boolean {
    if (!output) {
      return false;
    }

    // ── Unambiguous compilation / infrastructure failures ──────────
    if (/\bCompilation failed\b/i.test(output)) { return true; }
    if (/\bCOMPILATION ERROR\b/i.test(output)) { return true; }

    // Gradle compile-task failure (compileGroovy, compileJava, etc.)
    if (/^\s*>\s*Task\s+:[\w:]*compile\w*\s+FAILED\s*$/im.test(output)) { return true; }

    // Maven compiler-plugin failure
    if (/^\s*\[ERROR\]\s+Failed to execute goal\s+.*maven-compiler-plugin/im.test(output)) { return true; }

    // ── Generic "BUILD FAILED" – only count it when it is NOT caused
    //    by test failures alone.  Gradle prints "There were failing tests"
    //    and Maven prints "There are test failures" when the exit code is
    //    due to test failures rather than a build problem. ─────────────
    const hasBuildFailed =
      /\bBUILD FAILED\b/i.test(output)
      || /\bBUILD FAILURE\b/i.test(output)
      || /Execution failed for task\s+['"]?:[^'"\s]+['"]?/i.test(output)
      || /^\s*\[ERROR\]\s+Failed to execute goal\s+/im.test(output)
      || /^\s*>\s*Task\s+:[^\n\r]+\s+FAILED\s*$/im.test(output);

    if (hasBuildFailed) {
      const isTestFailureExit =
        /There were failing tests/i.test(output)
        || /There are test failures/i.test(output);
      if (!isTestFailureExit) {
        return true;
      }
    }

    return false;
  }

  private extractBuildFailureMessage(output: string): string {
    if (!output) {
      return 'Build failed (no details available in output).';
    }

    const rawLines = output.split('\n');
    const collected: string[] = [];

    for (const line of rawLines) {
      if (!this.isBuildFailureNoiseLine(line)) {
        collected.push(line.trim());
      }
    }

    const focused = this.focusBuildFailureLines(collected);
    const trimmed = this.trimStackTraceDepth(focused, 8);

    if (trimmed.length > 0) {
      return trimmed.slice(0, 40).join('\n');
    }

    return 'Build failed (no details available in output).';
  }

  private isBuildFailureNoiseLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) {
      return true;
    }
    return BUILD_FAILURE_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  private focusBuildFailureLines(lines: string[]): string[] {
    if (lines.length === 0) {
      return lines;
    }

    const anchorIndex = this.findBuildFailureAnchorIndex(lines);
    if (anchorIndex < 0) {
      return lines;
    }

    let startIndex = anchorIndex;
    while (startIndex > 0 && this.isBuildFailureContextLine(lines[startIndex - 1])) {
      startIndex--;
    }

    return lines.slice(startIndex);
  }

  private findBuildFailureAnchorIndex(lines: string[]): number {
    const anchorGroups: RegExp[][] = [
      [
        /^startup failed:\s*$/i,
        /\.(java|groovy|kt|kts|gradle):\s*\d+/i,
        /\b(unable to resolve class|could not resolve|cannot find symbol|startup failed|\d+\s+errors?)\b/i,
      ],
      [
        /^Caused by:\s+/i,
        /^Exception is:\s*$/i,
        /^\S.*(?:Exception|Error)(?::|\b)/,
        /^at\s+/i,
      ],
      [
        /^\* What went wrong:\s*$/i,
        /^Execution failed for task\b/i,
        /^\[ERROR\]\s+Failed to execute goal\b/i,
      ],
    ];

    for (const group of anchorGroups) {
      const index = lines.findIndex((line) => group.some((pattern) => pattern.test(line)));
      if (index >= 0) {
        return index;
      }
    }

    return -1;
  }

  private isBuildFailureContextLine(line: string): boolean {
    return (
      /^startup failed:\s*$/i.test(line)
      || /^\* What went wrong:\s*$/i.test(line)
      || /^Execution failed for task\b/i.test(line)
      || /^Caused by:\s+/i.test(line)
      || /^Exception is:\s*$/i.test(line)
      || /^\S.*(?:Exception|Error)(?::|\b)/.test(line)
    );
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
        showInfoStatus('Coverage data is unavailable because no JaCoCo XML report was found for this run.', 10000);
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
        showInfoStatus(
          `Preferred debug port ${cfg.debugPort} is in use; using ${resolvedPort} for this run.`,
          8000,
        );
      }
      return resolvedPort;
    } catch (error) {
      this.logger.appendLine(`TestRunCoordinator: Could not find free debug port: ${error}`);
      showWarningStatus(
        `Could not find a free debug port near ${cfg.debugPort}; trying configured port ${cfg.debugPort}.`,
      );
      return cfg.debugPort;
    }
  }

  private notifyBuildFailure(): void {
    if (this.notifiedBuildFailure) {
      return;
    }
    this.notifiedBuildFailure = true;
    showWarningStatus('Build failed before all test results were available. Some tests are marked as errored.');
  }
}
