import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import { BuildTool, DiffInfo, TestIterationResult } from '../types';
import {
  buildPlaceholderRegex,
  extractIterationFromName,
  extractIterationInfo,
  parseConsoleOutput,
} from './testResultParserIteration';
import { parseExpectedActual } from './testResultParserDiff';
import {
  parseClassTestResults,
  parseXmlReport,
  parseXmlReportForPlaceholderTest,
} from './testResultParserXml';

export class TestResultParser {
  private readonly logger: vscode.LogOutputChannel;
  private readonly xmlParser: XMLParser;

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
  parseConsoleOutput(output: string, testName: string): TestIterationResult[] { // NOSONAR
    return parseConsoleOutput(this.logger, output, testName);
  }

  /**
   * Parse XML test report to extract iteration results
   */
  async parseXmlReport(workspacePath: string, className: string, buildTool: BuildTool = 'gradle'): Promise<TestIterationResult[]> {
    return parseXmlReport(this.getXmlContext(), workspacePath, className, buildTool);
  }

  /**
   * Parse XML report to get pass/fail/skip results for all tests in a class.
   * Returns a map from test name to result.
   */
  async parseClassTestResults(workspacePath: string, className: string, buildTool: BuildTool = 'gradle'): Promise<Map<string, {success: boolean; skipped: boolean; duration: number; errorMessage?: string; diff?: DiffInfo}>> {
    return parseClassTestResults(this.getXmlContext(), workspacePath, className, buildTool);
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
    return parseExpectedActual(errorMessage);
  }

  /**
   * Extract iteration information from test name
   */
  extractIterationInfo(testName: string): { index: number; parameters: Record<string, any> } | null {
    return extractIterationInfo(testName);
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
      const info = extractIterationFromName(r.displayName);
      return info?.baseName === testName;
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
    return parseXmlReportForPlaceholderTest(this.getXmlContext(), workspacePath, className, testName, buildTool);
  }

  /**
   * Convert a placeholder test name to a regex pattern.
   * "maximum of #a and #b is #c" → /^maximum of (.+?) and (.+?) is (.+?)$/
   */
  buildPlaceholderRegex(testName: string): RegExp | null {
    return buildPlaceholderRegex(testName);
  }

  private getXmlContext(): { logger: vscode.LogOutputChannel; xmlParser: XMLParser } {
    return {
      logger: this.logger,
      xmlParser: this.xmlParser,
    };
  }
}
