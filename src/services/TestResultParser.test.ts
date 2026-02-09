import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestResultParser } from '../services/TestResultParser';
import { createMockLogger } from '../__test_helpers__';

// createMockLogger imported from __test_helpers__

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

    it('should correctly parse boolean RHS value near == operator', () => {
      // Bug fix: "true" at col 21 was incorrectly filtered as comparison result
      // because tolerance was too wide (<=3). The == is at col 18 and "true" at 21.
      const error = `Condition not satisfied:

game.isGameOver() == gameOver
|    |            |  |
|    false        |  true
|                 false
`;
      const result = parser.parseExpectedActual(error);
      expect(result).toBeDefined();
      expect(result!.expected).toBe('true');
      expect(result!.actual).toBe('false');
    });

    it('should ignore Spock similarity analysis lines in power assertion', () => {
      // Bug fix: similarity analysis tokens like "difference" were picked as RHS value
      const error = `Condition not satisfied:

frame.toString() == expectedDisplay
|     |          |  |
|     [0, X]     |  [0, /]
[0, X]           false
                 1 difference (83% similarity)
                 [0, (X)]
                 [0, (/)]
`;
      const result = parser.parseExpectedActual(error);
      expect(result).toBeDefined();
      expect(result!.expected).toBe('[0, /]');
      expect(result!.actual).toBe('[0, X]');
    });

    it('should prefer simple value over map representation on RHS', () => {
      // Bug fix: intermediate map value "[rolls:...]" was picked over leaf value "2"
      const error = `Condition not satisfied:

game.getCurrentRoll() == gameState.expectedRoll
|    |                |  |         |
|    3                |  |         2
|                     |  [rolls:[3, 4, 3, 4, 3, 4, 3, 4, 3, 4, 3, 4, 3, 4, 3, 4, 3, 4, 3, 4], expectedFrame:10, expectedRoll:2, expectedGameOver:true]
|                     false
`;
      const result = parser.parseExpectedActual(error);
      expect(result).toBeDefined();
      expect(result!.expected).toBe('2');
      expect(result!.actual).toBe('3');
    });

    it('should handle arithmetic RHS expression in power assertion', () => {
      // When RHS is "10 + expectedBonus", the result (17) is under the + operator
      const error = `Condition not satisfied:

game.score() == 10 + expectedBonus
|    |       |     | |
|    24      false | 7
|                  17
`;
      const result = parser.parseExpectedActual(error);
      expect(result).toBeDefined();
      expect(result!.expected).toBe('17');
      expect(result!.actual).toBe('24');
    });

    it('should skip object representation lines in power assertion', () => {
      // Bug fix: Groovy toString() dump line contains tokens like "frames=[[3,"
      // that pollute value extraction when not filtered out.
      const error = `Condition not satisfied:

game.score() == expectedScore
|    |       |  |
|    16      |  18
|            false
<com.example.BowlingGame@4bff2185 frames=[[5, /], [3], [], [], [], [], [], [], [], []] currentFrame=1 currentRoll=1>
`;
      const result = parser.parseExpectedActual(error);
      expect(result).toBeDefined();
      expect(result!.expected).toBe('18');
      expect(result!.actual).toBe('16');
    });

    it('should skip object representation lines without angle brackets', () => {
      const error = `Condition not satisfied:

game.score() == expectedScore
|    |       |  |
|    85      |  150
|            false
BowlingGame@6075b2d3 frames=[[5, /], [5, /], [5, /], [5, /], [5, /], [5, /]]
`;
      const result = parser.parseExpectedActual(error);
      expect(result).toBeDefined();
      expect(result!.expected).toBe('150');
      expect(result!.actual).toBe('85');
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

  // ── buildPlaceholderRegex ─────────────────────────────────────────

  describe('buildPlaceholderRegex', () => {
    it('should convert placeholder test name to regex', () => {
      const regex = parser.buildPlaceholderRegex('maximum of #a and #b is #c');
      expect(regex).toBeDefined();
      expect(regex!.test('maximum of 1 and 3 is 3')).toBe(true);
      expect(regex!.test('maximum of 7 and 4 is 7')).toBe(true);
      expect(regex!.test('maximum of 0 and 0 is 0')).toBe(true);
      expect(regex!.test('something else')).toBe(false);
    });

    it('should handle placeholders at start and end of name', () => {
      const regex = parser.buildPlaceholderRegex('#gameState should have score #expectedScore');
      expect(regex).toBeDefined();
      expect(regex!.test('perfect game should have score 300')).toBe(true);
      expect(regex!.test('gutter game should have score 0')).toBe(true);
    });

    it('should handle single placeholder', () => {
      const regex = parser.buildPlaceholderRegex('strike in frame #frame should give bonus points');
      expect(regex).toBeDefined();
      expect(regex!.test('strike in frame 1 should give bonus points')).toBe(true);
      expect(regex!.test('strike in frame 10 should give bonus points')).toBe(true);
    });

    it('should return null for names without placeholders', () => {
      expect(parser.buildPlaceholderRegex('simple test name')).toBeNull();
    });

    it('should escape regex special chars in the test name', () => {
      const regex = parser.buildPlaceholderRegex('#a + #b = #c');
      expect(regex).toBeDefined();
      expect(regex!.test('1 + 2 = 3')).toBe(true);
      expect(regex!.test('1 x 2 = 3')).toBe(false);
    });
  });
});
