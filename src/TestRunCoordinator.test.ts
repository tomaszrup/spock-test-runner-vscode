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
    errored: vi.fn(),
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
      const infoSpy = vi.spyOn(vscode.window, 'setStatusBarMessage' as any);
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

    it('should use plain Gradle project task when request.include is undefined (run all)', async () => {
      const run = createMockRun();
      controller.createTestRun = vi.fn(() => run);

      const project = controller.createTestItem('p1', 'project', vscode.Uri.file('/workspace/project'));
      treeManager.testData.set(project, { type: 'project' });

      const testItem = controller.createTestItem('t1', 'test one', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(testItem, { type: 'test', className: 'Spec', testName: 'test one' });
      project.children.add(testItem);
      controller.items.add(project);

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest();

      await coordinator.runHandler(false, request, token);

      const filterArgCalls = buildToolService.buildBatchCommandArgs.mock.calls.map((call: any[]) => call[0]);
      expect(filterArgCalls.length).toBeGreaterThan(0);
      expect(filterArgCalls.every((arg: string[]) => Array.isArray(arg) && arg.length === 0)).toBe(true);
    });

    it('should use plain Gradle project task when include targets project node', async () => {
      const run = createMockRun();
      controller.createTestRun = vi.fn(() => run);

      const project = controller.createTestItem('p1', 'project', vscode.Uri.file('/workspace/project'));
      treeManager.testData.set(project, { type: 'project' });

      const testItem = controller.createTestItem('t1', 'test one', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(testItem, { type: 'test', className: 'Spec', testName: 'test one' });
      project.children.add(testItem);

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([project]);

      await coordinator.runHandler(false, request, token);

      const filterArgCalls = buildToolService.buildBatchCommandArgs.mock.calls.map((call: any[]) => call[0]);
      expect(filterArgCalls.length).toBeGreaterThan(0);
      expect(filterArgCalls.every((arg: string[]) => Array.isArray(arg) && arg.length === 0)).toBe(true);
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

      await coordinator.runBatch('/workspace/project', { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 }, tests, run as any, false, createCancellationToken());

      expect(run.started).toHaveBeenCalledWith(test1);
      expect(run.started).toHaveBeenCalledWith(test2);
    });

    it('should skip tests with missing class name or test name', async () => {
      const run = createMockRun();
      const test1 = controller.createTestItem('t1', 'test', vscode.Uri.file('/workspace/project/spec.groovy'));

      const tests = [
        { test: test1, data: { type: 'test' as const } }, // no className/testName
      ];

      await coordinator.runBatch('/workspace/project', { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 }, tests, run as any, false, createCancellationToken());

      expect(run.skipped).toHaveBeenCalledWith(test1);
    });

    it('should handle data-driven tests via resultProcessor', async () => {
      const run = createMockRun();
      const test1 = controller.createTestItem('t1', 'data test', vscode.Uri.file('/workspace/project/spec.groovy'));

      const tests = [
        { test: test1, data: { type: 'test' as const, className: 'Spec', testName: 'data test', isDataDriven: true } },
      ];

      await coordinator.runBatch('/workspace/project', { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 }, tests, run as any, false, createCancellationToken());

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

      await coordinator.runBatch(
        '/workspace/project',
        { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 },
        tests,
        run as any,
        false,
        createCancellationToken(),
        { coverage: true },
      );

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
        return args;
      });

      await coordinator.runBatch('/workspace/project', { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 }, tests, run as any, false, createCancellationToken());

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

      await coordinator.runBatch('/workspace/project', { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 }, tests, run as any, false, createCancellationToken());

      // buildBatchCommandArgs should receive classTestCounts inside the options object
      const calls = buildToolService.buildBatchCommandArgs.mock.calls;
      // At least one call should include the class test counts map in options
      const hasClassTestCounts = calls.some((call: any[]) => {
        const options = call.at(-1);
        return options?.classTestCounts instanceof Map && options.classTestCounts.get('MySpec') === 2;
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

    it('should resolve tests when Gradle outputs simple name but lookup uses classFqn', async () => {
      const run = createMockRun();
      const passedSpy = run.passed;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should add', vscode.Uri.file('/workspace/project/spec.groovy'));
      // classFqn is set — the lookup key will be "com.example.CalculatorSpec#should add"
      treeManager.testData.set(test1, {
        type: 'test',
        className: 'CalculatorSpec',
        classFqn: 'com.example.CalculatorSpec',
        testName: 'should add',
      });

      // Gradle outputs simple name "CalculatorSpec" (not the FQN)
      executionService.executeBatch.mockImplementation(async (opts: any) => {
        if (opts.onOutputLine) {
          opts.onOutputLine('CalculatorSpec > should add PASSED');
        }
        return { success: true, output: 'CalculatorSpec > should add PASSED' };
      });

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      // Should still match via the reverse lookup (simple → FQN)
      expect(passedSpy).toHaveBeenCalledWith(test1, expect.any(Number));
    });
  });

  // ── Fallback result reporting ────────────────────────────────────

  describe('resolveFinalFallback', () => {
    it('should resolve XML results using classFqn when available', async () => {
      const run = createMockRun();
      const passedSpy = run.passed;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should add', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, {
        type: 'test',
        className: 'CalculatorSpec',
        classFqn: 'com.example.CalculatorSpec',
        testName: 'should add',
      });

      executionService.executeBatch.mockResolvedValue({ success: true, output: '' });
      resultParser.parseClassTestResults.mockResolvedValue(
        new Map([
          ['should add', { success: true, skipped: false, duration: 0.01 }],
        ]),
      );

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      expect(resultParser.parseClassTestResults).toHaveBeenCalledWith(
        '/workspace/project',
        'com.example.CalculatorSpec',
        'gradle',
      );
      expect(passedSpy).toHaveBeenCalledWith(test1, expect.any(Number));
    });

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

    it('should report unresolved test as errored when build fails before test execution', async () => {
      const run = createMockRun();
      const passedSpy = run.passed; // save ref before createTrackingRun replaces it
      const erroredSpy = run.errored;
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
      expect(erroredSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Could not compile test classes') }),
        expect.any(Number),
      );
      expect(skippedSpy).not.toHaveBeenCalled();
    });

    it('should ignore XML results when build failure is detected', async () => {
      const run = createMockRun();
      const passedSpy = run.passed;
      const erroredSpy = run.errored;
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
      expect(erroredSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Execution failed for task :compileJava') }),
        expect.any(Number),
      );
    });

    it('should mark unresolved data-driven tests as errored on build failure and skip data-driven parser', async () => {
      const run = createMockRun();
      const erroredSpy = run.errored;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'maximum of #a and #b is #c', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, {
        type: 'test',
        className: 'DataDrivenSpec',
        testName: 'maximum of #a and #b is #c',
        isDataDriven: true,
      });

      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: [
          '> Task :compileTestGroovy FAILED',
          'startup failed:',
          'Spec.groovy: 12: unable to resolve class Specification',
          'BUILD FAILED',
        ].join('\n'),
      });

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      expect(resultProcessor.handleDataDrivenTestResults).not.toHaveBeenCalled();
      expect(erroredSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('unable to resolve class Specification') }),
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
      const erroredSpy = run.errored;
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
      expect(erroredSpy).toHaveBeenCalledWith(
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
      const erroredSpy = run.errored;
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

      expect(erroredSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Execution failed for task :compileJava.') }),
        expect.any(Number),
      );
      expect(erroredSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Caused by: java.lang.RuntimeException: Failed to load config') }),
        expect.any(Number),
      );
      expect(erroredSpy).not.toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: 'Build failed before test execution.' }),
        expect.any(Number),
      );
    });

    it('should focus noisy multi-project build failures on the concrete error block and keep deeper stack traces', async () => {
      const run = createMockRun();
      const erroredSpy = run.errored;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'blocked by dependency compile', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'Spec', testName: 'blocked by dependency compile' });

      const unrelatedWorkspaceLines = Array.from({ length: 18 }, (_, index) =>
        `Included build ':lib${index + 1}' prepared task graph`,
      );

      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: [
          ...unrelatedWorkspaceLines,
          '> Task :app:compileGroovy FAILED',
          '* What went wrong:',
          "Execution failed for task ':app:compileGroovy'.",
          'Caused by: java.lang.RuntimeException: Failed to compile workspace dependency',
          '    at com.example.Top.one(Top.java:10)',
          '    at com.example.Top.two(Top.java:20)',
          '    at com.example.Top.three(Top.java:30)',
          '    at com.example.Top.four(Top.java:40)',
          '    at com.example.Top.five(Top.java:50)',
          '    at com.example.Top.six(Top.java:60)',
          'Caused by: org.gradle.api.GradleException: Symbol resolution crashed',
          '    at com.example.Dependency.one(Dependency.java:11)',
          '    at com.example.Dependency.two(Dependency.java:22)',
          '    at com.example.Dependency.three(Dependency.java:33)',
          '    at com.example.Dependency.four(Dependency.java:44)',
          '* Try:',
          '> Run with --stacktrace option to get the stack trace.',
          'BUILD FAILED in 4s',
        ].join('\n'),
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      const errorCall = erroredSpy.mock.calls.find((call: any[]) => call[0] === test1);
      expect(errorCall).toBeDefined();

      const errorMsg = errorCall![1].message;
      expect(errorMsg).toContain("Execution failed for task ':app:compileGroovy'.");
      expect(errorMsg).toContain('Caused by: java.lang.RuntimeException: Failed to compile workspace dependency');
      expect(errorMsg).toContain('at com.example.Top.six(Top.java:60)');
      expect(errorMsg).toContain('at com.example.Dependency.four(Dependency.java:44)');
      expect(errorMsg).not.toContain("Included build ':lib1' prepared task graph");
      expect(errorMsg).not.toContain('Run with --stacktrace option to get the stack trace.');
    });

    it('should skip generic compiler-output hint and show concrete compiler error', async () => {
      const run = createMockRun();
      const erroredSpy = run.errored;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'passing test', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'Spec', testName: 'passing test' });

      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: [
          '> Task :compileTestGroovy FAILED',
          '> Compilation failed; see the compiler error output for details.',
          String.raw`C:\work\src\test\groovy\Spec.groovy: 12: unable to resolve class MissingType`,
          'BUILD FAILED',
        ].join('\n'),
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      expect(erroredSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('unable to resolve class MissingType') }),
        expect.any(Number),
      );
      expect(erroredSpy).not.toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Compilation failed; see the compiler error output for details') }),
        expect.any(Number),
      );
    });

    it('should filter > Task lines without status suffixes from per-test build failure message', async () => {
      const run = createMockRun();
      const erroredSpy = run.errored;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should work', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'MySpec', testName: 'should work' });

      // Simulate a large multi-subproject build where many > Task lines appear
      // without any status suffix (Gradle prints these when a task starts executing)
      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: [
          '> Configure project :core',
          '> Configure project :api',
          '> Task :core:compileJava',
          '> Task :core:processResources',
          '> Task :core:classes',
          '> Task :api:compileJava',
          '> Task :api:processResources',
          '> Task :api:classes',
          '> Task :api:jar',
          '> Task :service:compileJava',
          '> Task :service:processResources',
          '> Task :service:classes',
          '> Task :service:compileTestGroovy FAILED',
          '',
          'startup failed:',
          '/workspace/src/test/groovy/MySpec.groovy: 5: unable to resolve class SomeUnknownDependency',
          ' @ line 5, column 1.',
          '   import com.example.SomeUnknownDependency',
          '   ^',
          '',
          'Compilation failed; see the compiler error output for details.',
          '',
          'BUILD FAILED',
        ].join('\n'),
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      // Per-test error should contain the actual compilation error
      expect(erroredSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('unable to resolve class SomeUnknownDependency') }),
        expect.any(Number),
      );
      // Per-test error must NOT contain > Task lines (with or without status suffix)
      const errorCall = erroredSpy.mock.calls.find((c: any) => c[0] === test1);
      expect(errorCall).toBeDefined();
      const errorMsg = errorCall![1].message;
      expect(errorMsg).not.toMatch(/>\s*Task\s+/i);
      // Per-test error must NOT contain > Configure project lines
      expect(errorMsg).not.toMatch(/>\s*Configure project\s+/i);
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

    it('should mark passing test as passed when only other tests fail in the batch', async () => {
      const { extractErrorForTest } = await import('./services/SpockErrorParser');
      const extractMock = vi.mocked(extractErrorForTest);
      extractMock.mockImplementation(
        (_output: string, _className: string, testName: string) =>
          testName === 'should subtract' ? 'Condition not satisfied:\n  result == 3' : 'Test failed',
      );

      const run = createMockRun();
      const passedSpy = run.passed;
      const failedSpy = run.failed;
      const erroredSpy = run.errored;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should add', vscode.Uri.file('/workspace/project/spec.groovy'));
      const test2 = controller.createTestItem('t2', 'should subtract', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'CalculatorSpec', testName: 'should add' });
      treeManager.testData.set(test2, { type: 'test', className: 'CalculatorSpec', testName: 'should subtract' });

      // Simulate real-time output where test1 passes and test2 fails
      // Error lines come AFTER the FAILED marker, before the next test
      executionService.executeBatch.mockImplementation(async (opts: any) => {
        if (opts.onOutputLine) {
          opts.onOutputLine('com.example.CalculatorSpec > should add PASSED');
          opts.onOutputLine('com.example.CalculatorSpec > should subtract FAILED');
          opts.onOutputLine('Condition not satisfied:');
          opts.onOutputLine('  result == 3');
          opts.onOutputLine('  |         |');
          opts.onOutputLine('  0         false');
        }
        return {
          success: false,
          output: [
            'com.example.CalculatorSpec > should add PASSED',
            'com.example.CalculatorSpec > should subtract FAILED',
            'Condition not satisfied:',
            '  result == 3',
          ].join('\n'),
        };
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1, test2]);
      await coordinator.runHandler(false, request, token);

      // test1 was seen as PASSED in real-time → should be passed
      expect(passedSpy).toHaveBeenCalledWith(test1, expect.any(Number));
      // test2 was seen as FAILED → should be failed with error details from buffered lines
      expect(failedSpy).toHaveBeenCalledWith(
        test2,
        expect.objectContaining({ message: expect.stringContaining('Condition not satisfied') }),
        expect.any(Number),
      );
      // Neither should be errored
      expect(erroredSpy).not.toHaveBeenCalled();

      // Restore default mock
      extractMock.mockImplementation(() => 'Test failed');
    });

    it('should filter > Task noise lines from buffered failure error lines', async () => {
      const { extractErrorForTest } = await import('./services/SpockErrorParser');
      const extractMock = vi.mocked(extractErrorForTest);
      // Verify the scoped output passed to extractErrorForTest does NOT contain > Task lines
      extractMock.mockImplementation((output: string, _className: string, _testName: string) => {
        // If > Task lines leaked into the scoped output, the test will fail
        if (/>\s*Task\s+/i.test(output)) {
          return 'BUG: > Task lines leaked into error output';
        }
        return 'Condition not satisfied:\n  result == 3';
      });

      const run = createMockRun();
      const failedSpy = run.failed;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should add', vscode.Uri.file('/workspace/project/spec.groovy'));
      const test2 = controller.createTestItem('t2', 'should subtract', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'CalculatorSpec', testName: 'should add' });
      treeManager.testData.set(test2, { type: 'test', className: 'CalculatorSpec', testName: 'should subtract' });

      // Simulate output with many > Task lines between FAILED and the error details
      executionService.executeBatch.mockImplementation(async (opts: any) => {
        if (opts.onOutputLine) {
          opts.onOutputLine('com.example.CalculatorSpec > should subtract FAILED');
          // Many > Task lines from subproject builds
          opts.onOutputLine('> Task :sub1:compileJava UP-TO-DATE');
          opts.onOutputLine('> Task :sub2:compileJava UP-TO-DATE');
          opts.onOutputLine('> Task :sub3:processResources NO-SOURCE');
          opts.onOutputLine('> Task :sub4:classes UP-TO-DATE');
          opts.onOutputLine('> Task :sub5:compileTestJava UP-TO-DATE');
          opts.onOutputLine('> Task :sub6:compileTestGroovy UP-TO-DATE');
          opts.onOutputLine('> Task :sub7:jar UP-TO-DATE');
          opts.onOutputLine('> Task :sub8:test SKIPPED');
          opts.onOutputLine('> Task :sub9:check UP-TO-DATE');
          opts.onOutputLine('> Task :sub10:build UP-TO-DATE');
          // Actual error details
          opts.onOutputLine('Condition not satisfied:');
          opts.onOutputLine('  result == 3');
          // Next test triggers flush
          opts.onOutputLine('com.example.CalculatorSpec > should add PASSED');
        }
        return { success: false, output: '' };
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1, test2]);
      await coordinator.runHandler(false, request, token);

      // The error message should NOT contain the "BUG" string
      // (which extractMock returns when > Task lines are present in the scoped output)
      expect(failedSpy).toHaveBeenCalledWith(
        test2,
        expect.objectContaining({ message: expect.stringContaining('Condition not satisfied') }),
        expect.any(Number),
      );
      expect(failedSpy).not.toHaveBeenCalledWith(
        test2,
        expect.objectContaining({ message: expect.stringContaining('BUG') }),
        expect.any(Number),
      );

      extractMock.mockImplementation(() => 'Test failed');
    });

    it('should mark unseen test as passed when batch fails due to other tests', async () => {
      const run = createMockRun();
      const passedSpy = run.passed;
      const erroredSpy = run.errored;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should add', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'CalculatorSpec', testName: 'should add' });

      // Batch fails but output has no evidence this test failed and no build failure
      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: 'OtherSpec > other test FAILED\nCondition not satisfied:\n  x == 1',
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      // No per-test failure for test1, no build failure signal → should pass
      expect(passedSpy).toHaveBeenCalledWith(test1, expect.any(Number));
      expect(erroredSpy).not.toHaveBeenCalled();
    });

    it('should report failure with error details during real-time output, not after batch ends', async () => {
      const { extractErrorForTest } = await import('./services/SpockErrorParser');
      const extractMock = vi.mocked(extractErrorForTest);
      extractMock.mockImplementation(
        (_output: string, _className: string, testName: string) =>
          testName === 'should subtract' ? 'Condition not satisfied:\n  1 - 1 == 2' : 'Test failed',
      );

      const run = createMockRun();
      const failedSpy = run.failed;
      const passedSpy = run.passed;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should subtract', vscode.Uri.file('/workspace/project/spec.groovy'));
      const test2 = controller.createTestItem('t2', 'should multiply', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'CalculatorSpec', testName: 'should subtract' });
      treeManager.testData.set(test2, { type: 'test', className: 'CalculatorSpec', testName: 'should multiply' });

      const callOrder: string[] = [];
      // Track call order to prove failure is reported BEFORE second test's pass
      (failedSpy as any).mockImplementation(() => { callOrder.push('failed'); });
      (passedSpy as any).mockImplementation(() => { callOrder.push('passed'); });

      executionService.executeBatch.mockImplementation(async (opts: any) => {
        if (opts.onOutputLine) {
          opts.onOutputLine('CalculatorSpec > should subtract FAILED');
          opts.onOutputLine('Condition not satisfied:');
          opts.onOutputLine('  1 - 1 == 2');
          opts.onOutputLine('  |   |');
          opts.onOutputLine('  0   false');
          opts.onOutputLine('at com.example.CalculatorSpec.should subtract(CalculatorSpec.groovy:15)');
          // Next test boundary triggers flush of the failure above
          opts.onOutputLine('CalculatorSpec > should multiply PASSED');
        }
        return { success: false, output: '' };
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1, test2]);
      await coordinator.runHandler(false, request, token);

      // Failure should be reported with the Condition not satisfied block
      expect(failedSpy).toHaveBeenCalledWith(
        test1,
        expect.objectContaining({ message: expect.stringContaining('Condition not satisfied') }),
        expect.any(Number),
      );
      // The failure must have been reported BEFORE the pass (during real-time output)
      expect(callOrder[0]).toBe('failed');
      expect(callOrder[1]).toBe('passed');

      // Restore default mock
      extractMock.mockImplementation(() => 'Test failed');
    });

    it('should not treat test-only failures as build failures (Gradle "There were failing tests")', async () => {
      const run = createMockRun();
      const passedSpy = run.passed;
      const erroredSpy = run.errored;
      controller.createTestRun = vi.fn(() => run);

      const test1 = controller.createTestItem('t1', 'should add', vscode.Uri.file('/workspace/project/spec.groovy'));
      treeManager.testData.set(test1, { type: 'test', className: 'CalculatorSpec', testName: 'should add' });

      // Simulates Gradle output when tests fail: BUILD FAILED + "There were failing tests"
      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: [
          'OtherSpec > broken test FAILED',
          'Condition not satisfied:',
          '  value == "expected non-null"',
          '> Task :test FAILED',
          '227 tests completed, 23 failed, 1 skipped',
          'FAILURE: Build failed with an exception.',
          '* What went wrong:',
          "Execution failed for task ':test'.",
          '> There were failing tests. See the report at: file:///...',
        ].join('\n'),
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest([test1]);
      await coordinator.runHandler(false, request, token);

      // This test has no per-test failure and the "BUILD FAILED" is from test
      // failures (not compilation), so it should NOT be errored.
      expect(passedSpy).toHaveBeenCalledWith(test1, expect.any(Number));
      expect(erroredSpy).not.toHaveBeenCalled();
    });

    it('should map 10-test synthetic gradle output with 50 pre-build task lines to correct per-test errors', async () => {
      const { extractErrorForTest, hasErrorForTest } = await import('./services/SpockErrorParser');
      const actualParser = await vi.importActual<typeof import('./services/SpockErrorParser')>('./services/SpockErrorParser');
      vi.mocked(extractErrorForTest).mockImplementation(actualParser.extractErrorForTest);
      vi.mocked(hasErrorForTest).mockImplementation(actualParser.hasErrorForTest);

      const run = createMockRun();
      const failedSpy = run.failed;
      const passedSpy = run.passed;
      const erroredSpy = run.errored;
      controller.createTestRun = vi.fn(() => run);

      const className = 'ComprehensiveSpec';
      const testNames = [
        't01 condition failure',
        't02 passes',
        't03 illegal state',
        't04 passes',
        't05 assertion failed error',
        't06 passes',
        't07 missing property',
        't08 passes',
        't09 timeout assertion',
        't10 passes',
      ];

      const tests = testNames.map((name, index) => {
        const item = controller.createTestItem(`t${index + 1}`, name, vscode.Uri.file('/workspace/project/spec.groovy'));
        treeManager.testData.set(item, { type: 'test', className, testName: name });
        return item;
      });

      const preBuildTaskLines = Array.from({ length: 50 }, (_, index) =>
        `> Task :sub${index + 1}:build`,
      );

      const syntheticOutput = [
        ...preBuildTaskLines,
        `${className} > t01 condition failure FAILED`,
        'Condition not satisfied:',
        '  actual == expected',
        '  |      |  |',
        '  4      |  5',
        '         false',
        '    at com.example.ComprehensiveSpec.t01 condition failure(ComprehensiveSpec.groovy:11)',

        `${className} > t02 passes PASSED`,

        `${className} > t03 illegal state FAILED`,
        'Caused by: java.lang.IllegalStateException: db offline',
        '    at com.example.Service.connect(Service.java:42)',

        `${className} > t04 passes PASSED`,

        `${className} > t05 assertion failed error FAILED`,
        `${className} > t05 assertion failed error STANDARD_ERROR`,
        '    org.opentest4j.AssertionFailedError: expected: <abc> but was: <xyz>',
        '    at com.example.ComprehensiveSpec.t05 assertion failed error(ComprehensiveSpec.groovy:58)',

        `${className} > t06 passes PASSED`,

        `${className} > t07 missing property FAILED`,
        'groovy.lang.MissingPropertyException: No such property: value for class: com.example.Payload',
        '    at com.example.ComprehensiveSpec.t07 missing property(ComprehensiveSpec.groovy:77)',

        `${className} > t08 passes PASSED`,

        `${className} > t09 timeout assertion FAILED`,
        'java.lang.AssertionError: expected completion under 100ms but was 501ms',
        '    at com.example.ComprehensiveSpec.t09 timeout assertion(ComprehensiveSpec.groovy:99)',

        `${className} > t10 passes PASSED`,
        '10 tests completed, 5 failed',
      ].join('\n');

      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: syntheticOutput,
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest(tests);
      await coordinator.runHandler(false, request, token);

      expect(failedSpy).toHaveBeenCalledTimes(5);
      expect(passedSpy).toHaveBeenCalledTimes(5);
      expect(erroredSpy).not.toHaveBeenCalled();

      const failedMessagesByTest = new Map(
        failedSpy.mock.calls.map((call: any[]) => [call[0], call[1]?.message as string]),
      );

      expect(failedMessagesByTest.get(tests[0])).toBe([
        'Condition not satisfied:',
        '  actual == expected',
        '  |      |  |',
        '  4      |  5',
        '         false',
        '',
        'at com.example.ComprehensiveSpec.t01 condition failure(ComprehensiveSpec.groovy:11)',
      ].join('\n'));

      expect(failedMessagesByTest.get(tests[2])).toBe([
        'Caused by: java.lang.IllegalStateException: db offline',
        'at com.example.Service.connect(Service.java:42)',
      ].join('\n'));

      expect(failedMessagesByTest.get(tests[4])).toBe([
        'org.opentest4j.AssertionFailedError: expected: <abc> but was: <xyz>',
        'at com.example.ComprehensiveSpec.t05 assertion failed error(ComprehensiveSpec.groovy:58)',
      ].join('\n'));

      expect(failedMessagesByTest.get(tests[6])).toBe([
        'groovy.lang.MissingPropertyException: No such property: value for class: com.example.Payload',
        '',
        'at com.example.ComprehensiveSpec.t07 missing property(ComprehensiveSpec.groovy:77)',
      ].join('\n'));

      expect(failedMessagesByTest.get(tests[8])).toBe([
        'java.lang.AssertionError: expected completion under 100ms but was 501ms',
        '',
        'at com.example.ComprehensiveSpec.t09 timeout assertion(ComprehensiveSpec.groovy:99)',
      ].join('\n'));

      for (const call of failedSpy.mock.calls) {
        const msg = call[1]?.message as string;
        expect(msg).not.toContain('> Task :sub1:build');
        expect(msg).not.toContain('> Task :sub50:build');
      }

      vi.mocked(extractErrorForTest).mockImplementation(() => 'Test failed');
      vi.mocked(hasErrorForTest).mockImplementation(() => false);
    });

    it('should mark selected tests as errored for synthetic gradle build failure output', async () => {
      const run = createMockRun();
      const erroredSpy = run.errored;
      const failedSpy = run.failed;
      const passedSpy = run.passed;
      controller.createTestRun = vi.fn(() => run);

      const className = 'BuildFailureSpec';
      const testNames = [
        'compilation blocked one',
        'compilation blocked two',
        'compilation blocked three',
      ];

      const tests = testNames.map((name, index) => {
        const item = controller.createTestItem(`bf-${index + 1}`, name, vscode.Uri.file('/workspace/project/spec.groovy'));
        treeManager.testData.set(item, { type: 'test', className, testName: name });
        return item;
      });

      const preBuildTaskLines = Array.from({ length: 20 }, (_, index) =>
        `> Task :module${index + 1}:assemble`,
      );

      const syntheticBuildFailureOutput = [
        ...preBuildTaskLines,
        '> Task :compileTestGroovy FAILED',
        'Startup failed:',
        "src/test/groovy/com/example/BuildFailureSpec.groovy: 23: unable to resolve class MissingCollaborator",
        ' @ line 23, column 17.',
        '                   MissingCollaborator collaborator = new MissingCollaborator()',
        '                   ^',
        '',
        '1 error',
        '',
        'FAILURE: Build failed with an exception.',
        '',
        '* What went wrong:',
        "Execution failed for task ':compileTestGroovy'.",
        '> Compilation failed; see the compiler error output for details.',
        '',
        '* Try:',
        '> Run with --stacktrace option to get the stack trace.',
        '',
        'BUILD FAILED in 4s',
      ].join('\n');

      executionService.executeBatch.mockResolvedValue({
        success: false,
        output: syntheticBuildFailureOutput,
      });
      resultParser.parseClassTestResults.mockResolvedValue(new Map());

      const token = createCancellationToken();
      const request = new vscode.TestRunRequest(tests);
      await coordinator.runHandler(false, request, token);

      expect(erroredSpy).toHaveBeenCalledTimes(3);
      expect(failedSpy).not.toHaveBeenCalled();
      expect(passedSpy).not.toHaveBeenCalled();

      const expectedErroredMessage = [
        'Startup failed:',
        'src/test/groovy/com/example/BuildFailureSpec.groovy: 23: unable to resolve class MissingCollaborator',
        '@ line 23, column 17.',
        'MissingCollaborator collaborator = new MissingCollaborator()',
        '^',
        '1 error',
        '* What went wrong:',
        "Execution failed for task ':compileTestGroovy'.",
      ].join('\n');

      const erroredMessagesByTest = new Map(
        erroredSpy.mock.calls.map((call: any[]) => [call[0], call[1]?.message as string]),
      );

      for (const testItem of tests) {
        expect(erroredMessagesByTest.get(testItem)).toBe(expectedErroredMessage);
      }
    });
  });
});
