import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import { BuildTool, DiffInfo, TestIterationResult } from '../types';
import { BuildToolService } from './BuildToolService';

export class TestResultParser {
  private logger: vscode.LogOutputChannel;
  private xmlParser: XMLParser;

  constructor(logger: vscode.LogOutputChannel) {
    this.logger = logger;
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      cdataPropName: '#cdata',
      allowBooleanAttributes: true,
      parseTagValue: false,
      trimValues: false,
    });
  }

  /**
   * Parse console output to extract individual iteration results
   */
  parseConsoleOutput(output: string, testName: string): TestIterationResult[] {
    const results: TestIterationResult[] = [];
    const lines = output.split('\n');

    this.logger.appendLine(`TestResultParser: Parsing console output for test: ${testName}`);

    // Check if this is a placeholder test (contains #)
    if (testName.includes('#')) {
      // For placeholder tests, look for the pattern:
      // "DataDrivenSpec > maximum of #a and #b is #c > maximum of 1 and 3 is 3 PASSED"
      const placeholderPattern = /^.*>\s*([^>]+?)\s*>\s*([^>]+?)\s*(PASSED|FAILED|SKIPPED)$/;
      
      for (const line of lines) {
        const match = line.match(placeholderPattern);
        if (match) {
          const originalTestName = match[1].trim();
          const unrolledName = match[2].trim();
          const status = match[3];
          
          // Check if this matches our target test (the original placeholder name)
          if (originalTestName === testName) {
            const success = status === 'PASSED';
            
            // Extract parameters from the unrolled name if possible
            const parameters = this.extractParametersFromUnrolledName(unrolledName);
            
            const result: TestIterationResult = {
              index: results.length, // Use sequential index since we don't have iteration numbers
              displayName: `${testName} > ${unrolledName}`,
              parameters,
              success,
              duration: 0,
              output: line.trim(),
              errorInfo: success ? undefined : { error: `Test failed: ${unrolledName}` }
            };

            results.push(result);
            this.logger.appendLine(`TestResultParser: Found unrolled test: ${unrolledName} - ${success ? 'PASSED' : 'FAILED'}`);
          }
        }
      }
    } else {
      // For regular tests, use the existing logic
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Look for Gradle test iteration patterns like:
        // "DataDrivenSpec > maximum of two numbers > maximum of two numbers [a: 1, b: 3, c: 3, #0] PASSED"
        // Also handles nested brackets: "ComplexDataSpec > test > test [gameState: [rolls:[3, 4], ...], #0] PASSED"
        const statusMatch = line.match(/\s*(PASSED|FAILED|SKIPPED)\s*$/);
        if (!statusMatch) { continue; }
        const status = statusMatch[1];

        // Check if line contains our test name followed by iteration params
        const escapedTestName = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const testNameMatch = line.match(new RegExp(`>\\s*${escapedTestName}\\s*\\[`));
        if (!testNameMatch) { continue; }

        // Extract the part between test name and status, then parse iteration info
        const afterTestName = line.substring(line.indexOf(testNameMatch[0]) + testNameMatch[0].length - 1);
        const beforeStatus = afterTestName.substring(0, afterTestName.lastIndexOf(status)).trim();
        const iterationInfo = this.extractIterationFromName(testName + ' ' + beforeStatus);
        
        if (iterationInfo) {
          const parameters = this.parseParameters(iterationInfo.parametersString);
          const success = status === 'PASSED';
          const duration = 0;

          // For failed iterations, capture the failure details from the lines following the FAILED line
          let errorDetail: string | undefined;
          if (!success) {
            errorDetail = this.captureFailureBlock(lines, i + 1);
          }

          const result: TestIterationResult = {
            index: iterationInfo.index,
            displayName: `${testName} [${iterationInfo.parametersString}, #${iterationInfo.index}]`,
            parameters,
            success,
            duration,
            output: line.trim(),
            errorInfo: success ? undefined : { error: errorDetail || `Iteration ${iterationInfo.index} ${status}` }
          };

          results.push(result);
          this.logger.appendLine(`TestResultParser: Found iteration #${iterationInfo.index}: ${success ? 'PASSED' : 'FAILED'}`);
        }
      }
    }

    this.logger.appendLine(`TestResultParser: Parsed ${results.length} iterations from console output`);
    return results;
  }

  /**
   * Parse XML test report to extract iteration results
   */
  async parseXmlReport(workspacePath: string, className: string, buildTool: BuildTool = 'gradle'): Promise<TestIterationResult[]> {
    const results: TestIterationResult[] = [];
    const testResultsDir = BuildToolService.getTestResultsDir(workspacePath, buildTool);

    try {
      try {
        await fsp.access(testResultsDir);
      } catch {
        this.logger.appendLine(`TestResultParser: XML report directory not found: ${testResultsDir}`);
        return results;
      }

      // Find the XML file for this class (could be FQN like TEST-com.example.ClassName.xml)
      const files = await fsp.readdir(testResultsDir);
      const matchingFile = files.find(f => f.endsWith(`${className}.xml`));
      if (!matchingFile) {
        this.logger.appendLine(`TestResultParser: No XML report found for class ${className}`);
        return results;
      }

      const xmlPath = path.join(testResultsDir, matchingFile);
      const xmlContent = await fsp.readFile(xmlPath, 'utf8');
      this.logger.appendLine(`TestResultParser: Parsing XML report: ${xmlPath}`);

      const parsed = this.xmlParser.parse(xmlContent);
      const testcases = this.extractTestCases(parsed);

      for (const tc of testcases) {
        const fullName = tc['@_name'] || '';
        const time = parseFloat(tc['@_time'] || '0');

        // Check if this is an iteration (contains parameter values and index)
        const iterationInfo = this.extractIterationFromName(fullName);
        
        if (iterationInfo) {
          const parameters = this.parseParameters(iterationInfo.parametersString);
          
          const { hasFailed, hasError, success } = this.getTestCaseStatus(tc);

          let errorInfo: { error: string; diff?: DiffInfo } | undefined;
          if (hasFailed) {
            const errorText = this.extractErrorFromTestCase(tc, 'failure');
            const diff = this.parseExpectedActual(errorText);
            errorInfo = { error: errorText, diff };
          } else if (hasError) {
            const errorText = this.extractErrorFromTestCase(tc, 'error');
            const diff = this.parseExpectedActual(errorText);
            errorInfo = { error: errorText, diff };
          }

          const result: TestIterationResult = {
            index: iterationInfo.index,
            displayName: fullName,
            parameters,
            success,
            duration: time,
            errorInfo,
            output: fullName
          };

          results.push(result);
          this.logger.appendLine(`TestResultParser: Found XML iteration #${iterationInfo.index}: ${success ? 'PASSED' : 'FAILED'}`);
        }
      }

      this.logger.appendLine(`TestResultParser: Parsed ${results.length} iterations from XML report`);
    } catch (error) {
      this.logger.appendLine(`TestResultParser: Error parsing XML report: ${error}`);
    }

    return results;
  }

  /**
   * Parse parameter string like "roll1: 3, roll2: 4, expectedScore: 7" into object
   */
  private parseParameters(parametersString: string): Record<string, any> {
    const parameters: Record<string, any> = {};
    
    // Split by comma and parse key-value pairs
    const pairs = parametersString.split(',').map(pair => pair.trim());
    
    for (const pair of pairs) {
      const colonIndex = pair.indexOf(':');
      if (colonIndex > 0) {
        const key = pair.substring(0, colonIndex).trim();
        const value = pair.substring(colonIndex + 1).trim();
        
        // Try to parse as number, boolean, or keep as string
        let parsedValue: any = value;
        if (value === 'true') {
          parsedValue = true;
        } else if (value === 'false') {
          parsedValue = false;
        } else if (!isNaN(Number(value)) && value !== '') {
          parsedValue = Number(value);
        } else if (value.startsWith('"') && value.endsWith('"')) {
          // Remove surrounding quotes from strings
          parsedValue = value.slice(1, -1);
        } else if (value.startsWith("'") && value.endsWith("'")) {
          // Remove surrounding single quotes from strings
          parsedValue = value.slice(1, -1);
        }
        
        parameters[key] = parsedValue;
      }
    }
    
    return parameters;
  }

  /**
   * Parse XML report to get pass/fail/skip results for all tests in a class.
   * Returns a map from test name to result.
   */
  async parseClassTestResults(workspacePath: string, className: string, buildTool: BuildTool = 'gradle'): Promise<Map<string, {success: boolean; skipped: boolean; duration: number; errorMessage?: string; diff?: DiffInfo}>> {
    const testResultsDir = BuildToolService.getTestResultsDir(workspacePath, buildTool);

    try {
      try {
        await fsp.access(testResultsDir);
      } catch {
        this.logger.appendLine(`TestResultParser: Test results directory not found: ${testResultsDir}`);
        return new Map();
      }

      // Find the XML file for this class (could be FQN like TEST-com.example.ClassName.xml)
      const files = await fsp.readdir(testResultsDir);
      const matchingFile = files.find(f => f.endsWith(`${className}.xml`));
      if (!matchingFile) {
        this.logger.appendLine(`TestResultParser: No XML report found for class ${className}`);
        return new Map();
      }

      return this.parseXmlFileForClassResults(path.join(testResultsDir, matchingFile));
    } catch (error) {
      this.logger.appendLine(`TestResultParser: Error parsing class test results: ${error}`);
      return new Map();
    }
  }

  private async parseXmlFileForClassResults(xmlPath: string): Promise<Map<string, {success: boolean; skipped: boolean; duration: number; errorMessage?: string; diff?: DiffInfo}>> {
    const results = new Map<string, {success: boolean; skipped: boolean; duration: number; errorMessage?: string; diff?: DiffInfo}>();
    const xmlContent = await fsp.readFile(xmlPath, 'utf8');
    this.logger.appendLine(`TestResultParser: Parsing XML for class results: ${xmlPath}`);

    const parsed = this.xmlParser.parse(xmlContent);
    const testcases = this.extractTestCases(parsed);

    for (const tc of testcases) {
      const testName = tc['@_name'] || '';
      const time = parseFloat(tc['@_time'] || '0');

      const { hasFailed, hasError, success } = this.getTestCaseStatus(tc);
      const hasSkipped = !!tc['skipped'];

      let errorMessage: string | undefined;
      let diff: DiffInfo | undefined;
      if (hasFailed) {
        errorMessage = this.extractErrorFromTestCase(tc, 'failure');
        diff = this.parseExpectedActual(errorMessage);
      } else if (hasError) {
        errorMessage = this.extractErrorFromTestCase(tc, 'error');
        diff = this.parseExpectedActual(errorMessage);
      }

      results.set(testName, { success, skipped: hasSkipped, duration: time, errorMessage, diff });
    }

    this.logger.appendLine(`TestResultParser: Found ${results.size} test results in XML`);
    return results;
  }

  // ── XML helper methods (fast-xml-parser) ───────────────────────────

  /**
   * Extract testcase elements from a parsed JUnit XML structure.
   * Handles both single testcase and arrays of testcases.
   */
  private extractTestCases(parsed: any): any[] {
    const testsuite = parsed?.testsuite;
    if (!testsuite) { return []; }
    const tc = testsuite.testcase;
    if (!tc) { return []; }
    return Array.isArray(tc) ? tc : [tc];
  }

  /**
   * Determine pass/fail/error status from a parsed testcase object.
   */
  private getTestCaseStatus(tc: any): { hasFailed: boolean; hasError: boolean; success: boolean } {
    const hasFailed = !!tc['failure'];
    const hasError = !!tc['error'];
    return { hasFailed, hasError, success: !hasFailed && !hasError };
  }

  /**
   * Extract error text from a parsed testcase's failure or error element.
   * fast-xml-parser provides the text content, CDATA, and attributes.
   */
  private extractErrorFromTestCase(tc: any, tag: 'failure' | 'error'): string {
    const element = tc[tag];
    if (!element) { return `Test ${tag}`; }

    // fast-xml-parser may return a string (text-only element) or an object
    if (typeof element === 'string') {
      return element.trim() || `Test ${tag}`;
    }

    // Try CDATA content first, then plain text body, then message attribute
    const cdata = element['#cdata'];
    if (cdata) {
      const text = typeof cdata === 'string' ? cdata : String(cdata);
      if (text.trim()) { return text.trim(); }
    }

    const textBody = element['#text'];
    if (textBody) {
      const text = typeof textBody === 'string' ? textBody : String(textBody);
      if (text.trim()) { return text.trim(); }
    }

    const message = element['@_message'];
    if (message) { return message; }

    return `Test ${tag}`;
  }

  /**
   * Parse an error message to extract expected/actual values for diff display.
   * Handles common Spock and Groovy assertion output patterns:
   *
   * 1. Spock power assertion with ==:
   *      Condition not satisfied:
   *      result == expected
   *      |      |  |
   *      6      |  7
   *             false
   *
   * 2. JUnit-style:
   *      expected: <7> but was: <6>
   *      expected: 7 but was: 6
   *
   * 3. Groovy assert:
   *      assert x == y
   *             | |  |
   *             6 |  7
   *               false
   *
   * 4. Spock comparison failure:
   *      expected: "foo" but was: "bar"
   *
   * 5. ComparisonFailure format:
   *      Expected :foo
   *      Actual   :bar
   */
  parseExpectedActual(errorMessage: string): DiffInfo | undefined {
    if (!errorMessage) {
      return undefined;
    }

    // Don't attempt diff extraction for exception-based failures.
    // These contain "thrown()" expectations, explicit throw keywords, or are
    // dominated by stack traces rather than value comparisons.
    if (this.isExceptionError(errorMessage)) {
      return undefined;
    }

    // Pattern 1: "Expected :X" / "Actual   :Y" (IntelliJ / ComparisonFailure style)
    const expectedActualBlock = errorMessage.match(/Expected\s*:\s*(.*)\nActual\s*:\s*(.*)/i);
    if (expectedActualBlock) {
      const expected = expectedActualBlock[1].trim();
      const actual = expectedActualBlock[2].trim();
      if (expected !== actual) {
        return { expected, actual };
      }
    }

    // Pattern 2: "expected: <X> but was: <Y>" (JUnit angle-bracket style)
    const junitAngle = errorMessage.match(/expected:\s*<(.+?)>\s*but was:\s*<(.+?)>/i);
    if (junitAngle) {
      if (junitAngle[1] !== junitAngle[2]) {
        return { expected: junitAngle[1], actual: junitAngle[2] };
      }
    }

    // Pattern 3: "expected: X but was: Y" (Spock / Groovy style, possibly quoted)
    const junitPlain = errorMessage.match(/expected:\s*(.+?)\s+but was:\s*(.+?)(?:\s*$|\n)/im);
    if (junitPlain) {
      const expected = junitPlain[1].trim();
      const actual = junitPlain[2].trim();
      if (expected !== actual) {
        return { expected, actual };
      }
    }

    // Pattern 4: Spock power assertion block
    // Only match when preceded by "Condition not satisfied:" — this is the reliable
    // indicator that an equality assertion failed with a power-assert display.
    // Capture the leading indent so we can align columns between expression and value lines.
    const conditionBlock = errorMessage.match(
      /Condition not satisfied:\s*\n(\s*)(.+==.+)\n((?:[ \t|]*\S.*\n?)+)/
    );
    if (conditionBlock) {
      const indent = conditionBlock[1].length;
      const result = this.parseSpockPowerAssertion(conditionBlock[2], conditionBlock[3], indent);
      if (result) {
        return result;
      }
    }

    return undefined;
  }

  /**
   * Detect whether an error message represents an exception-based failure rather
   * than a value comparison. Exception failures should not be shown as diffs.
   */
  private isExceptionError(errorMessage: string): boolean {
    // Thrown/expected exception patterns
    if (/\bthrown\(\)/.test(errorMessage)) { return true; }
    if (/\bnoExceptionThrown\(\)/.test(errorMessage)) { return true; }
    if (/Expected exception of type/.test(errorMessage)) { return true; }
    if (/Expected no exception/.test(errorMessage)) { return true; }

    // If the message is mostly stack trace lines, it's an exception
    const lines = errorMessage.split('\n');
    const stackLines = lines.filter(l => /^\s*at\s+/.test(l));
    if (stackLines.length > lines.length * 0.4 && stackLines.length > 3) { return true; }

    // Common exception class names as the primary content
    if (/^\s*(java\.\w+\.|groovy\.\w+\.|org\.[\w.]+)(Exception|Error|Throwable)/m.test(errorMessage)) {
      // Only if there is no "Condition not satisfied:" block — some exceptions
      // are surfaced inside condition blocks and those are legitimate.
      if (!/Condition not satisfied:/.test(errorMessage)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Parse a Spock power assertion block to extract expected and actual values.
   * The expression line contains "lhs == rhs" and the value lines show resolved values
   * underneath each sub-expression, aligned by column position.
   *
   * @param indent number of leading whitespace chars stripped from expressionLine
   *               (needed to align with value-block columns that retain indentation)
   *
   * Example (indent=2):
   *   game.score() == expectedScore    ← expressionLine (captured without the 2 leading spaces)
   *   |    |       |  |                ← pointer lines  (columns are absolute, include the 2 spaces)
   *   |    6       |  7                ← value lines
   *   |            false
   *   Game@abc
   */
  private parseSpockPowerAssertion(expressionLine: string, valueBlock: string, indent: number = 0): DiffInfo | undefined {
    const eqIndex = expressionLine.indexOf('==');
    if (eqIndex === -1) {
      return undefined;
    }

    // The absolute column of == in the original output (accounting for stripped indent)
    const eqCol = eqIndex + indent;

    const valueLines = valueBlock.split('\n');

    // Collect all (column, value) pairs from the value lines,
    // but skip the "false" / "true" token sitting directly under the == operator
    // (that's the comparison result, not a data value).
    // Also skip Spock's similarity analysis lines (e.g. "1 difference (83% similarity)")
    // which appear after the power assertion values and pollute token extraction.
    const values: Array<{ col: number; value: string }> = [];
    let inSimilarityBlock = false;
    for (const vLine of valueLines) {
      // Once we hit the similarity analysis block, skip all remaining lines
      if (inSimilarityBlock) { continue; }
      // Detect start of Spock's similarity analysis (e.g. "1 difference (83% similarity)")
      if (/^\s*\d+\s+difference/.test(vLine)) { inSimilarityBlock = true; continue; }
      // Skip lines that look like stack traces
      if (/^\s*at\s+/.test(vLine)) { continue; }
      // Skip Groovy/Java object representation lines (toString() dumps).
      // These look like: <com.example.ClassName@hexhash prop=val ...>
      // Their internal tokens (e.g. "frames=[[3,") would pollute value extraction.
      if (/^\s*<?[a-zA-Z_][\w.]*@[0-9a-fA-F]+/.test(vLine)) { continue; }

      let i = 0;
      while (i < vLine.length) {
        if (vLine[i] === '|' || vLine[i] === ' ') {
          i++;
          continue;
        }
        // Found start of a value token
        const start = i;
        if (vLine[start] === '[') {
          // Bracket-enclosed value: track depth so we stop at the matching ']'
          // instead of consuming content beyond the brackets.
          let depth = 0;
          while (i < vLine.length && vLine[i] !== '|') {
            if (vLine[i] === '[') { depth++; }
            else if (vLine[i] === ']') {
              depth--;
              if (depth === 0) { i++; break; }
            }
            i++;
          }
        } else if (vLine[start] === '"' || vLine[start] === "'") {
          // Quoted value: scan to closing quote
          const quote = vLine[start];
          i++;
          while (i < vLine.length && vLine[i] !== quote) { i++; }
          if (i < vLine.length) { i++; }
        } else {
          // Regular value: stop at space or pipe
          while (i < vLine.length && vLine[i] !== '|' && vLine[i] !== ' ') {
            i++;
          }
        }
        const token = vLine.substring(start, i).trim();
        if (token) {
          // Skip the boolean comparison result directly under the == operator.
          // Use absolute column comparison (start vs eqCol).
          // Tolerance of 2 covers the width of "==" without catching RHS values
          // that start just after the operator.
          const isComparisonResult = (token === 'false' || token === 'true') &&
            Math.abs(start - eqCol) <= 2;
          if (!isComparisonResult) {
            values.push({ col: start, value: token });
          }
        }
        i++;
      }
    }

    if (values.length === 0) {
      return undefined;
    }

    // Separate LHS (column < eqCol) and RHS (column > eqCol+2) candidates
    const lhsCandidates: Array<{ col: number; value: string }> = [];
    const rhsCandidates: Array<{ col: number; value: string }> = [];

    for (const v of values) {
      if (v.col < eqCol) {
        lhsCandidates.push(v);
      } else if (v.col > eqCol + 2) {
        // col > eqCol+2 to skip past the "==" itself (2 chars wide)
        rhsCandidates.push(v);
      }
    }

    // LHS: pick value closest to == (the outermost expression result)
    let lhsValue: string | undefined;
    let lhsBestDist = Infinity;
    for (const v of lhsCandidates) {
      const dist = eqCol - v.col;
      if (dist < lhsBestDist) {
        lhsBestDist = dist;
        lhsValue = v.value;
      }
    }

    // RHS: prefer simple values over Groovy map/object representations.
    // In property-access chains like "gameState.expectedRoll", the intermediate
    // object (gameState) resolves to a map string that is closer to == than the
    // leaf value (expectedRoll). Filtering out map values lets us pick the leaf.
    const simpleRhs = rhsCandidates.filter(v => !this.looksLikeMapValue(v.value));
    const validRhs = simpleRhs.length > 0 ? simpleRhs : rhsCandidates;

    let rhsValue: string | undefined;
    let rhsBestDist = Infinity;
    for (const v of validRhs) {
      const dist = v.col - eqCol;
      if (dist < rhsBestDist) {
        rhsBestDist = dist;
        rhsValue = v.value;
      }
    }

    if (lhsValue !== undefined && rhsValue !== undefined) {
      // Sanity: if expected and actual are identical, diff is meaningless — skip
      if (lhsValue === rhsValue) {
        return undefined;
      }
      // Reject values that look like fully-qualified class names, object references, or stack fragments.
      if (this.looksLikeClassName(lhsValue) || this.looksLikeClassName(rhsValue)) {
        return undefined;
      }
      // In Spock, `lhs == rhs` means rhs is the "expected" and lhs is the "actual"
      return { expected: rhsValue, actual: lhsValue };
    }

    return undefined;
  }

  /**
   * Check if a string looks like a Java class name or object reference
   * rather than a meaningful test value.
   */
  private looksLikeClassName(value: string): boolean {
    // Matches patterns like "com.example.Foo", "Foo@1a2b3c", "com.example.Foo$Bar"
    if (/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*){2,}/.test(value)) { return true; }
    if (/^[a-zA-Z_]\w*@[0-9a-fA-F]+$/.test(value)) { return true; }
    // Stack trace fragment
    if (/^\s*at\s+/.test(value)) { return true; }
    return false;
  }

  /**
   * Check if a value looks like a Groovy map/object string representation
   * rather than a simple expected/actual value. These appear as intermediate
   * values in Spock power assertions when accessing properties of complex objects.
   * Examples: [rolls:[3, 4], expectedFrame:10, expectedRoll:2, expectedGameOver:true]
   */
  private looksLikeMapValue(value: string): boolean {
    return value.startsWith('[') && /\w+:\s*[^\s]/.test(value);
  }

  /**
   * Capture the failure detail block from console output lines following a FAILED line.
   * Gradle prints assertion details indented below the FAILED result line.
   * Captures "Condition not satisfied:", exception messages, and stack trace lines.
   */
  private captureFailureBlock(lines: string[], startIndex: number): string | undefined {
    const captured: string[] = [];
    let foundContent = false;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Stop at the next test result line or empty separator
      if (trimmed.match(/\s*(PASSED|FAILED|SKIPPED)\s*$/)) {
        break;
      }
      // Stop at Gradle task lines
      if (trimmed.startsWith('> Task ') || trimmed.match(/^\d+ tests? completed/)) {
        break;
      }

      // Capture indented content (assertion blocks, exception messages, stack traces)
      if (trimmed.length > 0) {
        captured.push(line.trimEnd());
        foundContent = true;
      } else if (foundContent && captured.length > 0) {
        // Allow one blank line within a block, but two consecutive blanks = end
        const lastLine = captured[captured.length - 1];
        if (lastLine.trim() === '') {
          break;
        }
        captured.push('');
      }
    }

    // Trim trailing empty lines
    while (captured.length > 0 && captured[captured.length - 1].trim() === '') {
      captured.pop();
    }

    return captured.length > 0 ? captured.join('\n') : undefined;
  }

  /**
   * Extract iteration information from test name
   */
  extractIterationInfo(testName: string): { index: number; parameters: Record<string, any> } | null {
    const info = this.extractIterationFromName(testName);
    if (info) {
      const parameters = this.parseParameters(info.parametersString);
      return { index: info.index, parameters };
    }
    return null;
  }

  /**
   * Extract iteration info from a test name that may contain nested brackets.
   * Handles patterns like:
   *   Standard:  "test name [a: 1, b: 2, #0]"
   *   Nested:    "test name [gameState: [rolls:[3, 4], expectedFrame:2], #1]"
   *   @Unroll:   "test name[0] - perfect game: [10, 10, 10] -> 300"
   * Returns the base test name, raw parameters string, and iteration index.
   */
  private extractIterationFromName(fullName: string): { baseName: string; parametersString: string; index: number } | null {
    // First, try the standard Spock format ending with ", #N]"
    const indexMatch = fullName.match(/,\s*#(\d+)\]\s*$/);
    if (indexMatch) {
      const index = parseInt(indexMatch[1]);
      // Find the opening bracket that corresponds to the closing bracket at the end
      // Walk backwards from the position before ", #N]" to find the matching "["
      const closingPos = fullName.length - indexMatch[0].length + indexMatch[0].indexOf(']');
      
      // Find the outermost opening bracket by counting bracket depth from the end
      let depth = 1; // We start inside the closing bracket
      let openPos = -1;
      for (let i = closingPos - 1; i >= 0; i--) {
        if (fullName[i] === ']') {
          depth++;
        } else if (fullName[i] === '[') {
          depth--;
          if (depth === 0) {
            openPos = i;
            break;
          }
        }
      }

      if (openPos !== -1) {
        const baseName = fullName.substring(0, openPos).trim();
        // Parameters string is between the opening bracket and the ", #N" part
        const paramsEnd = fullName.lastIndexOf(`,${indexMatch[0].substring(1)}`) !== -1 
          ? fullName.lastIndexOf(`,${indexMatch[0].substring(1)}`)
          : fullName.lastIndexOf(`, #${index}]`);
        const parametersString = fullName.substring(openPos + 1, paramsEnd).trim();

        return { baseName, parametersString, index };
      }
    }

    // Then, try @Unroll custom pattern format: "baseName[N] - ..." or "baseName[N]"
    // When @Unroll uses #iterationIndex, Spock produces names like:
    //   "complex scoring scenarios[0] - perfect game: [10, 10, 10] -> 300"
    const unrollMatch = fullName.match(/^(.+?)\[(\d+)\](.*)$/);
    if (unrollMatch) {
      const baseName = unrollMatch[1].trim();
      const index = parseInt(unrollMatch[2]);
      const suffix = unrollMatch[3].trim();
      // Use the suffix (after the [N]) as a descriptive parameters string
      const parametersString = suffix.startsWith('-') ? suffix.substring(1).trim() : suffix;

      return { baseName, parametersString, index };
    }

    return null;
  }

  /**
   * Combine console and XML results, preferring XML for accuracy
   */
  async parseTestResults(
    consoleOutput: string, 
    testName: string, 
    className: string, 
    workspacePath: string,
    buildTool: BuildTool = 'gradle'
  ): Promise<TestIterationResult[]> {
    this.logger.appendLine(`TestResultParser: Parsing results for ${className}.${testName}`);
    
    // Try XML first (more accurate)
    const allXmlResults = await this.parseXmlReport(workspacePath, className, buildTool);
    
    // Filter to only iterations belonging to this specific test method
    const xmlResults = allXmlResults.filter(r => {
      const info = this.extractIterationFromName(r.displayName);
      return info && info.baseName === testName;
    });

    if (xmlResults.length > 0) {
      this.logger.appendLine(`TestResultParser: Using ${xmlResults.length} results from XML report (filtered from ${allXmlResults.length} total)`);
      return xmlResults;
    }

    // For placeholder tests (e.g. "maximum of #a and #b is #c"), Spock replaces
    // the placeholders with actual values in the XML (e.g. "maximum of 1 and 3 is 3")
    // so the standard [params, #N] parsing won't find them. Try matching unrolled names.
    if (testName.includes('#')) {
      const placeholderResults = await this.parseXmlReportForPlaceholderTest(workspacePath, className, testName, buildTool);
      if (placeholderResults.length > 0) {
        this.logger.appendLine(`TestResultParser: Using ${placeholderResults.length} results from XML placeholder matching`);
        return placeholderResults;
      }
    }
    
    // Fallback to console output
    const consoleResults = this.parseConsoleOutput(consoleOutput, testName);
    this.logger.appendLine(`TestResultParser: Using ${consoleResults.length} results from console output`);
    return consoleResults;
  }

  /**
   * Match unrolled test names from XML for placeholder tests.
   * Converts "maximum of #a and #b is #c" into a regex that matches
   * "maximum of 1 and 3 is 3", extracting parameter values.
   */
  private async parseXmlReportForPlaceholderTest(
    workspacePath: string,
    className: string,
    testName: string,
    buildTool: BuildTool = 'gradle'
  ): Promise<TestIterationResult[]> {
    const placeholderRegex = this.buildPlaceholderRegex(testName);
    if (!placeholderRegex) { return []; }

    const testResultsDir = BuildToolService.getTestResultsDir(workspacePath, buildTool);
    try {
      await fsp.access(testResultsDir);
    } catch {
      return [];
    }

    const files = await fsp.readdir(testResultsDir);
    const matchingFile = files.find(f => f.endsWith(`${className}.xml`));
    if (!matchingFile) { return []; }

    const xmlPath = path.join(testResultsDir, matchingFile);
    const xmlContent = await fsp.readFile(xmlPath, 'utf8');
    this.logger.appendLine(`TestResultParser: Matching placeholder test "${testName}" against XML: ${xmlPath}`);

    const parsed = this.xmlParser.parse(xmlContent);
    const testcases = this.extractTestCases(parsed);
    const results: TestIterationResult[] = [];
    let index = 0;

    for (const tc of testcases) {
      const fullName = tc['@_name'] || '';
      const time = parseFloat(tc['@_time'] || '0');

      const paramMatch = placeholderRegex.exec(fullName);
      if (!paramMatch) { continue; }

      const parameters = this.extractParametersFromPlaceholderMatch(testName, paramMatch);

      const { hasFailed, hasError, success } = this.getTestCaseStatus(tc);

      let errorInfo: { error: string; diff?: DiffInfo } | undefined;
      if (hasFailed) {
        const errorText = this.extractErrorFromTestCase(tc, 'failure');
        const diff = this.parseExpectedActual(errorText);
        errorInfo = { error: errorText, diff };
      } else if (hasError) {
        const errorText = this.extractErrorFromTestCase(tc, 'error');
        const diff = this.parseExpectedActual(errorText);
        errorInfo = { error: errorText, diff };
      }

      results.push({
        index: index++,
        displayName: fullName,
        parameters,
        success,
        duration: time,
        errorInfo,
        output: fullName
      });

      this.logger.appendLine(`TestResultParser: Placeholder match #${index - 1}: "${fullName}" - ${success ? 'PASSED' : 'FAILED'}`);
    }

    return results;
  }

  /**
   * Convert a placeholder test name to a regex pattern.
   * "maximum of #a and #b is #c" → /^maximum of (.+?) and (.+?) is (.+?)$/
   */
  buildPlaceholderRegex(testName: string): RegExp | null {
    const placeholders = testName.match(/#\w+/g);
    if (!placeholders) { return null; }

    // Escape the test name for regex, then replace escaped placeholders with capture groups
    let pattern = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const placeholder of placeholders) {
      const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pattern = pattern.replace(escaped, '(.+?)');
    }

    return new RegExp(`^${pattern}$`);
  }

  /**
   * Extract parameters from a placeholder regex match.
   * Maps each #varName in the original test name to the captured value.
   */
  private extractParametersFromPlaceholderMatch(
    testName: string,
    match: RegExpExecArray
  ): Record<string, any> {
    const placeholders = testName.match(/#(\w+)/g);
    if (!placeholders) { return {}; }

    const params: Record<string, any> = {};
    for (let i = 0; i < placeholders.length; i++) {
      const paramName = placeholders[i].substring(1); // Remove leading #
      const value = match[i + 1]; // match[0] is the full match
      if (value === undefined) { continue; }

      // Try to parse as number or boolean
      if (!isNaN(Number(value)) && value !== '') {
        params[paramName] = Number(value);
      } else if (value === 'true' || value === 'false') {
        params[paramName] = value === 'true';
      } else {
        params[paramName] = value;
      }
    }

    return params;
  }

  /**
   * Extract parameters from unrolled test names like "maximum of 1 and 3 is 3"
   * This is a best-effort attempt to extract meaningful data
   */
  private extractParametersFromUnrolledName(unrolledName: string): Record<string, any> {
    const parameters: Record<string, any> = {};
    
    // Try to extract parameters from patterns like "maximum of 1 and 3 is 3"
    const maxMatch = unrolledName.match(/^maximum of (\d+) and (\d+) is (\d+)$/);
    if (maxMatch) {
      parameters['a'] = parseInt(maxMatch[1]);
      parameters['b'] = parseInt(maxMatch[2]);
      parameters['c'] = parseInt(maxMatch[3]);
    }
    
    // Try to extract name and age from patterns like "Alice is 25 years old"
    const nameAgeMatch = unrolledName.match(/^([^0-9]+?)\s+is\s+(\d+)\s+years\s+old$/);
    if (nameAgeMatch) {
      parameters['name'] = nameAgeMatch[1].trim();
      parameters['age'] = parseInt(nameAgeMatch[2]);
    }
    
    // If no specific pattern matches, store the whole name as a parameter
    if (Object.keys(parameters).length === 0) {
      parameters['unrolledName'] = unrolledName;
    }
    
    return parameters;
  }
}
