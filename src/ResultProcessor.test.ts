import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { ResultProcessor } from './ResultProcessor';
import { createMockLogger, createMockConfigurationService } from './__test_helpers__';

// --- Mocks ---------------------------------------------------------------

vi.mock('./services/SpockErrorParser', () => ({
  extractErrorForTest: vi.fn((_output: string, _className: string, _testName: string) => 'Test failed'),
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
      return {
        id, label, uri,
        children: {
          add: (item: any) => { item.parent = { id, label }; children.set(item.id, item); },
          get: (cid: string) => children.get(cid),
          delete: (cid: string) => children.delete(cid),
          replace: (arr: any[]) => { children.clear(); arr.forEach(i => children.set(i.id, i)); },
          forEach: (cb: any) => children.forEach(cb),
          get size() { return children.size; },
        },
        tags: [],
        range: undefined as any,
        canResolveChildren: false,
        parent: undefined as any,
        description: undefined as any,
      };
    },
    createTestRun: vi.fn(),
  } as any;
}

// createMockLogger imported from __test_helpers__

function createMockTestResultParser() {
  return {
    parseTestResults: vi.fn().mockResolvedValue([]),
    parseClassTestResults: vi.fn().mockResolvedValue(new Map()),
    parseExpectedActual: vi.fn(() => null),
  } as any;
}

// createMockConfigurationService imported from __test_helpers__

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

// --- Tests ---------------------------------------------------------------

