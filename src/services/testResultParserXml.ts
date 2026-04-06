import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import { BuildTool, DiffInfo, TestIterationResult } from '../types';
import { BuildToolService } from './BuildToolService';
import { prependSourceHint } from './SpockErrorParser';
import { parseExpectedActual } from './testResultParserDiff';
import {
  buildPlaceholderRegex,
  extractIterationFromName,
  extractParametersFromPlaceholderMatch,
} from './testResultParserIteration';

export interface TestResultParserXmlContext {
  logger: vscode.LogOutputChannel;
  xmlParser: XMLParser;
}

export async function parseXmlReport(
  context: TestResultParserXmlContext,
  workspacePath: string,
  className: string,
  buildTool: BuildTool = 'gradle',
): Promise<TestIterationResult[]> {
  const results: TestIterationResult[] = [];
  const testResultsDir = BuildToolService.getTestResultsDir(workspacePath, buildTool);

  try {
    await fsp.access(testResultsDir);
  } catch {
    context.logger.appendLine(`TestResultParser: XML report directory not found: ${testResultsDir}`);
    return results;
  }

  try {
    const files = await fsp.readdir(testResultsDir);
    const matchingFile = findBestMatchingReportFile(files, className);
    if (!matchingFile) {
      context.logger.appendLine(`TestResultParser: No XML report found for class ${className}`);
      return results;
    }

    const xmlPath = path.join(testResultsDir, matchingFile);
    const parsed = context.xmlParser.parse(await fsp.readFile(xmlPath, 'utf8'));
    context.logger.appendLine(`TestResultParser: Parsing XML report: ${xmlPath}`);

    for (const testCase of extractTestCases(parsed)) {
      const fullName = testCase['@_name'] || '';
      const iterationInfo = extractIterationFromName(fullName);
      if (!iterationInfo) {
        continue;
      }

      results.push({
        index: iterationInfo.index,
        displayName: fullName,
        parameters: parseParameters(iterationInfo.parametersString),
        success: getTestCaseStatus(testCase).success,
        duration: Number.parseFloat(testCase['@_time'] || '0'),
        errorInfo: buildErrorInfo(testCase),
        output: fullName,
      });
      context.logger.appendLine(`TestResultParser: Found XML iteration #${iterationInfo.index}: ${getTestCaseStatus(testCase).success ? 'PASSED' : 'FAILED'}`);
    }

    context.logger.appendLine(`TestResultParser: Parsed ${results.length} iterations from XML report`);
    return results;
  } catch (error) {
    context.logger.appendLine(`TestResultParser: Error parsing XML report: ${error}`);
    return results;
  }
}

export async function parseClassTestResults(
  context: TestResultParserXmlContext,
  workspacePath: string,
  className: string,
  buildTool: BuildTool = 'gradle',
): Promise<Map<string, {success: boolean; skipped: boolean; duration: number; errorMessage?: string; diff?: DiffInfo}>> {
  const testResultsDir = BuildToolService.getTestResultsDir(workspacePath, buildTool);
  try {
    await fsp.access(testResultsDir);
  } catch {
    context.logger.appendLine(`TestResultParser: Test results directory not found: ${testResultsDir}`);
    return new Map();
  }

  try {
    const files = await fsp.readdir(testResultsDir);
    const matchingFile = findBestMatchingReportFile(files, className);
    if (!matchingFile) {
      context.logger.appendLine(`TestResultParser: No XML report found for class ${className}`);
      return new Map();
    }
    return parseXmlFileForClassResults(context, path.join(testResultsDir, matchingFile));
  } catch (error) {
    context.logger.appendLine(`TestResultParser: Error parsing class test results: ${error}`);
    return new Map();
  }
}

export async function parseXmlReportForPlaceholderTest(
  context: TestResultParserXmlContext,
  workspacePath: string,
  className: string,
  testName: string,
  buildTool: BuildTool = 'gradle',
): Promise<TestIterationResult[]> {
  const placeholderRegex = buildPlaceholderRegex(testName);
  if (!placeholderRegex) {
    return [];
  }

  const testResultsDir = BuildToolService.getTestResultsDir(workspacePath, buildTool);
  try {
    await fsp.access(testResultsDir);
  } catch {
    return [];
  }

  const files = await fsp.readdir(testResultsDir);
  const matchingFile = findBestMatchingReportFile(files, className);
  if (!matchingFile) {
    return [];
  }

  const xmlPath = path.join(testResultsDir, matchingFile);
  context.logger.appendLine(`TestResultParser: Matching placeholder test "${testName}" against XML: ${xmlPath}`);
  const parsed = context.xmlParser.parse(await fsp.readFile(xmlPath, 'utf8'));
  const results: TestIterationResult[] = [];
  let index = 0;

  for (const testCase of extractTestCases(parsed)) {
    const fullName = testCase['@_name'] || '';
    const parameterMatch = placeholderRegex.exec(fullName);
    if (!parameterMatch) {
      continue;
    }
    results.push({
      index: index++,
      displayName: fullName,
      parameters: extractParametersFromPlaceholderMatch(testName, parameterMatch),
      success: getTestCaseStatus(testCase).success,
      duration: Number.parseFloat(testCase['@_time'] || '0'),
      errorInfo: buildErrorInfo(testCase),
      output: fullName,
    });
    context.logger.appendLine(`TestResultParser: Placeholder match #${index - 1}: "${fullName}" - ${getTestCaseStatus(testCase).success ? 'PASSED' : 'FAILED'}`);
  }

  return results;
}

