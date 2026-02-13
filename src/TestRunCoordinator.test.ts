import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { TestRunCoordinator } from './TestRunCoordinator';
import { createMockLogger } from './__test_helpers__';

// --- Mocks ---------------------------------------------------------------

vi.mock('./services/SpockErrorParser', () => ({
  extractErrorForTest: vi.fn((_output: string, _className: string, _testName: string) => 'Test failed'),
  hasErrorForClass: vi.fn(() => false),
  hasErrorForTest: vi.fn(() => false),
}));

// --- Helpers -------------------------------------------------------------

function createMockController() {
  const items = new Map<string, any>();
  return {
    items: {
      add: (item: any) => items.set(item.id, item),
      get: (id: string) => items.get(id),
      delete: (id: string) => items.delete(id),
      replace: (arr: any[]) => { items.clear(); arr.forEach(i => items.set(i.id, i)); },
      forEach: (cb: any) => items.forEach(cb),
      get size() { return items.size; },
    },
    createTestItem: (id: string, label: string, uri?: vscode.Uri) => {
      const children = new Map<string, any>();
      const item: any = {
        id, label, uri,
        children: {
          add: (child: any) => { child.parent = item; children.set(child.id, child); },
          get: (cid: string) => children.get(cid),
          delete: (cid: string) => children.delete(cid),
          replace: (arr: any[]) => { children.clear(); arr.forEach(c => children.set(c.id, c)); },
          forEach: (cb: any) => children.forEach(cb),
          get size() { return children.size; },
        },
        tags: [new vscode.TestTag('runnable')],
        range: undefined,
        canResolveChildren: false,
        parent: undefined,
        description: undefined,
      };
      return item;
    },
    createTestRun: vi.fn(() => createMockRun()),
    createRunProfile: vi.fn(),
  } as any;
}

// createMockLogger imported from __test_helpers__

function createMockRun() {
  return {
    passed: vi.fn(),
    failed: vi.fn(),
    skipped: vi.fn(),
    started: vi.fn(),
    appendOutput: vi.fn(),
    end: vi.fn(),
    addCoverage: vi.fn(),
  };
}

function createMockTestExecutionService() {
  return {
    executeBatch: vi.fn().mockResolvedValue({ success: true, output: '' }),
  } as any;
}

function createMockTestResultParser() {
  return {
    parseTestResults: vi.fn().mockResolvedValue([]),
    parseClassTestResults: vi.fn().mockResolvedValue(new Map()),
    parseXmlReport: vi.fn().mockResolvedValue([]),
    parseExpectedActual: vi.fn(() => null),
  } as any;
}

function createMockCoverageService() {
  return {
    findAllJacocoXmlReports: vi.fn().mockResolvedValue([]),
    parseJacocoReport: vi.fn().mockResolvedValue([]),
  } as any;
}

function createMockBuildToolService() {
  return {
    detectBuildTool: vi.fn().mockResolvedValue('gradle'),
    findProjectRoot: vi.fn().mockResolvedValue('/workspace/project'),
    findRootProject: vi.fn().mockResolvedValue('/workspace/project'),
    getProjectName: vi.fn().mockResolvedValue('test-project'),
    getSubprojectPrefix: vi.fn().mockReturnValue(''),
    getMavenModuleName: vi.fn().mockReturnValue(''),
    buildCommandArgs: vi.fn().mockResolvedValue(['gradle', 'test']),
    buildBatchCommandArgs: vi.fn().mockResolvedValue(['gradle', 'test']),
    getTestResultsDir: vi.fn().mockReturnValue('/workspace/project/build/test-results/test'),
  } as any;
}

function createMockTreeManager(testDataMap?: WeakMap<any, any>) {
  return {
    testData: testDataMap ?? new WeakMap(),
    iterationItems: new Map(),
    projectItems: new Map(),
    subProjectItems: new Map(),
    discoverTestsInFile: vi.fn(),
  } as any;
}

