import * as vscode from 'vscode';
import { TestResultParser } from './services/TestResultParser';
import { IConfigurationService } from './services/ConfigurationService';
import { extractErrorForTest } from './services/SpockErrorParser';
import { TestData, TestIterationResult, DiffInfo, BuildTool } from './types';

/**
 * Processes test execution results: data-driven iteration handling,
 * iteration TestItem creation, where-block range calculation, and
 * test message formatting.
 */
export class ResultProcessor {
  /** Cache of document content keyed by URI string to avoid repeated openTextDocument calls. */
  private readonly documentCache = new Map<string, string>();

  constructor(
    private readonly controller: vscode.TestController,
    private readonly logger: vscode.LogOutputChannel,
    private readonly testResultParser: TestResultParser,
    private readonly configurationService: IConfigurationService,
    private readonly testData: WeakMap<vscode.TestItem, TestData>,
    private readonly iterationItems: Map<string, vscode.TestItem[]>,
  ) {}

  /** Clear the internal document cache (e.g. between test runs). */
  clearDocumentCache(): void {
    this.documentCache.clear();
  }

  // ── Data-driven test results ───────────────────────────────────────

  async handleDataDrivenTestResults(
    test: vscode.TestItem,
    data: TestData,
    result: any,
    run: vscode.TestRun,
    workspacePath: string,
    buildTool: BuildTool = 'gradle',
    startTime?: number,
  ): Promise<void> {
    this.logger.appendLine(`ResultProcessor: Handling data-driven test results for ${data.className}.${data.testName}`);

    try {
      const iterationResults = await this.testResultParser.parseTestResults(
        result.output || '',
        data.testName!,
        data.className!,
        workspacePath,
        buildTool,
      );

      if (iterationResults.length > 0) {
        this.logger.appendLine(`ResultProcessor: Found ${iterationResults.length} iteration results`);

        data.iterationResults = iterationResults;
        this.testData.set(test, data);

        await this.createFlatIterationItems(test, iterationResults, run);
      } else {
        this.logger.appendLine('ResultProcessor: No iteration results found, treating as regular test');
        const duration = startTime == null ? undefined : Date.now() - startTime;
        if (result.success) {
          run.passed(test, duration);
        } else {
          const errorMessage = this.resolveFallbackErrorMessage(result.output || '', data.className!, data.testName!);
          const message = this.createTestMessage(errorMessage);
          run.failed(test, message, duration);
        }
      }
    } catch (error) {
      this.logger.appendLine(`ResultProcessor: Error handling data-driven test results: ${error}`);
      const duration = startTime == null ? undefined : Date.now() - startTime;
      if (result.success) {
        run.passed(test, duration);
      } else {
        const errorMessage = this.resolveFallbackErrorMessage(result.output || '', data.className!, data.testName!);
        const message = this.createTestMessage(errorMessage);
        run.failed(test, message, duration);
      }
    }
  }

  private resolveFallbackErrorMessage(output: string, className: string, testName: string): string {
    const parsed = extractErrorForTest(output || '', className, testName);
    if (parsed && parsed !== 'Test failed') {
      return parsed;
    }

    if (!output) {
      return `${className}.${testName} FAILED`;
    }

    const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    const simpleClassName = className.includes('.') ? className.substring(className.lastIndexOf('.') + 1) : className;

    const isNoise = (line: string): boolean => (
      /^\[INFO\]/i.test(line)
      || /^\[DEBUG\]/i.test(line)
      || /^\[WARNING\]/i.test(line)
      || /^BUILD (FAILED|SUCCESSFUL)\b/i.test(line)
      || (/^>\s*Task\s+/i.test(line) && !/FAILED\s*$/i.test(line))
      || /^>\s*Task\s+:[^\s]+\s+(UP-TO-DATE|NO-SOURCE|FROM-CACHE|SKIPPED|SUCCESS|EXECUTED)\s*$/i.test(line)
      || /^\* Try:/i.test(line)
      || /^\* Get more help/i.test(line)
      || /^>\s*Run with\s+--/i.test(line)
      || /^\d+ actionable task/i.test(line)
      || /^>\s*Task\s+:[^\s]+\s+FAILED\s*$/i.test(line)
      || /^>?\s*Compilation failed; see the compiler error output for details\.?$/i.test(line)
      || /^\[ERROR\]\s+BUILD FAILURE\s*$/i.test(line)
      || /^\[ERROR\]\s+COMPILATION ERROR\s*:?\s*$/i.test(line)
      || /^\[ERROR\]\s+Failed to execute goal\s+/i.test(line)
    );

    const scopedFailureLine = lines.find((line) =>
      line.includes(testName)
      && (line.includes(className) || line.includes(simpleClassName))
      && /(FAILED|FAILURE|\[ERROR\]|<<<\s+FAILURE|<<<\s+ERROR)/i.test(line),
    );
    if (scopedFailureLine) {
      return scopedFailureLine;
    }

    const focused = lines.filter((line) =>
      !isNoise(line)
      && (
        /Condition not satisfied:|Assertion failed:|Caused by:|Exception|Error:|unable to resolve class|could not resolve/i.test(line)
        || /^\s*at\s+/.test(line)
        || /\.(java|groovy|kt):\s*\d+/i.test(line)
      ),
    );
    if (focused.length > 0) {
      return focused.slice(0, 12).join('\n');
    }

    const nonNoise = lines.filter((line) => !isNoise(line));
    if (nonNoise.length > 0) {
      return nonNoise.slice(0, 12).join('\n');
    }

    return `${className}.${testName} FAILED`;
  }

