import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestResultParser } from '../services/TestResultParser';

// Create a mock logger
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

describe('TestResultParser', () => {
  let parser: TestResultParser;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = createMockLogger();
    parser = new TestResultParser(mockLogger);
  });

  // ── parseConsoleOutput ─────────────────────────────────────────────

  describe('parseConsoleOutput', () => {
    it('should parse data-driven test iteration results from console output', () => {
      const output = `
> Task :test
DataDrivenSpec > maximum of two numbers > maximum of two numbers [a: 1, b: 3, c: 3, #0] PASSED
DataDrivenSpec > maximum of two numbers > maximum of two numbers [a: 7, b: 4, c: 7, #1] PASSED
DataDrivenSpec > maximum of two numbers > maximum of two numbers [a: 0, b: 0, c: 0, #2] FAILED
`;
      const results = parser.parseConsoleOutput(output, 'maximum of two numbers');
      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[0].index).toBe(0);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(false);
    });

    it('should handle empty console output', () => {
      const results = parser.parseConsoleOutput('', 'some test');
      expect(results).toHaveLength(0);
    });

    it('should handle console output with no matching test', () => {
      const output = `
> Task :test
SomeOtherSpec > other test > other test [param: 1, #0] PASSED
`;
      const results = parser.parseConsoleOutput(output, 'non-existent test');
      expect(results).toHaveLength(0);
    });

    it('should parse placeholder tests (with # in name)', () => {
      const output = `
DataDrivenSpec > maximum of #a and #b is #c > maximum of 1 and 3 is 3 PASSED
DataDrivenSpec > maximum of #a and #b is #c > maximum of 7 and 4 is 7 PASSED
`;
      const results = parser.parseConsoleOutput(output, 'maximum of #a and #b is #c');
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('should parse SKIPPED iterations', () => {
      const output = `
TestSpec > some test > some test [x: 1, #0] SKIPPED
`;
      const results = parser.parseConsoleOutput(output, 'some test');
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
    });
  });

  // ── parseExpectedActual ────────────────────────────────────────────

  describe('parseExpectedActual', () => {
    it('should parse "Expected :/Actual :" pattern', () => {
      const error = `Expected :7\nActual   :6`;
      const result = parser.parseExpectedActual(error);
      expect(result).toBeDefined();
      expect(result!.expected).toBe('7');
      expect(result!.actual).toBe('6');
    });

    it('should parse JUnit angle-bracket pattern', () => {
      const error = `expected: <7> but was: <6>`;
      const result = parser.parseExpectedActual(error);
      expect(result).toBeDefined();
      expect(result!.expected).toBe('7');
      expect(result!.actual).toBe('6');
    });

    it('should parse JUnit plain text pattern', () => {
      const error = `expected: 7 but was: 6`;
      const result = parser.parseExpectedActual(error);
      expect(result).toBeDefined();
      expect(result!.expected).toBe('7');
      expect(result!.actual).toBe('6');
    });

    it('should parse Spock power assertion block', () => {
      const error = `Condition not satisfied:

result == expected
|      |  |
6      |  7
       false
`;
      const result = parser.parseExpectedActual(error);
      expect(result).toBeDefined();
      expect(result!.expected).toBe('7');
      expect(result!.actual).toBe('6');
    });

    it('should return undefined for empty string', () => {
      expect(parser.parseExpectedActual('')).toBeUndefined();
    });

    it('should return undefined when no pattern matches', () => {
      expect(parser.parseExpectedActual('Some random error message')).toBeUndefined();
    });
  });

  // ── extractIterationInfo ──────────────────────────────────────────

  describe('extractIterationInfo', () => {
    it('should extract iteration info from standard bracket pattern', () => {
      const result = parser.extractIterationInfo('test name [a: 1, b: 2, #0]');
      expect(result).toBeDefined();
      expect(result!.index).toBe(0);
      expect(result!.parameters).toEqual({ a: 1, b: 2 });
    });

    it('should extract iteration info with nested brackets', () => {
      const result = parser.extractIterationInfo('test [data: [x:1, y:2], #3]');
      expect(result).toBeDefined();
      expect(result!.index).toBe(3);
    });

    it('should return null when no iteration info present', () => {
      const result = parser.extractIterationInfo('simple test name');
      expect(result).toBeNull();
    });

    it('should handle higher iteration indices', () => {
      const result = parser.extractIterationInfo('test [a: 10, #42]');
      expect(result).toBeDefined();
      expect(result!.index).toBe(42);
    });
  });

  // ── parseXmlReport (with mocked fs) ───────────────────────────────

  describe('parseXmlReport', () => {
    it('should return empty array when test-results dir does not exist', async () => {
      // fs.existsSync returns false by default since we don't mock it for this test
      const results = await parser.parseXmlReport('/nonexistent', 'SomeSpec');
      expect(results).toEqual([]);
    });
  });

  // ── parseClassTestResults ─────────────────────────────────────────

  describe('parseClassTestResults', () => {
    it('should return empty map when test-results dir does not exist', async () => {
      const results = await parser.parseClassTestResults('/nonexistent', 'SomeSpec');
      expect(results.size).toBe(0);
    });
  });

  // ── parseParameters (via extractIterationInfo) ─────────────────────

  describe('parameter parsing (via extractIterationInfo)', () => {
    it('should parse numeric values', () => {
      const result = parser.extractIterationInfo('test [a: 42, b: 3.14, #0]');
      expect(result).toBeDefined();
      expect(result!.parameters.a).toBe(42);
    });

    it('should parse boolean values', () => {
      const result = parser.extractIterationInfo('test [flag: true, other: false, #0]');
      expect(result).toBeDefined();
      expect(result!.parameters.flag).toBe(true);
      expect(result!.parameters.other).toBe(false);
    });

    it('should parse string values', () => {
      const result = parser.extractIterationInfo('test [name: "Alice", #0]');
      expect(result).toBeDefined();
      expect(result!.parameters.name).toBe('Alice');
    });
  });
});
