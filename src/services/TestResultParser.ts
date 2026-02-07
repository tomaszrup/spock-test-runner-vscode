import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestIterationResult } from '../types';

export class TestResultParser {
  private logger: vscode.OutputChannel;

  constructor(logger: vscode.OutputChannel) {
    this.logger = logger;
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
  async parseXmlReport(workspacePath: string, className: string): Promise<TestIterationResult[]> {
    const results: TestIterationResult[] = [];
    const testResultsDir = path.join(workspacePath, 'build', 'test-results', 'test');

    try {
      if (!fs.existsSync(testResultsDir)) {
        this.logger.appendLine(`TestResultParser: XML report directory not found: ${testResultsDir}`);
        return results;
      }

      // Find the XML file for this class (could be FQN like TEST-com.example.ClassName.xml)
      const files = fs.readdirSync(testResultsDir);
      const matchingFile = files.find(f => f.endsWith(`${className}.xml`));
      if (!matchingFile) {
        this.logger.appendLine(`TestResultParser: No XML report found for class ${className}`);
        return results;
      }

      const xmlPath = path.join(testResultsDir, matchingFile);
      const xmlContent = fs.readFileSync(xmlPath, 'utf8');
      this.logger.appendLine(`TestResultParser: Parsing XML report: ${xmlPath}`);

      // Parse XML to extract testcase elements
      // Match testcase elements - self-closing (passed) and with body (failed/error)
      const testcaseRegex = /<testcase\s+name="([^"]+)"[^>]*classname="([^"]+)"[^>]*time="([^"]*)"[^>]*(?:\/>|>([\s\S]*?)<\/testcase>)/g;
      let match;

      while ((match = testcaseRegex.exec(xmlContent)) !== null) {
        const fullName = match[1];
        const testClassName = match[2];
        const time = parseFloat(match[3] || '0');
        const innerContent = match[4] || '';

        // Check if this is an iteration (contains parameter values and index)
        // Use helper that handles nested brackets like [gameState: [rolls:[3, 4], ...], #2]
        const iterationInfo = this.extractIterationFromName(fullName);
        
        if (iterationInfo) {
          const parameters = this.parseParameters(iterationInfo.parametersString);
          
          const hasFailed = innerContent.includes('<failure');
          const hasError = innerContent.includes('<error');
          const success = !hasFailed && !hasError;

          let errorInfo: { error: string } | undefined;
          if (hasFailed) {
            errorInfo = { error: this.extractFullErrorFromXml(innerContent, 'failure') };
          } else if (hasError) {
            errorInfo = { error: this.extractFullErrorFromXml(innerContent, 'error') };
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
   * Parse XML report to get pass/fail results for all tests in a class.
   * Returns a map from test name to result.
   */
  async parseClassTestResults(workspacePath: string, className: string): Promise<Map<string, {success: boolean; duration: number; errorMessage?: string}>> {
    const testResultsDir = path.join(workspacePath, 'build', 'test-results', 'test');

    try {
      if (!fs.existsSync(testResultsDir)) {
        this.logger.appendLine(`TestResultParser: Test results directory not found: ${testResultsDir}`);
        return new Map();
      }

      // Find the XML file for this class (could be FQN like TEST-com.example.ClassName.xml)
      const files = fs.readdirSync(testResultsDir);
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

  private parseXmlFileForClassResults(xmlPath: string): Map<string, {success: boolean; duration: number; errorMessage?: string}> {
    const results = new Map<string, {success: boolean; duration: number; errorMessage?: string}>();
    const xmlContent = fs.readFileSync(xmlPath, 'utf8');
    this.logger.appendLine(`TestResultParser: Parsing XML for class results: ${xmlPath}`);

    // Match testcase elements - self-closing (passed) and with body (failed/error)
    const testcaseRegex = /<testcase\s+name="([^"]+)"[^>]*time="([^"]*)"[^>]*(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    let match;

    while ((match = testcaseRegex.exec(xmlContent)) !== null) {
      const testName = match[1];
      const time = parseFloat(match[2] || '0');
      const innerContent = match[3] || '';

      const hasFailed = innerContent.includes('<failure');
      const hasError = innerContent.includes('<error');

      let errorMessage: string | undefined;
      if (hasFailed) {
        errorMessage = this.extractFullErrorFromXml(innerContent, 'failure');
      } else if (hasError) {
        errorMessage = this.extractFullErrorFromXml(innerContent, 'error');
      }

      results.set(testName, { success: !hasFailed && !hasError, duration: time, errorMessage });
    }

    this.logger.appendLine(`TestResultParser: Found ${results.size} test results in XML`);
    return results;
  }

  /**
   * Extract full error message including stack trace from XML failure/error element.
   * Handles both CDATA sections and plain text content, plus the message attribute.
   */
  private extractFullErrorFromXml(innerContent: string, tag: 'failure' | 'error'): string {
    // Try to get the message attribute first
    const messageAttrMatch = innerContent.match(new RegExp(`<${tag}[^>]*message="([^"]*)"`));
    const messageAttr = messageAttrMatch ? this.decodeXmlEntities(messageAttrMatch[1]) : '';

    // Try to get the full body content (which typically includes the stack trace)
    // Handle CDATA: <failure ...><![CDATA[...]]></failure>
    const cdataMatch = innerContent.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`));
    if (cdataMatch) {
      const body = cdataMatch[1].trim();
      return body || messageAttr || `Test ${tag}`;
    }

    // Handle plain text body: <failure ...>text</failure>
    const bodyMatch = innerContent.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    if (bodyMatch) {
      const body = this.decodeXmlEntities(bodyMatch[1]).trim();
      return body || messageAttr || `Test ${tag}`;
    }

    // Self-closing with only message attribute: <failure message="..." />
    return messageAttr || `Test ${tag}`;
  }

  /**
   * Decode common XML entities back to their original characters.
   */
  private decodeXmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
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
   *   "test name [a: 1, b: 2, #0]"
   *   "test name [gameState: [rolls:[3, 4], expectedFrame:2], #1]"
   * Returns the base test name, raw parameters string, and iteration index.
   */
  private extractIterationFromName(fullName: string): { baseName: string; parametersString: string; index: number } | null {
    // Find the last occurrence of ", #N]" which marks the iteration index
    const indexMatch = fullName.match(/,\s*#(\d+)\]\s*$/);
    if (!indexMatch) {
      return null;
    }

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

    if (openPos === -1) {
      return null;
    }

    const baseName = fullName.substring(0, openPos).trim();
    // Parameters string is between the opening bracket and the ", #N" part
    const paramsEnd = fullName.lastIndexOf(`,${indexMatch[0].substring(1)}`) !== -1 
      ? fullName.lastIndexOf(`,${indexMatch[0].substring(1)}`)
      : fullName.lastIndexOf(`, #${index}]`);
    const parametersString = fullName.substring(openPos + 1, paramsEnd).trim();

    return { baseName, parametersString, index };
  }

  /**
   * Combine console and XML results, preferring XML for accuracy
   */
  async parseTestResults(
    consoleOutput: string, 
    testName: string, 
    className: string, 
    workspacePath: string
  ): Promise<TestIterationResult[]> {
    this.logger.appendLine(`TestResultParser: Parsing results for ${className}.${testName}`);
    
    // Try XML first (more accurate)
    const allXmlResults = await this.parseXmlReport(workspacePath, className);
    
    // Filter to only iterations belonging to this specific test method
    const xmlResults = allXmlResults.filter(r => {
      const info = this.extractIterationFromName(r.displayName);
      return info && info.baseName === testName;
    });

    if (xmlResults.length > 0) {
      this.logger.appendLine(`TestResultParser: Using ${xmlResults.length} results from XML report (filtered from ${allXmlResults.length} total)`);
      return xmlResults;
    }
    
    // Fallback to console output
    const consoleResults = this.parseConsoleOutput(consoleOutput, testName);
    this.logger.appendLine(`TestResultParser: Using ${consoleResults.length} results from console output`);
    return consoleResults;
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