  // ── Iteration item creation ────────────────────────────────────────

  async createFlatIterationItems(
    parentTest: vscode.TestItem,
    iterationResults: TestIterationResult[],
    run: vscode.TestRun,
  ): Promise<void> {
    this.logger.appendLine(`ResultProcessor: Creating ${iterationResults.length} flat iteration items`);

    const testName = parentTest.label;
    const className = this.testData.get(parentTest)?.className || 'Unknown';
    const fileUri = parentTest.uri?.toString() || '';

    // Pre-fetch and cache the document content once for all iterations
    let cachedContent: string | undefined;
    if (parentTest.uri) {
      const uriKey = parentTest.uri.toString();
      if (this.documentCache.has(uriKey)) {
        cachedContent = this.documentCache.get(uriKey);
      } else {
        try {
          const document = await vscode.workspace.openTextDocument(parentTest.uri);
          cachedContent = document.getText();
          this.documentCache.set(uriKey, cachedContent);
        } catch (error) {
          this.logger.appendLine(`ResultProcessor: Error pre-fetching document: ${error}`);
        }
      }
    }

    const sortedResults = [...iterationResults];
    sortedResults.sort((a, b) => {
      if (a.index !== b.index) {
        return a.index - b.index;
      }
      const aParams = Object.values(a.parameters).join(',');
      const bParams = Object.values(b.parameters).join(',');
      return aParams.localeCompare(bParams);
    });

    const newIterationItems: vscode.TestItem[] = [];

    for (const iteration of sortedResults) {
      const iterationId = `${parentTest.id}#iteration-${iteration.index}`;
      const iterationLabel = `${testName} [#${iteration.index}] ${this.formatParameters(iteration.parameters)}`;

      const iterationItem = this.resolveOrCreateIterationItem(parentTest, iterationId, iterationLabel);
      const iterationRange = await this.calculateIterationRange(parentTest, iteration, cachedContent);
      iterationItem.range = iterationRange;

      this.testData.set(iterationItem, {
        type: 'test',
        className,
        testName,
        isDataDriven: false,
      });

      newIterationItems.push(iterationItem);
      this.reportIterationResult(iterationItem, iteration, run);
      this.logger.appendLine(`ResultProcessor: Created flat iteration item: ${iterationLabel}`);
    }

    this.iterationItems.set(fileUri, newIterationItems);
    this.reportParentIterationResult(parentTest, sortedResults, run);
  }

  /**
   * Reuse an existing pre-parsed iteration item if available, otherwise create a new one.
   */
  private resolveOrCreateIterationItem(
    parentTest: vscode.TestItem,
    iterationId: string,
    iterationLabel: string,
  ): vscode.TestItem {
    let existing: vscode.TestItem | undefined;
    parentTest.children.forEach(child => {
      if (child.id === iterationId) { existing = child; }
    });

    if (existing) {
      (existing as any).label = iterationLabel;
      return existing;
    }

    const item = this.controller.createTestItem(iterationId, iterationLabel, parentTest.uri);
    parentTest.children.add(item);
    return item;
  }