function createMockResultProcessor() {
  return {
    handleDataDrivenTestResults: vi.fn().mockResolvedValue(undefined),
    createTestMessage: vi.fn((text: string) => new vscode.TestMessage(text)),
    createFlatIterationItems: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createCancellationToken(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
  } as any;
}

// --- Tests ---------------------------------------------------------------

describe('TestRunCoordinator', () => {
  let controller: ReturnType<typeof createMockController>;
  let logger: ReturnType<typeof createMockLogger>;
  let executionService: ReturnType<typeof createMockTestExecutionService>;
  let resultParser: ReturnType<typeof createMockTestResultParser>;
  let coverageService: ReturnType<typeof createMockCoverageService>;
  let buildToolService: ReturnType<typeof createMockBuildToolService>;
  let treeManager: ReturnType<typeof createMockTreeManager>;
  let resultProcessor: ReturnType<typeof createMockResultProcessor>;
  let coordinator: TestRunCoordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = createMockController();
    logger = createMockLogger();
    executionService = createMockTestExecutionService();
    resultParser = createMockTestResultParser();
    coverageService = createMockCoverageService();
    buildToolService = createMockBuildToolService();
    treeManager = createMockTreeManager();
    resultProcessor = createMockResultProcessor();

    // Set up workspace
    (vscode.workspace as any).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 },
    ];
    (vscode.workspace as any).getWorkspaceFolder = vi.fn(() => ({
      uri: vscode.Uri.file('/workspace'),
      name: 'workspace',
      index: 0,
    }));

    coordinator = new TestRunCoordinator(
      controller, logger, executionService, resultParser,
      coverageService, treeManager, resultProcessor, buildToolService,
    );
  });

  // ── createTrackingRun ────────────────────────────────────────────

  describe('createTrackingRun', () => {
    it('should track failed tests by semantic key', () => {
      const baseRun = createMockRun();
      const failedSpy = baseRun.failed; // save ref before createTrackingRun replaces it
      const testItem = controller.createTestItem('t1', 'test', vscode.Uri.file('/spec.groovy'));
      treeManager.testData.set(testItem, { type: 'test', className: 'Spec', testName: 'my test' });

      const tracking = coordinator.createTrackingRun(baseRun as any);
      tracking.failed(testItem, new vscode.TestMessage('oops'));

      expect(coordinator.lastFailedTests.has('Spec#my test')).toBe(true);
      expect(failedSpy).toHaveBeenCalled();
    });

    it('should remove tests from failed set when they pass', () => {
      const baseRun = createMockRun();
      const testItem = controller.createTestItem('t1', 'test', vscode.Uri.file('/spec.groovy'));
      treeManager.testData.set(testItem, { type: 'test', className: 'Spec', testName: 'my test' });

      coordinator.lastFailedTests.add('Spec#my test');
      const tracking = coordinator.createTrackingRun(baseRun as any);
      tracking.passed(testItem);

      expect(coordinator.lastFailedTests.has('Spec#my test')).toBe(false);
    });

    it('should remove tests from failed set when they are skipped', () => {
      const baseRun = createMockRun();
      const testItem = controller.createTestItem('t1', 'test', vscode.Uri.file('/spec.groovy'));
      treeManager.testData.set(testItem, { type: 'test', className: 'Spec', testName: 'my test' });

      coordinator.lastFailedTests.add('Spec#my test');
      const tracking = coordinator.createTrackingRun(baseRun as any);
      tracking.skipped(testItem);

      expect(coordinator.lastFailedTests.has('Spec#my test')).toBe(false);
    });
  });

  // ── rerunFailedHandler ───────────────────────────────────────────

  describe('rerunFailedHandler', () => {
    it('should show info message when no failed tests exist', async () => {
      coordinator.lastFailedTests.clear();
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage' as any);
      const request = new vscode.TestRunRequest();
      const token = createCancellationToken();

      await coordinator.rerunFailedHandler(request, token);
      expect(infoSpy).toHaveBeenCalled();
    });

    it('should collect failed items from the test tree', async () => {
      const testItem = controller.createTestItem('t1', 'test', vscode.Uri.file('/workspace/project/spec.groovy'));
      const testData = { type: 'test' as const, className: 'Spec', testName: 'my test' };
      treeManager.testData.set(testItem, testData);
      controller.items.add(testItem);

      coordinator.lastFailedTests.add('Spec#my test');
      const request = new vscode.TestRunRequest();
      const token = createCancellationToken();

      // The runHandler will be called; mock it to succeed
      coordinator.runHandler = vi.fn().mockResolvedValue(undefined);

      await coordinator.rerunFailedHandler(request, token);
      expect(coordinator.runHandler).toHaveBeenCalled();
    });
  });

  // ── runHandler ───────────────────────────────────────────────────

  describe('runHandler', () => {
    it('should end run immediately when cancellation is requested', async () => {
      const run = createMockRun();
      controller.createTestRun = vi.fn(() => run);

      const token = createCancellationToken(true);
      const request = new vscode.TestRunRequest();

      await coordinator.runHandler(false, request, token);
      expect(run.end).toHaveBeenCalled();
    });

    it('should end run when no leaf tests are found', async () => {
      const run = createMockRun();
      controller.createTestRun = vi.fn(() => run);

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest();

      await coordinator.runHandler(false, request, token);
      expect(run.end).toHaveBeenCalled();
    });

    it('should collect leaf tests from included items', async () => {
      const run = createMockRun();
      controller.createTestRun = vi.fn(() => run);

      const testItem = controller.createTestItem('t1', 'test', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(testItem, { type: 'test', className: 'Spec', testName: 'my test' });

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([testItem]);

      await coordinator.runHandler(false, request, token);

      expect(executionService.executeBatch).toHaveBeenCalled();
      expect(run.end).toHaveBeenCalled();
    });

    it('should expand class nodes to leaf tests', async () => {
      const run = createMockRun();
      controller.createTestRun = vi.fn(() => run);

      const classItem = controller.createTestItem('c1', 'MySpec', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(classItem, { type: 'class', className: 'MySpec' });

      const test1 = controller.createTestItem('t1', 'test one', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'MySpec', testName: 'test one' });
      classItem.children.add(test1);

      const test2 = controller.createTestItem('t2', 'test two', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test2, { type: 'test', className: 'MySpec', testName: 'test two' });
      classItem.children.add(test2);

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([classItem]);

      await coordinator.runHandler(false, request, token);

      // Both leaf tests should have been started
      expect(run.started).toHaveBeenCalledTimes(2);
    });

    it('should skip excluded tests', async () => {
      const run = createMockRun();
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'test one', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'Spec', testName: 'test one' });

      const test2 = controller.createTestItem('t2', 'test two', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test2, { type: 'test', className: 'Spec', testName: 'test two' });

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1, test2], [test2]);

      await coordinator.runHandler(false, request, token);

      // Only test1 should have been started (test2 excluded)
      expect(run.started).toHaveBeenCalledTimes(1);
    });

    it('should skip non-runnable (ignored) tests', async () => {
      const run = createMockRun();
      const skippedSpy = run.skipped; // save ref before createTrackingRun replaces it
      controller.createTestRun = vi.fn(() => run);

      const ignoredTest = controller.createTestItem('t1', 'ignored test', vscode.Uri.file('/workspace/project/spec.groovy'));
      ignoredTest.tags = []; // not runnable
      treeManager.testData.set(ignoredTest, { type: 'test', className: 'Spec', testName: 'ignored test' });

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([ignoredTest]);

      await coordinator.runHandler(false, request, token);

      expect(skippedSpy).toHaveBeenCalledWith(ignoredTest);
      expect(run.started).not.toHaveBeenCalled();
    });
  });

  // ── Progress bar delta fix ───────────────────────────────────────

  describe('progress reporting', () => {
    it('should report incremental deltas, not cumulative percentages', async () => {
      const run = createMockRun();
      controller.createTestRun = vi.fn(() => run);

      // Create two groups of tests so we get two progress reports
      const test1 = controller.createTestItem('t1', 'test1', vscode.Uri.file('/workspace/projA/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'Spec1', testName: 'test1' });

      const test2 = controller.createTestItem('t2', 'test2', vscode.Uri.file('/workspace/projB/spec.groovy'));
      treeManager.testData.set(test2, { type: 'test', className: 'Spec2', testName: 'test2' });

      // Map tests to different project roots
      buildToolService.findProjectRoot.mockImplementation(async (fp: string) => {
        if (fp.includes('projA')) { return '/workspace/projA'; }
        return '/workspace/projB';
      });

      const progressReports: any[] = [];
      (vscode.window as any).withProgress = vi.fn(async (_opts: any, task: any) => {
        const progress = {
          report: (data: any) => progressReports.push(data),
        };
        const token = createCancellationToken();
        return task(progress, token);
      });

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1, test2]);

      await coordinator.runHandler(false, request, token);

      // Filter out the initial 0 report
      const incrementReports = progressReports.filter(r => r.increment > 0);

      // Each increment should be the DELTA, not cumulative.
      // With 2 tests, each batch has 1 test: 50% then 50% (not 50% then 100%).
      const totalIncrement = incrementReports.reduce((sum, r) => sum + r.increment, 0);
      expect(totalIncrement).toBe(100);

      // No single increment should exceed 100
      for (const report of incrementReports) {
        expect(report.increment).toBeLessThanOrEqual(100);
      }
    });
  });

  // ── runBatch ─────────────────────────────────────────────────────

  describe('runBatch', () => {
    it('should mark all tests as started', async () => {
      const run = createMockRun();
      const test1 = controller.createTestItem('t1', 'test one', vscode.Uri.file('/workspace/project/spec.groovy'));
      const test2 = controller.createTestItem('t2', 'test two', vscode.Uri.file('/workspace/project/spec.groovy'));

      const tests = [
        { test: test1, data: { type: 'test' as const, className: 'Spec', testName: 'test one' } },
        { test: test2, data: { type: 'test' as const, className: 'Spec', testName: 'test two' } },
      ];

      await coordinator.runBatch('/workspace/project', tests, run as any, false, createCancellationToken());

      expect(run.started).toHaveBeenCalledWith(test1);
      expect(run.started).toHaveBeenCalledWith(test2);
    });

    it('should skip tests with missing class name or test name', async () => {
      const run = createMockRun();
      const test1 = controller.createTestItem('t1', 'test', vscode.Uri.file('/workspace/project/spec.groovy'));

      const tests = [
        { test: test1, data: { type: 'test' as const } }, // no className/testName
      ];

      await coordinator.runBatch('/workspace/project', tests, run as any, false, createCancellationToken());

      expect(run.skipped).toHaveBeenCalledWith(test1);
    });

    it('should handle data-driven tests via resultProcessor', async () => {
      const run = createMockRun();
      const test1 = controller.createTestItem('t1', 'data test', vscode.Uri.file('/workspace/project/spec.groovy'));

      const tests = [
        { test: test1, data: { type: 'test' as const, className: 'Spec', testName: 'data test', isDataDriven: true } },
      ];

      await coordinator.runBatch('/workspace/project', tests, run as any, false, createCancellationToken());

      expect(resultProcessor.handleDataDrivenTestResults).toHaveBeenCalled();
    });

    it('should collect coverage when coverage flag is set', async () => {
      const run = createMockRun();
      const test1 = controller.createTestItem('t1', 'test one', vscode.Uri.file('/workspace/project/spec.groovy'));

      const tests = [
        { test: test1, data: { type: 'test' as const, className: 'Spec', testName: 'test one' } },
      ];

      coverageService.findAllJacocoXmlReports.mockResolvedValue([
        { xmlPath: '/report.xml', projectRoot: '/workspace/project' },
      ]);
      coverageService.parseJacocoReport.mockResolvedValue([{ uri: vscode.Uri.file('/Spec.groovy') }]);

      await coordinator.runBatch('/workspace/project', tests, run as any, false, createCancellationToken(), true);

      expect(coverageService.findAllJacocoXmlReports).toHaveBeenCalled();
      expect(run.addCoverage).toHaveBeenCalled();
    });

    it('should split into sub-batches for Gradle when command line is long', async () => {
      const run = createMockRun();

      // Create enough tests to potentially trigger sub-batching
      const tests: Array<{test: any; data: any}> = [];
      for (let i = 0; i < 100; i++) {
        const className = `com.example.very.long.package.name.TestSpec${i}`;
        const testName = `should do something really important in test number ${i}`;
        const t = controller.createTestItem(`t${i}`, testName, vscode.Uri.file('/workspace/project/spec.groovy'));
        tests.push({ test: t, data: { type: 'test' as const, className, testName } });
      }

      // Mock buildBatchCommandArgs to return a realistic long command
      buildToolService.buildBatchCommandArgs.mockImplementation(async (filters: string[]) => {
        const args = ['gradlew.bat', 'test'];
        for (const f of filters) {
          args.push('--tests', `"${f}"`);
        }
        args.push('--stacktrace');
        return args;
      });

      await coordinator.runBatch('/workspace/project', tests, run as any, false, createCancellationToken());

      // Should have called executeBatch (at least once — exact count depends on platform limits)
      expect(executionService.executeBatch).toHaveBeenCalled();
      // All tests should have been started
      for (const { test } of tests) {
        expect(run.started).toHaveBeenCalledWith(test);
      }
    });

    it('should pass classTestCounts for Gradle wildcard coalescing', async () => {
      const run = createMockRun();
      const classItem = controller.createTestItem('cls', 'MySpec', vscode.Uri.file('/workspace/project/spec.groovy'));
      const test1 = controller.createTestItem('t1', 'test one', vscode.Uri.file('/workspace/project/spec.groovy'));
      const test2 = controller.createTestItem('t2', 'test two', vscode.Uri.file('/workspace/project/spec.groovy'));
      classItem.children.add(test1);
      classItem.children.add(test2);

      const tests = [
        { test: test1, data: { type: 'test' as const, className: 'MySpec', testName: 'test one' } },
        { test: test2, data: { type: 'test' as const, className: 'MySpec', testName: 'test two' } },
      ];

      await coordinator.runBatch('/workspace/project', tests, run as any, false, createCancellationToken());

      // buildBatchCommandArgs should have been called with classTestCounts as the last arg
      const calls = buildToolService.buildBatchCommandArgs.mock.calls;
      // At least one call should have a Map as the last argument
      const hasClassTestCounts = calls.some((call: any[]) => {
        const lastArg = call[call.length - 1];
        return lastArg instanceof Map && lastArg.get('MySpec') === 2;
      });
      expect(hasClassTestCounts).toBe(true);
    });
  });

  // ── continuousRunHandler ─────────────────────────────────────────

  describe('continuousRunHandler', () => {
    it('should delegate to runHandler when not a continuous request', async () => {
      coordinator.runHandler = vi.fn().mockResolvedValue(undefined);

      const request = new vscode.TestRunRequest(undefined, undefined, undefined, false);
      const token = createCancellationToken();

      await coordinator.continuousRunHandler(false, request, token);
      expect(coordinator.runHandler).toHaveBeenCalled();
    });
  });

  // ── Real-time output FQN matching ────────────────────────────────

  describe('real-time output FQN matching', () => {
    it('should resolve a test when Gradle outputs FQN class name', async () => {
      const run = createMockRun();
      const passedSpy = run.passed; // save ref before createTrackingRun replaces it
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should add', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'CalculatorSpec', testName: 'should add' });

      // Simulate Gradle output with FQN class name
      executionService.executeBatch.mockImplementation(async (opts: any) => {
        if (opts.onOutputLine) {
          opts.onOutputLine('com.example.CalculatorSpec > should add PASSED');
        }
        return { success: true, output: 'com.example.CalculatorSpec > should add PASSED' };
      });

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      expect(passedSpy).toHaveBeenCalledWith(test1, expect.any(Number));
    });

    it('should still resolve tests when Gradle uses simple class name', async () => {
      const run = createMockRun();
      const passedSpy = run.passed; // save ref before createTrackingRun replaces it
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should add', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'CalculatorSpec', testName: 'should add' });

      // Simulate Gradle output with simple class name
      executionService.executeBatch.mockImplementation(async (opts: any) => {
        if (opts.onOutputLine) {
          opts.onOutputLine('CalculatorSpec > should add PASSED');
        }
        return { success: true, output: 'CalculatorSpec > should add PASSED' };
      });

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      expect(passedSpy).toHaveBeenCalledWith(test1, expect.any(Number));
    });
  });

  // ── Fallback result reporting ────────────────────────────────────

  describe('resolveFinalFallback', () => {
    it('should report unresolved tests as passed when batch succeeds', async () => {
      const run = createMockRun();
      const passedSpy = run.passed; // save ref before createTrackingRun replaces it
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'test one', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'Spec', testName: 'test one' });

      // executeBatch succeeds, no real-time match, no XML result
      executionService.executeBatch.mockResolvedValue({ success: true, output: '' });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      expect(passedSpy).toHaveBeenCalledWith(test1, expect.any(Number));
    });

    it('should report unresolved test as failed when build fails before test execution', async () => {
      const run = createMockRun();
      const passedSpy = run.passed; // save ref before createTrackingRun replaces it
      const failedSpy = run.failed;
      const skippedSpy = run.skipped;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'passing test', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'Spec', testName: 'passing test' });

      // Batch fails overall but no specific error for this test
      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: '> Task :compileJava FAILED\n> Could not compile test classes.\nBUILD FAILED',
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      expect(passedSpy).not.toHaveBeenCalled();
      expect(failedSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Could not compile test classes') }),
        expect.any(Number),
      );
      expect(skippedSpy).not.toHaveBeenCalled();
    });

    it('should ignore XML results when build failure is detected', async () => {
      const run = createMockRun();
      const passedSpy = run.passed;
      const failedSpy = run.failed;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'passing test', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'Spec', testName: 'passing test' });

      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: '> Task :compileJava FAILED\nExecution failed for task :compileJava.\nBUILD FAILED',
      });

      // Simulate stale/previous XML that would otherwise mark this test as passed.
      resultParser.parseClassTestResults.mockResolvedValue(
        new Map([
          ['passing test', { success: true, skipped: false }],
        ]),
      );

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      expect(passedSpy).not.toHaveBeenCalled();
      expect(failedSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Execution failed for task :compileJava') }),
        expect.any(Number),
      );
    });

    it('should prioritize per-test assertion details over build failure fallback in mixed output', async () => {
      const { hasErrorForTest, extractErrorForTest } = await import('./services/SpockErrorParser');
      const hasErrorForTestMock = vi.mocked(hasErrorForTest);
      const extractErrorForTestMock = vi.mocked(extractErrorForTest);

      // Configure mocks: test1 has a per-test failure, test2 does not
      hasErrorForTestMock.mockImplementation(
        (_output: string, _className: string, testName: string) => testName === 'should add',
      );
      extractErrorForTestMock.mockImplementation(
        (_output: string, _className: string, testName: string) =>
          testName === 'should add' ? 'Condition not satisfied:\n  result == 5\n  |      |\n  4      false' : 'Test failed',
      );

      const run = createMockRun();
      const failedSpy = run.failed;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should add', vscode.Uri.file('/workspace/project/spec.groovy'));
      const test2 = controller.createTestItem('t2', 'should multiply', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'CalculatorSpec', testName: 'should add' });
      treeManager.testData.set(test2, { type: 'test', className: 'CalculatorSpec', testName: 'should multiply' });

      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: [
          'CalculatorSpec > should add FAILED',
          'Condition not satisfied:',
          '  result == 5',
          '  |      |',
          '  4      false',
          '> Task :compileJava FAILED',
          '> Could not compile test classes.',
          'BUILD FAILED',
        ].join('\n'),
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1, test2]);
      await coordinator.runHandler(false, request, token);

      expect(failedSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Condition not satisfied') }),
        expect.any(Number),
      );
      expect(failedSpy).toHaveBeenCalledWith(
        test2,
        expect.objectContaining({ message: expect.stringContaining('Could not compile test classes') }),
        expect.any(Number),
      );

      // Restore default mock behavior
      hasErrorForTestMock.mockImplementation(() => false);
      extractErrorForTestMock.mockImplementation(() => 'Test failed');
    });

    it('should use build failure stack trace/cause block instead of generic fallback', async () => {
      const run = createMockRun();
      const failedSpy = run.failed;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'passing test', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'Spec', testName: 'passing test' });

      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: [
          '> Task :compileJava FAILED',
          'BUILD FAILED',
          '* What went wrong:',
          'Execution failed for task :compileJava.',
          'Caused by: java.lang.RuntimeException: Failed to load config',
          '    at com.example.Build.configure(Build.groovy:12)',
          '* Try:',
        ].join('\n'),
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      expect(failedSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Execution failed for task :compileJava.') }),
        expect.any(Number),
      );
      expect(failedSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Caused by: java.lang.RuntimeException: Failed to load config') }),
        expect.any(Number),
      );
      expect(failedSpy).not.toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: 'Build failed before test execution.' }),
        expect.any(Number),
      );
    });

    it('should skip generic compiler-output hint and show concrete compiler error', async () => {
      const run = createMockRun();
      const failedSpy = run.failed;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'passing test', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'Spec', testName: 'passing test' });

      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: [
          '> Task :compileTestGroovy FAILED',
          '> Compilation failed; see the compiler error output for details.',
          'C:\\work\\src\\test\\groovy\\Spec.groovy: 12: unable to resolve class MissingType',
          'BUILD FAILED',
        ].join('\n'),
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      expect(failedSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('unable to resolve class MissingType') }),
        expect.any(Number),
      );
      expect(failedSpy).not.toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Compilation failed; see the compiler error output for details') }),
        expect.any(Number),
      );
    });

    it('should not show plain Test failed when XML failure lacks error message', async () => {
      const run = createMockRun();
      const failedSpy = run.failed;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should add', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'CalculatorSpec', testName: 'should add' });

      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: 'CalculatorSpec > should add FAILED',
      });
      resultParser.parseClassTestResults.mockResolvedValue(
        new Map([
          ['should add', { success: false, skipped: false, duration: 0, errorMessage: '' }],
        ]),
      );

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      expect(failedSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('CalculatorSpec.should add FAILED') }),
        expect.any(Number),
      );
      expect(failedSpy).not.toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: 'Test failed' }),
        expect.any(Number),
      );
    });
  });
});
