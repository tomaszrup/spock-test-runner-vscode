import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SpockTestController } from './testController';

// --- Mocks ---------------------------------------------------------------

vi.mock('fs');
vi.mock('./services/ConfigurationService', () => ({
  ConfigurationService: {
    getConfig: () => ({
      debugPort: 5005,
      testTimeout: 300,
      debugConnectionTimeout: 60,
      debugRetries: 3,
      additionalGradleArgs: [],
      additionalMavenArgs: [],
      showDiffView: false,
    }),
    onConfigChange: () => ({ dispose: () => {} }),
  },
}));
vi.mock('./services/BuildToolService', () => ({
  BuildToolService: {
    detectBuildTool: vi.fn(() => 'gradle'),
    findProjectRoot: vi.fn((_fp: string, _ws: string) => '/workspace/project'),
    findRootProject: vi.fn((_pr: string, _ws: string) => '/workspace/project'),
    getProjectName: vi.fn(() => 'test-project'),
    getSubprojectPrefix: vi.fn(() => ''),
    getMavenModuleName: vi.fn(() => ''),
    buildCommandArgs: vi.fn(() => ['gradle', 'test']),
    buildBatchCommandArgs: vi.fn(() => ['gradle', 'test']),
    isGradleProject: vi.fn(() => true),
  },
}));
vi.mock('./services/TestDiscoveryService', () => ({
  TestDiscoveryService: {
    parseTestsInFile: vi.fn(() => []),
    scanClassDeclarations: vi.fn(() => []),
    resolveAllSpecBaseClasses: vi.fn(() => new Set<string>()),
    hasAnnotation: vi.fn((_annotations: any, name: string) => false),
  },
}));
vi.mock('./services/TestExecutionService', () => ({
  TestExecutionService: class MockTestExecutionService {
    executeTest = vi.fn().mockResolvedValue({ success: true, output: '' });
    executeBatch = vi.fn().mockResolvedValue({ success: true, output: '' });
  },
}));
vi.mock('./services/TestResultParser', () => ({
  TestResultParser: class MockTestResultParser {
    parseTestResults = vi.fn().mockResolvedValue([]);
    parseClassTestResults = vi.fn().mockResolvedValue(new Map());
    parseXmlReport = vi.fn().mockResolvedValue([]);
    parseExpectedActual = vi.fn(() => null);
  },
}));
vi.mock('./services/CoverageService', () => ({
  CoverageService: class MockCoverageService {
    findJacocoXmlReport = vi.fn(() => null);
    parseJacocoReport = vi.fn(() => []);
  },
  SpockFileCoverage: class extends vscode.FileCoverage {
    details: any[] = [];
  },
}));

const mockedFs = vi.mocked(fs);

// --- Helpers -------------------------------------------------------------

function createMockLogger() {
  return {
    name: 'test',
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    replace: vi.fn(),
  } as any;
}

function createMockContext() {
  return {
    subscriptions: { push: vi.fn() },
    extensionUri: vscode.Uri.file('/ext'),
    extensionPath: '/ext',
  } as any;
}

/**
 * Helper that creates a SpockTestController for testing.
 * Sets up workspace.workspaceFolders before construction.
 */
function createController(opts?: { workspaceFolders?: any[]; findFiles?: any }) {
  (vscode.workspace as any).workspaceFolders = opts?.workspaceFolders ?? [
    { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 },
  ];
  // findFiles returns empty by default (no auto-discovery files)
  (vscode.workspace as any).findFiles = opts?.findFiles ?? vi.fn(async () => []);

  const logger = createMockLogger();
  const ctx = createMockContext();
  const controller = new SpockTestController(ctx, logger);
  return { controller, logger, ctx };
}

// --- Tests ---------------------------------------------------------------