  private reportIterationResult(
    iterationItem: vscode.TestItem,
    iteration: TestIterationResult,
    run: vscode.TestRun,
  ): void {
    if (iteration.success) {
      run.passed(iterationItem, iteration.duration * 1000);
    } else {
      const message = this.createTestMessage(
        iteration.errorInfo?.error || 'Iteration failed',
        iteration.errorInfo?.diff,
      );
      if (iteration.errorInfo?.location) {
        message.location = iteration.errorInfo.location;
      }
      run.failed(iterationItem, message, iteration.duration * 1000);
    }
  }

  private reportParentIterationResult(
    parentTest: vscode.TestItem,
    sortedResults: TestIterationResult[],
    run: vscode.TestRun,
  ): void {
    const failedIteration = sortedResults.find((r) => !r.success);
    if (failedIteration) {
      const message = this.createTestMessage(
        failedIteration.errorInfo?.error || 'One or more iterations failed',
        failedIteration.errorInfo?.diff,
      );
      run.failed(parentTest, message);
    } else {
      run.passed(parentTest);
    }
  }

  // ── Where-block range calculation ──────────────────────────────────

  async calculateIterationRange(parentTest: vscode.TestItem, iteration: TestIterationResult, cachedContent?: string): Promise<vscode.Range> { // NOSONAR
    if (!parentTest.uri) {
      return parentTest.range || new vscode.Range(0, 0, 0, 0);
    }

    try {
      let content: string;
      const uriKey = parentTest.uri.toString();
      if (cachedContent !== undefined) {
        content = cachedContent;
      } else if (this.documentCache.has(uriKey)) {
        content = this.documentCache.get(uriKey)!;
      } else {
        const document = await vscode.workspace.openTextDocument(parentTest.uri);
        content = document.getText();
        this.documentCache.set(uriKey, content);
      }
      const lines = content.split('\n');

      const testName = parentTest.label;
      let testMethodLine = -1;
      let whereBlockLine = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(`def "${testName}"`) || line.includes(`def ${testName}`)) {
          testMethodLine = i;
          break;
        }
      }

      if (testMethodLine === -1) {
        return parentTest.range || new vscode.Range(0, 0, 0, 0);
      }

      for (let i = testMethodLine; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === 'where:') {
          whereBlockLine = i;
          break;
        }
      }

      if (whereBlockLine === -1) {
        return parentTest.range || new vscode.Range(0, 0, 0, 0);
      }

      // Detect data-table vs data-pipe syntax
      let usesDataPipe = false;
      for (let i = whereBlockLine + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('@')) {
          continue;
        }
        usesDataPipe = trimmed.includes('<<');
        break;
      }

      const dataRows: number[] = [];
      let headerSkipped = usesDataPipe;
      for (let i = whereBlockLine + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '}' || /^(and|then|when|expect|setup|given|cleanup|where|def |@)\s*/.test(trimmed)) {
          break;
        }
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
          continue;
        }
        if (!headerSkipped) {
          headerSkipped = true;
          continue;
        }
        dataRows.push(i);
      }

      const iterationLine = iteration.index < dataRows.length
        ? dataRows[iteration.index]
        : undefined;

      if (iterationLine === undefined || iterationLine >= lines.length) {
        return parentTest.range || new vscode.Range(0, 0, 0, 0);
      }

      return new vscode.Range(iterationLine, 0, iterationLine, lines[iterationLine].length);
    } catch (error) {
      this.logger.appendLine(`Error calculating iteration range: ${error}`);
      return parentTest.range || new vscode.Range(0, 0, 0, 0);
    }
  }

  // ── Formatting helpers ─────────────────────────────────────────────

  formatParameters(parameters: Record<string, any>): string {
    const entries = Object.entries(parameters);
    if (entries.length === 0) {
      return '';
    }
    return entries.map(([key, value]) => `${key}: ${value}`).join(', ');
  }

  /**
   * Create a TestMessage, using diff() when expected/actual values are available
   * so VS Code renders a rich inline diff view.
   * Gated behind the (Preview) `showDiffView` setting.
   */
  createTestMessage(errorText: string, diff?: DiffInfo): vscode.TestMessage {
    const useDiff = this.configurationService.getConfig().showDiffView;
    if (useDiff && diff) {
      return vscode.TestMessage.diff(errorText, diff.expected, diff.actual);
    }
    if (useDiff) {
      const parsed = this.testResultParser.parseExpectedActual(errorText);
      if (parsed) {
        return vscode.TestMessage.diff(errorText, parsed.expected, parsed.actual);
      }
    }
    return new vscode.TestMessage(errorText);
  }
}