describe('ResultProcessor', () => {
  let controller: ReturnType<typeof createMockController>;
  let logger: ReturnType<typeof createMockLogger>;
  let parser: ReturnType<typeof createMockTestResultParser>;
  let configService: ReturnType<typeof createMockConfigurationService>;
  let testData: WeakMap<vscode.TestItem, any>;
  let iterationItems: Map<string, vscode.TestItem[]>;
  let processor: ResultProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = createMockController();
    logger = createMockLogger();
    parser = createMockTestResultParser();
    configService = createMockConfigurationService();
    testData = new WeakMap();
    iterationItems = new Map();
    processor = new ResultProcessor(controller, logger, parser, configService, testData, iterationItems);
  });

  // ── formatParameters ─────────────────────────────────────────────

  describe('formatParameters', () => {
    it('should format key-value pairs', () => {
      expect(processor.formatParameters({ a: 1, b: 'hello' })).toBe('a: 1, b: hello');
    });

    it('should return empty string for empty parameters', () => {
      expect(processor.formatParameters({})).toBe('');
    });

    it('should handle single parameter', () => {
      expect(processor.formatParameters({ x: 42 })).toBe('x: 42');
    });
  });

  // ── createTestMessage ────────────────────────────────────────────

  describe('createTestMessage', () => {
    it('should create a plain text message when showDiffView is false', () => {
      const msg = processor.createTestMessage('some error');
      expect(msg.message).toBe('some error');
      expect(msg.expectedOutput).toBeUndefined();
    });

    it('should use diff() when showDiffView is true and diff info is provided', () => {
      configService.getConfig.mockReturnValue({ showDiffView: true });
      const diff = { expected: 'foo', actual: 'bar' };
      const msg = processor.createTestMessage('mismatch', diff);
      expect(msg.expectedOutput).toBe('foo');
      expect(msg.actualOutput).toBe('bar');
    });

    it('should fallback to parser-based diff when showDiffView is true but no diff provided', () => {
      configService.getConfig.mockReturnValue({ showDiffView: true });
      parser.parseExpectedActual.mockReturnValue({ expected: 'a', actual: 'b' });
      const msg = processor.createTestMessage('error text');
      expect(msg.expectedOutput).toBe('a');
      expect(msg.actualOutput).toBe('b');
    });

    it('should create plain message when showDiffView is true but parser returns null', () => {
      configService.getConfig.mockReturnValue({ showDiffView: true });
      parser.parseExpectedActual.mockReturnValue(null);
      const msg = processor.createTestMessage('error text');
      expect(msg.message).toBe('error text');
      expect(msg.expectedOutput).toBeUndefined();
    });
  });

  // ── handleDataDrivenTestResults ──────────────────────────────────

  describe('handleDataDrivenTestResults', () => {
    it('should pass test when no iterations found and result is success', async () => {
      const run = createMockRun();
      const test = controller.createTestItem('t1', 'test one', vscode.Uri.file('/test.groovy'));
      const data = { type: 'test' as const, className: 'MySpec', testName: 'test one', isDataDriven: true };

      parser.parseTestResults.mockResolvedValue([]);

      await processor.handleDataDrivenTestResults(test, data, { success: true, output: '' }, run as any, '/ws');
      expect(run.passed).toHaveBeenCalledWith(test, undefined);
    });

    it('should fail test when no iterations found and result is failure', async () => {
      const run = createMockRun();
      const test = controller.createTestItem('t1', 'test one', vscode.Uri.file('/test.groovy'));
      const data = { type: 'test' as const, className: 'MySpec', testName: 'test one', isDataDriven: true };

      parser.parseTestResults.mockResolvedValue([]);

      await processor.handleDataDrivenTestResults(test, data, { success: false, output: 'error' }, run as any, '/ws');
      expect(run.failed).toHaveBeenCalledWith(test, expect.anything(), undefined);
    });

    it('should create iteration items when iterations are found', async () => {
      const run = createMockRun();
      const testUri = vscode.Uri.file('/test.groovy');
      const test = controller.createTestItem('t1', 'test one', testUri);
      const data = { type: 'test' as const, className: 'MySpec', testName: 'test one', isDataDriven: true };
      testData.set(test as any, data);

      parser.parseTestResults.mockResolvedValue([
        { index: 0, displayName: '#0', parameters: { x: 1 }, success: true, duration: 0.1 },
        { index: 1, displayName: '#1', parameters: { x: 2 }, success: false, duration: 0.2, errorInfo: { error: 'oops' } },
      ]);

      // Mock openTextDocument for iteration range calculation
      (vscode.workspace as any).openTextDocument = vi.fn(async () => ({
        getText: () => 'class MySpec {\n  def "test one"() {\n    where:\n    x | y\n    1 | 2\n    3 | 4\n  }\n}',
        uri: testUri,
      }));

      await processor.handleDataDrivenTestResults(test, data, { success: true, output: '' }, run as any, '/ws');

      // createFlatIterationItems is fire-and-forget (not awaited internally),
      // so flush the microtask queue to let the async work complete.
      await new Promise(resolve => setTimeout(resolve, 20));

      // Iteration items should have been created — verify via run calls
      expect(run.passed).toHaveBeenCalled();
      expect(run.failed).toHaveBeenCalled();
    });

    it('should handle errors gracefully during iteration parsing', async () => {
      const run = createMockRun();
      const test = controller.createTestItem('t1', 'test one', vscode.Uri.file('/test.groovy'));
      const data = { type: 'test' as const, className: 'MySpec', testName: 'test one', isDataDriven: true };

      parser.parseTestResults.mockRejectedValue(new Error('parse error'));

      await processor.handleDataDrivenTestResults(test, data, { success: true, output: '' }, run as any, '/ws');
      // Should fall back to passing the test
      expect(run.passed).toHaveBeenCalledWith(test, undefined);
    });
  });

  // ── calculateIterationRange ──────────────────────────────────────

  describe('calculateIterationRange', () => {
    it('should return parent range when test has no URI', async () => {
      const test = controller.createTestItem('t1', 'test');
      test.range = new vscode.Range(5, 0, 5, 10);
      const range = await processor.calculateIterationRange(test, { index: 0, displayName: '#0', parameters: {}, success: true, duration: 0 });
      expect(range.start.line).toBe(5);
    });

    it('should locate the correct data row for a where-block iteration', async () => {
      const testUri = vscode.Uri.file('/spec.groovy');
      const test = controller.createTestItem('t1', 'adds numbers', testUri);

      (vscode.workspace as any).openTextDocument = vi.fn(async () => ({
        getText: () => [
          'class Spec extends Specification {',
          '  def "adds numbers"() {',
          '    expect:',
          '    a + b == c',
          '    where:',
          '    a | b | c',   // header
          '    1 | 2 | 3',   // row 0 -> line 6
          '    4 | 5 | 9',   // row 1 -> line 7
          '  }',
          '}',
        ].join('\n'),
        uri: testUri,
      }));

      const range = await processor.calculateIterationRange(
        test, { index: 1, displayName: '#1', parameters: { a: 4 }, success: true, duration: 0 },
      );
      expect(range.start.line).toBe(7);
    });

    it('should handle data-pipe syntax', async () => {
      const testUri = vscode.Uri.file('/spec.groovy');
      const test = controller.createTestItem('t1', 'pipe test', testUri);

      (vscode.workspace as any).openTextDocument = vi.fn(async () => ({
        getText: () => [
          'class Spec extends Specification {',
          '  def "pipe test"() {',
          '    expect:',
          '    true',
          '    where:',
          '    x << [1, 2, 3]',  // row 0 -> line 5
          '    y << [4, 5, 6]',  // row 1 -> line 6
          '  }',
          '}',
        ].join('\n'),
        uri: testUri,
      }));

      const range = await processor.calculateIterationRange(
        test, { index: 0, displayName: '#0', parameters: {}, success: true, duration: 0 },
      );
      // data-pipe syntax: no header to skip, so row 0 is the first data line
      expect(range.start.line).toBe(5);
    });
  });

  // ── createFlatIterationItems ─────────────────────────────────────

  describe('createFlatIterationItems', () => {
    it('should create iteration children and report results', async () => {
      const run = createMockRun();
      const testUri = vscode.Uri.file('/test.groovy');
      const parent = controller.createTestItem('p1', 'data test', testUri);
      testData.set(parent as any, { type: 'test', className: 'MySpec', testName: 'data test' });

      (vscode.workspace as any).openTextDocument = vi.fn(async () => ({
        getText: () => 'class MySpec {\n  def "data test"() {\n    where:\n    x\n    1\n    2\n  }\n}',
        uri: testUri,
      }));

      const iterations = [
        { index: 0, displayName: '#0', parameters: { x: 1 }, success: true, duration: 0.05 },
        { index: 1, displayName: '#1', parameters: { x: 2 }, success: false, duration: 0.1, errorInfo: { error: 'fail' } },
      ];

      await processor.createFlatIterationItems(parent, iterations, run as any);

      expect(parent.children.size).toBe(2);
      expect(run.passed).toHaveBeenCalledTimes(1);  // 1 passing iteration
      expect(run.failed).toHaveBeenCalledTimes(2);  // 1 failing iteration + parent (aggregated)
    });

    it('should store created iteration items in the map', async () => {
      const run = createMockRun();
      const testUri = vscode.Uri.file('/test.groovy');
      const parent = controller.createTestItem('p1', 'data test', testUri);
      testData.set(parent as any, { type: 'test', className: 'Spec', testName: 'data test' });

      (vscode.workspace as any).openTextDocument = vi.fn(async () => ({
        getText: () => 'class Spec {\n  def "data test"() {\n    where:\n    x\n    1\n  }\n}',
        uri: testUri,
      }));

      await processor.createFlatIterationItems(parent, [
        { index: 0, displayName: '#0', parameters: { x: 1 }, success: true, duration: 0 },
      ], run as any);

      expect(iterationItems.has(testUri.toString())).toBe(true);
      expect(iterationItems.get(testUri.toString())!.length).toBe(1);
    });

    it('should sort iteration results by index', async () => {
      const run = createMockRun();
      const testUri = vscode.Uri.file('/test.groovy');
      const parent = controller.createTestItem('p1', 'sorted test', testUri);
      testData.set(parent as any, { type: 'test', className: 'Spec', testName: 'sorted test' });

      (vscode.workspace as any).openTextDocument = vi.fn(async () => ({
        getText: () => 'class Spec {\n  def "sorted test"() {\n    where:\n    x\n    1\n    2\n    3\n  }\n}',
        uri: testUri,
      }));

      // Provide out-of-order iterations
      await processor.createFlatIterationItems(parent, [
        { index: 2, displayName: '#2', parameters: { x: 3 }, success: true, duration: 0 },
        { index: 0, displayName: '#0', parameters: { x: 1 }, success: true, duration: 0 },
        { index: 1, displayName: '#1', parameters: { x: 2 }, success: true, duration: 0 },
      ], run as any);

      expect(parent.children.size).toBe(3);
      expect(run.passed).toHaveBeenCalledTimes(4);  // 3 iterations + parent (all passed)
    });
  });
});