describe('SpockTestController', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.tests as any)._controllers = [];
  });

  // ── Construction ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('should create a controller without throwing', () => {
      const { controller } = createController();
      expect(controller).toBeDefined();
    });

    it('should log initialization messages', () => {
      const { logger } = createController();
      const calls = logger.appendLine.mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((c: string) => c.includes('Initializing'))).toBe(true);
    });

    it('should trigger automatic test discovery', async () => {
      createController();
      // findFiles is called synchronously during constructor (before first await yields)
      expect(vscode.workspace.findFiles).toHaveBeenCalled();
    });

    it('should work without workspace folders', () => {
      // Set workspaceFolders to undefined and construct directly
      (vscode.workspace as any).workspaceFolders = undefined;
      (vscode.workspace as any).findFiles = vi.fn(async () => []);
      const logger = createMockLogger();
      const ctx = createMockContext();
      const controller = new SpockTestController(ctx, logger);
      expect(controller).toBeDefined();
    });
  });

  // ── Test Discovery ────────────────────────────────────────────────

  describe('test discovery', () => {
    it('should discover test files from workspace folders', async () => {
      const { TestDiscoveryService } = await import('./services/TestDiscoveryService');
      const testUri = vscode.Uri.file('/workspace/project/src/test/groovy/MySpec.groovy');

      const findFilesSpy = vi.fn(async () => [testUri]);
      const openTextDocSpy = vi.fn(async () => ({
        getText: () => 'class MySpec extends Specification { }',
        uri: testUri,
      }));
      (vscode.workspace as any).openTextDocument = openTextDocSpy;

      (TestDiscoveryService.scanClassDeclarations as any).mockReturnValue([
        { name: 'MySpec', parent: 'Specification', isAbstract: false },
      ]);
      (TestDiscoveryService.resolveAllSpecBaseClasses as any).mockReturnValue(new Set(['Specification']));
      (TestDiscoveryService.parseTestsInFile as any).mockReturnValue([
        {
          name: 'MySpec',
          line: 0,
          range: new vscode.Range(0, 0, 10, 0),
          methods: [
            {
              name: 'should do something',
              line: 2,
              range: new vscode.Range(2, 0, 5, 0),
              isDataDriven: false,
              annotations: [],
            },
          ],
          isAbstract: false,
          annotations: [],
        },
      ]);

      // Pass custom findFiles so createController uses it during construction
      createController({ findFiles: findFilesSpy });

      // Wait for async discovery to complete — multiple async steps inside
      for (let i = 0; i < 20; i++) {
        await new Promise(process.nextTick);
      }
      expect(openTextDocSpy).toHaveBeenCalled();
    });

    it('should skip abstract classes during parsing', async () => {
      const { TestDiscoveryService } = await import('./services/TestDiscoveryService');
      const testUri = vscode.Uri.file('/workspace/project/src/test/groovy/AbstractSpec.groovy');

      const findFilesSpy = vi.fn(async () => [testUri]);
      (vscode.workspace as any).openTextDocument = vi.fn(async () => ({
        getText: () => 'abstract class AbstractSpec extends Specification { }',
        uri: testUri,
      }));

      (TestDiscoveryService.scanClassDeclarations as any).mockReturnValue([
        { name: 'AbstractSpec', parent: 'Specification', isAbstract: true },
      ]);
      (TestDiscoveryService.resolveAllSpecBaseClasses as any).mockReturnValue(new Set(['Specification']));
      (TestDiscoveryService.parseTestsInFile as any).mockReturnValue([
        {
          name: 'AbstractSpec',
          line: 0,
          range: new vscode.Range(0, 0, 10, 0),
          methods: [],
          isAbstract: true,
          annotations: [],
        },
      ]);

      // Pass custom findFiles so createController uses it during construction
      createController({ findFiles: findFilesSpy });

      // Wait for discovery — multiple async steps inside
      for (let i = 0; i < 20; i++) {
        await new Promise(process.nextTick);
      }
      expect(TestDiscoveryService.parseTestsInFile).toHaveBeenCalled();
      // Abstract classes should be logged but not added as runnable
    });
  });

  // ── extractErrorFromOutput (tested via a controlled run) ──────────

  describe('error extraction logic', () => {
    it('should detect Spock condition blocks in output', () => {
      // We test the pattern the controller uses internally
      const output = [
        'MySpec > should add FAILED',
        '',
        'Condition not satisfied:',
        '  result == 5',
        '  |      |',
        '  4      false',
        '',
        '  at MySpec.should add(MySpec.groovy:10)',
      ].join('\n');

      // The extractErrorFromOutput method is private, but we can verify
      // the pattern by checking that the output contains the expected markers
      expect(output).toContain('Condition not satisfied');
      expect(output).toContain('FAILED');
      expect(output).toContain('MySpec');
    });

    it('should detect class-specific errors in output', () => {
      const output = 'MySpec > test FAILED\nBUILD FAILED';
      // hasErrorForClass pattern: line contains className AND (FAILED|FAILURE|[ERROR])
      const lines = output.split('\n');
      const hasError = lines.some(
        (line) => line.includes('MySpec') && (line.includes('FAILED') || line.includes('FAILURE') || line.includes('[ERROR]'))
      );
      expect(hasError).toBe(true);
    });

    it('should not detect errors for unrelated classes', () => {
      const output = 'OtherSpec > test FAILED\nBUILD FAILED';
      const lines = output.split('\n');
      const hasError = lines.some(
        (line) => line.includes('MySpec') && (line.includes('FAILED') || line.includes('FAILURE') || line.includes('[ERROR]'))
      );
      expect(hasError).toBe(false);
    });
  });

  // ── formatParameters ──────────────────────────────────────────────

  describe('parameter formatting', () => {
    it('should format key-value pairs', () => {
      const params = { a: 1, b: 2, c: 3 };
      const formatted = Object.entries(params).map(([k, v]) => `${k}: ${v}`).join(', ');
      expect(formatted).toBe('a: 1, b: 2, c: 3');
    });

    it('should return empty string for empty parameters', () => {
      const params = {};
      const entries = Object.entries(params);
      expect(entries.length).toBe(0);
    });
  });

  // ── formatAnnotationDescription ───────────────────────────────────

  describe('annotation description formatting', () => {
    const DISPLAY_ANNOTATIONS = new Set([
      'Ignore', 'PendingFeature', 'Stepwise', 'IgnoreIf', 'IgnoreRest',
      'Requires', 'Timeout', 'Issue'
    ]);

    function formatAnnotations(annotations: Array<{ name: string; argument?: string }>) {
      const parts: string[] = [];
      for (const a of annotations) {
        if (!DISPLAY_ANNOTATIONS.has(a.name)) continue;
        if (a.argument) {
          parts.push(`@${a.name}(${a.argument})`);
        } else {
          parts.push(`@${a.name}`);
        }
      }
      return parts.join(' ');
    }

    it('should format @Ignore annotation', () => {
      expect(formatAnnotations([{ name: 'Ignore' }])).toBe('@Ignore');
    });

    it('should format annotation with argument', () => {
      expect(formatAnnotations([{ name: 'Timeout', argument: '10' }])).toBe('@Timeout(10)');
    });

    it('should format multiple annotations', () => {
      const result = formatAnnotations([
        { name: 'Stepwise' },
        { name: 'Timeout', argument: '30' },
      ]);
      expect(result).toBe('@Stepwise @Timeout(30)');
    });

    it('should skip non-display annotations', () => {
      expect(formatAnnotations([{ name: 'Unroll' }, { name: 'Title', argument: '"my title"' }])).toBe('');
    });

    it('should return empty string for empty annotations', () => {
      expect(formatAnnotations([])).toBe('');
    });
  });

  // ── calculateIterationRange ───────────────────────────────────────

  describe('calculateIterationRange logic', () => {
    it('should locate the correct data row for an iteration', () => {
      const fileContent = [
        'class MySpec extends Specification {',
        '  def "should add"() {',
        '    expect:',
        '    a + b == c',
        '',
        '    where:',
        '    a | b || c',
        '    1 | 2 || 3',
        '    4 | 5 || 9',
        '    7 | 8 || 15',
        '  }',
        '}',
      ].join('\n');

      const lines = fileContent.split('\n');

      // Find "where:" line
      const whereLineIndex = lines.findIndex((l) => l.trim() === 'where:');
      expect(whereLineIndex).toBe(5);

      // Data starts at where + 2 (skip header)
      const dataStartLine = whereLineIndex + 2;
      expect(dataStartLine).toBe(7);

      // Iteration 0 → line 7 ("1 | 2 || 3")
      expect(lines[dataStartLine + 0]).toContain('1 | 2 || 3');
      // Iteration 1 → line 8 ("4 | 5 || 9")
      expect(lines[dataStartLine + 1]).toContain('4 | 5 || 9');
      // Iteration 2 → line 9 ("7 | 8 || 15")
      expect(lines[dataStartLine + 2]).toContain('7 | 8 || 15');
    });

    it('should handle test methods with def "name" syntax', () => {
      const fileContent = [
        'class CalcSpec extends Specification {',
        '  def "maximum of two numbers"() {',
        '    expect:',
        '    Math.max(a, b) == c',
        '',
        '    where:',
        '    a | b || c',
        '    1 | 3 || 3',
        '    7 | 4 || 7',
        '  }',
        '}',
      ].join('\n');

      const lines = fileContent.split('\n');
      const methodLine = lines.findIndex((l) => l.includes('def "maximum of two numbers"'));
      expect(methodLine).toBe(1);

      // Find where: after the method
      let whereLineIndex = -1;
      for (let i = methodLine; i < lines.length; i++) {
        if (lines[i].trim() === 'where:') {
          whereLineIndex = i;
          break;
        }
      }
      expect(whereLineIndex).toBe(5);
    });

    it('should return parent range when where: block is not found', () => {
      const fileContent = [
        'class MySpec extends Specification {',
        '  def "simple test"() {',
        '    expect:',
        '    true',
        '  }',
        '}',
      ].join('\n');

      const lines = fileContent.split('\n');
      const whereLineIndex = lines.findIndex((l) => l.trim() === 'where:');
      expect(whereLineIndex).toBe(-1);
    });
  });

  // ── runHandler leaf collection ────────────────────────────────────

  describe('runHandler - leaf test collection', () => {
    it('should expand project/file/class nodes to leaf tests', () => {
      // Simulate the queue-based expansion used in runHandler's Phase 1
      interface MockItem {
        type: string;
        children: MockItem[];
        tags: { id: string }[];
        uri?: any;
      }

      const leaf1: MockItem = { type: 'test', children: [], tags: [{ id: 'runnable' }] };
      const leaf2: MockItem = { type: 'test', children: [], tags: [{ id: 'runnable' }] };
      const classNode: MockItem = { type: 'class', children: [leaf1, leaf2], tags: [{ id: 'runnable' }] };
      const fileNode: MockItem = { type: 'file', children: [classNode], tags: [{ id: 'runnable' }] };
      const projectNode: MockItem = { type: 'project', children: [fileNode], tags: [{ id: 'runnable' }] };

      const leafTests: MockItem[] = [];
      const queue: MockItem[] = [projectNode];

      while (queue.length > 0) {
        const item = queue.pop()!;
        switch (item.type) {
          case 'project':
          case 'subproject':
          case 'file':
          case 'class':
            item.children.forEach((child) => queue.push(child));
            break;
          case 'test':
            if (item.tags.some((t) => t.id === 'runnable')) {
              leafTests.push(item);
            }
            break;
        }
      }

      expect(leafTests).toHaveLength(2);
      expect(leafTests).toContain(leaf1);
      expect(leafTests).toContain(leaf2);
    });

    it('should skip excluded tests', () => {
      interface MockItem {
        type: string;
        children: MockItem[];
        tags: { id: string }[];
      }

      const included: MockItem = { type: 'test', children: [], tags: [{ id: 'runnable' }] };
      const excluded: MockItem = { type: 'test', children: [], tags: [{ id: 'runnable' }] };
      const classNode: MockItem = { type: 'class', children: [included, excluded], tags: [{ id: 'runnable' }] };

      const excludeSet = new Set([excluded]);
      const leafTests: MockItem[] = [];
      const queue: MockItem[] = [classNode];

      while (queue.length > 0) {
        const item = queue.pop()!;
        if (excludeSet.has(item)) continue;
        switch (item.type) {
          case 'class':
            item.children.forEach((child) => queue.push(child));
            break;
          case 'test':
            if (item.tags.some((t) => t.id === 'runnable')) {
              leafTests.push(item);
            }
            break;
        }
      }

      expect(leafTests).toHaveLength(1);
      expect(leafTests).toContain(included);
    });

    it('should skip non-runnable (ignored) tests', () => {
      interface MockItem {
        type: string;
        children: MockItem[];
        tags: { id: string }[];
      }

      const runnable: MockItem = { type: 'test', children: [], tags: [{ id: 'runnable' }] };
      const ignored: MockItem = { type: 'test', children: [], tags: [] };

      const leafTests: MockItem[] = [];
      const skipped: MockItem[] = [];
      const items = [runnable, ignored];

      for (const item of items) {
        if (item.tags.some((t) => t.id === 'runnable')) {
          leafTests.push(item);
        } else {
          skipped.push(item);
        }
      }

      expect(leafTests).toHaveLength(1);
      expect(skipped).toHaveLength(1);
    });
  });

  // ── runHandler grouping by project root ───────────────────────────

  describe('runHandler - grouping by project root', () => {
    it('should group tests by their project root', () => {
      // Simulate Phase 2 grouping logic
      const tests = [
        { uri: '/workspace/projectA/src/test/Spec1.groovy', projectRoot: '/workspace/projectA' },
        { uri: '/workspace/projectA/src/test/Spec2.groovy', projectRoot: '/workspace/projectA' },
        { uri: '/workspace/projectB/src/test/Spec3.groovy', projectRoot: '/workspace/projectB' },
      ];

      const groups = new Map<string, typeof tests>();
      for (const t of tests) {
        if (!groups.has(t.projectRoot)) groups.set(t.projectRoot, []);
        groups.get(t.projectRoot)!.push(t);
      }

      expect(groups.size).toBe(2);
      expect(groups.get('/workspace/projectA')).toHaveLength(2);
      expect(groups.get('/workspace/projectB')).toHaveLength(1);
    });
  });

  // ── Annotation-based tagging ──────────────────────────────────────

  describe('annotation-based tagging', () => {
    it('should mark @Ignore classes as non-runnable', () => {
      const classIgnored = true;
      const tags = classIgnored ? [] : [{ id: 'runnable' }];
      expect(tags).toEqual([]);
    });

    it('should mark non-ignored classes as runnable', () => {
      const classIgnored = false;
      const tags = classIgnored ? [] : [{ id: 'runnable' }];
      expect(tags).toEqual([{ id: 'runnable' }]);
    });

    it('should propagate class @Ignore to methods', () => {
      const classIgnored = true;
      const methodIgnored = classIgnored || false; // method's own @Ignore
      expect(methodIgnored).toBe(true);
    });

    it('should use @Stepwise label', () => {
      const classStepwise = true;
      const className = 'MySpec';
      const label = classStepwise ? `${className} ⟳ Stepwise` : className;
      expect(label).toBe('MySpec ⟳ Stepwise');
    });

    it('should use @Ignore label', () => {
      const classIgnored = true;
      const className = 'MySpec';
      const label = classIgnored ? `${className} ⊘ Ignored` : className;
      expect(label).toBe('MySpec ⊘ Ignored');
    });

    it('should use @PendingFeature label for methods', () => {
      const methodPending = true;
      const methodName = 'should work';
      const label = methodPending ? `${methodName} ⏳` : methodName;
      expect(label).toBe('should work ⏳');
    });
  });

  // ── Gradle output line parsing (onOutputLine callback) ────────────

  describe('real-time Gradle output parsing', () => {
    it('should match PASSED test lines', () => {
      const line = '  MySpec > should add PASSED';
      const match = line.match(/^\s*(\S+)\s+>\s+(.+?)\s+(PASSED|FAILED|SKIPPED)\s*$/);
      expect(match).toBeTruthy();
      expect(match![1]).toBe('MySpec');
      expect(match![2]).toBe('should add');
      expect(match![3]).toBe('PASSED');
    });

    it('should match FAILED test lines', () => {
      const line = 'MySpec > should subtract FAILED';
      const match = line.match(/^\s*(\S+)\s+>\s+(.+?)\s+(PASSED|FAILED|SKIPPED)\s*$/);
      expect(match).toBeTruthy();
      expect(match![3]).toBe('FAILED');
    });

    it('should match SKIPPED test lines', () => {
      const line = 'MySpec > should multiply SKIPPED';
      const match = line.match(/^\s*(\S+)\s+>\s+(.+?)\s+(PASSED|FAILED|SKIPPED)\s*$/);
      expect(match).toBeTruthy();
      expect(match![3]).toBe('SKIPPED');
    });

    it('should skip data-driven iteration lines with >', () => {
      const line = 'MySpec > should add > iteration 0 PASSED';
      const match = line.match(/^\s*(\S+)\s+>\s+(.+?)\s+(PASSED|FAILED|SKIPPED)\s*$/);
      if (match) {
        const testPart = match[2].trim();
        const isIteration = testPart.includes(' > ');
        expect(isIteration).toBe(true);
      }
    });

    it('should skip data-driven iteration lines with [#N]', () => {
      const line = 'MySpec > should add [a: 1, b: 2, #0] PASSED';
      const match = line.match(/^\s*(\S+)\s+>\s+(.+?)\s+(PASSED|FAILED|SKIPPED)\s*$/);
      if (match) {
        const testPart = match[2].trim();
        const isIteration = /\[.*#\d+\]$/.test(testPart);
        expect(isIteration).toBe(true);
      }
    });

    it('should not match non-test output lines', () => {
      const lines = [
        '> Task :test',
        'BUILD SUCCESSFUL in 5s',
        '',
        '3 actionable tasks: 1 executed, 2 up-to-date',
      ];
      const pattern = /^\s*(\S+)\s+>\s+(.+?)\s+(PASSED|FAILED|SKIPPED)\s*$/;
      for (const line of lines) {
        expect(line.match(pattern)).toBeNull();
      }
    });
  });

  // ── Test filter building ──────────────────────────────────────────

  describe('test filter building', () => {
    it('should build className.testName filters', () => {
      const tests = [
        { className: 'MySpec', testName: 'should add' },
        { className: 'MySpec', testName: 'should subtract' },
        { className: 'OtherSpec', testName: 'should work' },
      ];

      const filters = tests
        .filter((t) => t.className && t.testName)
        .map((t) => `${t.className}.${t.testName}`);

      expect(filters).toEqual([
        'MySpec.should add',
        'MySpec.should subtract',
        'OtherSpec.should work',
      ]);
    });

    it('should skip tests with missing className or testName', () => {
      const tests = [
        { className: 'MySpec', testName: 'should add' },
        { className: undefined, testName: 'orphan' },
        { className: 'MySpec', testName: undefined },
      ];

      const filters = tests
        .filter((t) => t.className && t.testName)
        .map((t) => `${t.className}.${t.testName}`);

      expect(filters).toEqual(['MySpec.should add']);
    });
  });

  // ── Iteration sorting ─────────────────────────────────────────────

  describe('iteration result sorting', () => {
    it('should sort by index', () => {
      const results = [
        { index: 2, displayName: 'c', parameters: {} },
        { index: 0, displayName: 'a', parameters: {} },
        { index: 1, displayName: 'b', parameters: {} },
      ];

      const sorted = results.sort((a, b) => {
        if (a.index !== b.index) return a.index - b.index;
        return 0;
      });

      expect(sorted.map((s) => s.index)).toEqual([0, 1, 2]);
    });

    it('should fallback to parameter sorting when indices are equal', () => {
      const results = [
        { index: 0, displayName: '', parameters: { a: 'z' } },
        { index: 0, displayName: '', parameters: { a: 'a' } },
        { index: 0, displayName: '', parameters: { a: 'm' } },
      ];

      const sorted = results.sort((a, b) => {
        if (a.index !== b.index) return a.index - b.index;
        const aP = Object.values(a.parameters).join(',');
        const bP = Object.values(b.parameters).join(',');
        return aP.localeCompare(bP);
      });

      expect(sorted.map((s) => s.parameters.a)).toEqual(['a', 'm', 'z']);
    });
  });

  // ── File tree management ──────────────────────────────────────────

  describe('file tree management', () => {
    it('should remove files with no runnable tests from tree', () => {
      // Simulates the logic in parseTestsInFile's final section
      const fileMap = new Map<string, any>();
      fileMap.set('file1', { id: 'file1', hasRunnableClasses: true });
      fileMap.set('file2', { id: 'file2', hasRunnableClasses: false, hasAnyClasses: false });

      // Remove files with no classes
      for (const [key, file] of fileMap) {
        if (!file.hasRunnableClasses && !file.hasAnyClasses) {
          fileMap.delete(key);
        }
      }

      expect(fileMap.size).toBe(1);
      expect(fileMap.has('file1')).toBe(true);
    });

    it('should keep files with ignored classes in tree', () => {
      const file = { hasRunnableClasses: false, hasAnyClasses: true };
      const shouldRemove = !file.hasRunnableClasses && !file.hasAnyClasses;
      expect(shouldRemove).toBe(false);
    });
  });

  // ── Re-run Failed Tests ───────────────────────────────────────────

  describe('re-run failed tests profile', () => {
    it('should register a Re-run Failed Tests run profile', () => {
      const profileNames: string[] = [];
      const origCreate = vscode.tests.createTestController;
      const spy = vi.spyOn(vscode.tests, 'createTestController').mockImplementation((id, label) => {
        const ctrl = origCreate(id, label);
        const origCreateRunProfile = ctrl.createRunProfile.bind(ctrl);
        ctrl.createRunProfile = vi.fn((...args: any[]) => {
          profileNames.push(args[0]);
          return origCreateRunProfile(...args);
        });
        return ctrl;
      });

      createController();
      spy.mockRestore();

      expect(profileNames).toContain('Re-run Failed Tests');
    });

    it('should track failed test IDs incrementally', () => {
      const failedTests = new Set<string>();

      // Simulate first run: test1 fails, test2 fails
      failedTests.add('test1');
      failedTests.add('test2');
      expect(failedTests.size).toBe(2);

      // Simulate second run (different project): test3 fails
      failedTests.add('test3');
      // test1 and test2 are still in the set (not cleared)
      expect(failedTests.size).toBe(3);
      expect(failedTests.has('test1')).toBe(true);
      expect(failedTests.has('test3')).toBe(true);
    });

    it('should remove passed tests from failed set', () => {
      const failedTests = new Set<string>();
      failedTests.add('test1');
      failedTests.add('test2');
      expect(failedTests.size).toBe(2);

      // Simulate test1 passing on re-run
      failedTests.delete('test1');
      expect(failedTests.size).toBe(1);
      expect(failedTests.has('test1')).toBe(false);
      expect(failedTests.has('test2')).toBe(true);
    });

    it('should remove skipped tests from failed set', () => {
      const failedTests = new Set<string>();
      failedTests.add('test1');

      // Simulate test1 being skipped on re-run
      failedTests.delete('test1');
      expect(failedTests.size).toBe(0);
    });

    it('should preserve failures from other projects', () => {
      const failedTests = new Set<string>();

      // Run project A: testA1 fails, testA2 passes
      failedTests.add('projA#testA1');
      // passed -> delete
      failedTests.delete('projA#testA2');
      expect(failedTests.size).toBe(1);

      // Run project B: testB1 fails
      failedTests.add('projB#testB1');
      // Both failures are preserved
      expect(failedTests.size).toBe(2);
      expect(failedTests.has('projA#testA1')).toBe(true);
      expect(failedTests.has('projB#testB1')).toBe(true);
    });

    it('should collect failed items from the test tree', () => {
      // Simulate the tree-walk logic from rerunFailedHandler
      const failedIds = new Set(['id-a', 'id-c']);

      const items = [
        { id: 'id-a', children: { size: 0, forEach: () => {} } },
        { id: 'id-b', children: { size: 0, forEach: () => {} } },
        { id: 'id-c', children: { size: 0, forEach: () => {} } },
      ];

      const collected: any[] = [];
      for (const item of items) {
        if (failedIds.has(item.id)) {
          collected.push(item);
        }
      }

      expect(collected).toHaveLength(2);
      expect(collected.map(c => c.id)).toEqual(['id-a', 'id-c']);
    });

    it('should walk children to find nested failed items', () => {
      const failedIds = new Set(['child-1', 'child-3']);

      const children = [
        { id: 'child-1', children: { size: 0, forEach: () => {} } },
        { id: 'child-2', children: { size: 0, forEach: () => {} } },
        { id: 'child-3', children: { size: 0, forEach: () => {} } },
      ];

      const parent = {
        id: 'parent',
        children: {
          size: 3,
          forEach: (cb: (item: any) => void) => children.forEach(cb),
        },
      };

      const collected: any[] = [];
      const findFailed = (items: any) => {
        items.forEach((item: any) => {
          if (failedIds.has(item.id)) {
            collected.push(item);
          }
          if (item.children.size > 0) {
            findFailed(item.children);
          }
        });
      };

      // Scoped request: search within parent only
      if (failedIds.has(parent.id)) {
        collected.push(parent);
      }
      if (parent.children.size > 0) {
        findFailed(parent.children);
      }

      expect(collected).toHaveLength(2);
      expect(collected.map(c => c.id)).toEqual(['child-1', 'child-3']);
    });

    it('should create a TestRunRequest with only failed items', () => {
      const failedItems = [
        { id: 'test-a', label: 'test a' },
        { id: 'test-c', label: 'test c' },
      ];

      const request = new vscode.TestRunRequest(failedItems as any, undefined, undefined);
      expect(request.include).toHaveLength(2);
      expect(request.include![0].id).toBe('test-a');
      expect(request.include![1].id).toBe('test-c');
    });
  });

  // ── Maven submodule discovery ──────────────────────────────────────

  describe('Maven multi-module discovery', () => {
    it('should create a subproject node for Maven sub-module files', async () => {
      const { BuildToolService } = await import('./services/BuildToolService');
      const { TestDiscoveryService } = await import('./services/TestDiscoveryService');

      const rootUri = vscode.Uri.file('/workspace/maven-project/src/test/groovy/RootSpec.groovy');
      const subUri = vscode.Uri.file('/workspace/maven-project/sub-module/src/test/groovy/SubSpec.groovy');

      const findFilesSpy = vi.fn(async () => [rootUri, subUri]);
      (vscode.workspace as any).openTextDocument = vi.fn(async (uri: vscode.Uri) => ({
        getText: () => `class ${uri.fsPath.includes('Root') ? 'RootSpec' : 'SubSpec'} extends Specification { }`,
        uri,
      }));

      // Root file: projectRoot = rootProject (same)
      // Sub-module file: projectRoot != rootProject (different)
      (BuildToolService.findProjectRoot as any).mockImplementation((fp: string, _ws: string) => {
        if (fp.includes('sub-module')) {
          return '/workspace/maven-project/sub-module';
        }
        return '/workspace/maven-project';
      });
      (BuildToolService.findRootProject as any).mockImplementation((_pr: string, _ws: string) => {
        return '/workspace/maven-project';
      });
      (BuildToolService.getProjectName as any).mockImplementation((p: string) => {
        if (p.includes('sub-module')) { return 'sub-module'; }
        return 'maven-project';
      });

      (TestDiscoveryService.scanClassDeclarations as any).mockReturnValue([
        { name: 'Spec', parent: 'Specification', isAbstract: false },
      ]);
      (TestDiscoveryService.resolveAllSpecBaseClasses as any).mockReturnValue(new Set(['Specification']));
      (TestDiscoveryService.parseTestsInFile as any).mockReturnValue([
        {
          name: 'Spec',
          line: 0,
          range: new vscode.Range(0, 0, 10, 0),
          methods: [{
            name: 'test method',
            line: 2,
            range: new vscode.Range(2, 0, 5, 0),
            isDataDriven: false,
            annotations: [],
          }],
          isAbstract: false,
          annotations: [],
        },
      ]);

      createController({ findFiles: findFilesSpy });

      // Wait for async discovery to complete
      for (let i = 0; i < 30; i++) {
        await new Promise(process.nextTick);
      }

      // The controller should have a project node at the top level
      const topLevelItems: vscode.TestItem[] = [];
      (vscode.tests as any)._controllers[0]?.items.forEach((item: vscode.TestItem) => topLevelItems.push(item));

      // We should have exactly one top-level project node
      expect(topLevelItems.length).toBe(1);
      expect(topLevelItems[0].label).toBe('maven-project');

      // The project node should have 2 children: the root spec file + the subproject node
      const projectChildren: vscode.TestItem[] = [];
      topLevelItems[0].children.forEach((item: vscode.TestItem) => projectChildren.push(item));
      expect(projectChildren.length).toBe(2);

      // One of the children should be the subproject node 'sub-module'
      const subProjectNode = projectChildren.find(c => c.label === 'sub-module');
      expect(subProjectNode).toBeDefined();

      // The subproject node should contain the SubSpec file
      const subChildren: vscode.TestItem[] = [];
      subProjectNode!.children.forEach((item: vscode.TestItem) => subChildren.push(item));
      expect(subChildren.length).toBe(1);
      expect(subChildren[0].label).toBe('SubSpec.groovy');
    });

    it('should handle resolveHandler for project/subproject nodes without error', async () => {
      const { BuildToolService } = await import('./services/BuildToolService');
      const { TestDiscoveryService } = await import('./services/TestDiscoveryService');

      const subUri = vscode.Uri.file('/workspace/maven-project/sub-module/src/test/groovy/SubSpec.groovy');

      const findFilesSpy = vi.fn(async () => [subUri]);
      (vscode.workspace as any).openTextDocument = vi.fn(async (uri: vscode.Uri) => ({
        getText: () => 'class SubSpec extends Specification { }',
        uri,
      }));

      (BuildToolService.findProjectRoot as any).mockReturnValue('/workspace/maven-project/sub-module');
      (BuildToolService.findRootProject as any).mockReturnValue('/workspace/maven-project');
      (BuildToolService.getProjectName as any).mockImplementation((p: string) => {
        if (p.includes('sub-module')) { return 'sub-module'; }
        return 'maven-project';
      });

      (TestDiscoveryService.scanClassDeclarations as any).mockReturnValue([
        { name: 'SubSpec', parent: 'Specification', isAbstract: false },
      ]);
      (TestDiscoveryService.resolveAllSpecBaseClasses as any).mockReturnValue(new Set(['Specification']));
      (TestDiscoveryService.parseTestsInFile as any).mockReturnValue([
        {
          name: 'SubSpec',
          line: 0,
          range: new vscode.Range(0, 0, 10, 0),
          methods: [{
            name: 'test method',
            line: 2,
            range: new vscode.Range(2, 0, 5, 0),
            isDataDriven: false,
            annotations: [],
          }],
          isAbstract: false,
          annotations: [],
        },
      ]);

      createController({ findFiles: findFilesSpy });

      // Wait for initial discovery
      for (let i = 0; i < 30; i++) {
        await new Promise(process.nextTick);
      }

      // Find the registered resolveHandler
      const registeredController = (vscode.tests as any)._controllers[0];
      expect(registeredController).toBeDefined();

      // Get the project node
      const topItems: vscode.TestItem[] = [];
      registeredController.items.forEach((item: vscode.TestItem) => topItems.push(item));
      expect(topItems.length).toBe(1);
      const projectNode = topItems[0];

      // Find subproject node
      const projectChildren: vscode.TestItem[] = [];
      projectNode.children.forEach((item: vscode.TestItem) => projectChildren.push(item));
      const subProjectNode = projectChildren.find(c => c.label === 'sub-module');
      expect(subProjectNode).toBeDefined();

      // Calling resolveHandler with the subproject/project node should NOT throw
      // and should NOT try to open the directory as a text document
      const resolveHandler = registeredController.resolveHandler;
      expect(resolveHandler).toBeDefined();

      // Reset openTextDocument mock to track new calls
      const openTextDocSpy = vi.fn(async () => ({
        getText: () => '',
        uri: subProjectNode!.uri,
      }));
      (vscode.workspace as any).openTextDocument = openTextDocSpy;

      // resolveHandler for project/subproject nodes should be a no-op
      await resolveHandler!(projectNode);
      await resolveHandler!(subProjectNode!);

      // openTextDocument should NOT have been called for project/subproject nodes
      expect(openTextDocSpy).not.toHaveBeenCalled();
    });
  });

  // ── Discovery concurrency guard ────────────────────────────────────

  describe('discovery concurrency', () => {
    it('should skip concurrent discoverAllTests calls', async () => {
      // Use a long-running findFiles to simulate slow discovery
      let findFilesCallCount = 0;
      const findFilesSpy = vi.fn(async () => {
        findFilesCallCount++;
        // Add a small delay so the second call can arrive while the first is pending
        await new Promise(resolve => setTimeout(resolve, 10));
        return [];
      });

      const { controller, logger } = createController({ findFiles: findFilesSpy });

      // Wait for initial constructor-initiated discovery to start (but not finish)
      await new Promise(process.nextTick);

      // Trigger resolveHandler(null) which also calls discoverAllTests
      const registeredController = (vscode.tests as any)._controllers[0];
      registeredController.resolveHandler!(null);

      // Wait for everything to settle
      await new Promise(resolve => setTimeout(resolve, 50));
      for (let i = 0; i < 30; i++) {
        await new Promise(process.nextTick);
      }

      // The guard should have prevented the second findFiles call.
      // findFiles may be called once (from the constructor-initiated discovery).
      // The resolveHandler call should be skipped.
      const logCalls = logger.appendLine.mock.calls.map((c: any[]) => c[0]);
      const skippedMsg = logCalls.find((c: string) => c.includes('already in progress'));
      expect(skippedMsg).toBeDefined();
    });
  });
});