function parseParameters(parametersString: string): Record<string, any> {
  const parameters: Record<string, any> = {};
  for (const pair of parametersString.split(',').map(value => value.trim())) {
    const colonIndex = pair.indexOf(':');
    if (colonIndex <= 0) {
      continue;
    }
    const key = pair.substring(0, colonIndex).trim();
    const value = pair.substring(colonIndex + 1).trim();
    let parsedValue: any = value.replaceAll(/^['"]|['"]$/g, '');
    if (value === 'true') {
      parsedValue = true;
    } else if (value === 'false') {
      parsedValue = false;
    } else if (!Number.isNaN(Number(value)) && value !== '') {
      parsedValue = Number(value);
    }
    parameters[key] = parsedValue;
  }
  return parameters;
}

async function parseXmlFileForClassResults(
  context: TestResultParserXmlContext,
  xmlPath: string,
): Promise<Map<string, {success: boolean; skipped: boolean; duration: number; errorMessage?: string; diff?: DiffInfo}>> {
  const results = new Map<string, {success: boolean; skipped: boolean; duration: number; errorMessage?: string; diff?: DiffInfo}>();
  context.logger.appendLine(`TestResultParser: Parsing XML for class results: ${xmlPath}`);
  const parsed = context.xmlParser.parse(await fsp.readFile(xmlPath, 'utf8'));

  for (const testCase of extractTestCases(parsed)) {
    const status = getTestCaseStatus(testCase);
    const errorInfo = buildErrorInfo(testCase);
    results.set(testCase['@_name'] || '', {
      success: status.success,
      skipped: !!testCase.skipped,
      duration: Number.parseFloat(testCase['@_time'] || '0'),
      errorMessage: errorInfo?.error,
      diff: errorInfo?.diff,
    });
  }

  context.logger.appendLine(`TestResultParser: Found ${results.size} test results in XML`);
  return results;
}

function extractTestCases(parsed: any): any[] {
  const testsuite = parsed?.testsuite;
  if (!testsuite?.testcase) {
    return [];
  }
  return Array.isArray(testsuite.testcase) ? testsuite.testcase : [testsuite.testcase];
}

function getTestCaseStatus(testCase: any): { hasFailed: boolean; hasError: boolean; success: boolean } {
  const hasFailed = !!testCase.failure;
  const hasError = !!testCase.error;
  return { hasFailed, hasError, success: !hasFailed && !hasError };
}

function buildErrorInfo(testCase: any): { error: string; diff?: DiffInfo } | undefined {
  const status = getTestCaseStatus(testCase);
  if (!status.hasFailed && !status.hasError) {
    return undefined;
  }
  const tag = status.hasFailed ? 'failure' : 'error';
  const error = extractErrorFromTestCase(testCase, tag);
  return { error, diff: parseExpectedActual(error) };
}

function extractErrorFromTestCase(testCase: any, tag: 'failure' | 'error'): string {
  const element = testCase[tag];
  if (!element) {
    return `Test ${tag}`;
  }
  if (typeof element === 'string') {
    return prependSourceHint(element.trim() || `Test ${tag}`);
  }

  const cdata = element['#cdata'];
  if (cdata && String(cdata).trim()) {
    return prependSourceHint(String(cdata).trim());
  }
  const textBody = element['#text'];
  if (textBody && String(textBody).trim()) {
    return prependSourceHint(String(textBody).trim());
  }
  if (element['@_message']) {
    return prependSourceHint(element['@_message']);
  }
  return `Test ${tag}`;
}

function findBestMatchingReportFile(files: string[], className: string): string | undefined {
  const exactNames = new Set([`${className}.xml`, `TEST-${className}.xml`]);
  for (const file of files) {
    if (exactNames.has(file)) {
      return file;
    }
  }

  const fqnSuffix = `.${className}.xml`;
  const fqnMatch = files.find(file => file.endsWith(fqnSuffix));
  if (fqnMatch) {
    return fqnMatch;
  }

  const simpleName = className.includes('.') ? className.substring(className.lastIndexOf('.') + 1) : className;
  const simpleExact = new Set([`${simpleName}.xml`, `TEST-${simpleName}.xml`]);
  for (const file of files) {
    if (simpleExact.has(file)) {
      return file;
    }
  }
  return files.find(file => file.endsWith(`${simpleName}.xml`));
}