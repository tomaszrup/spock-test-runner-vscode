import * as vscode from 'vscode';
import { TestIterationResult } from '../types';
import { captureFailureBlock } from './testResultParserDiff';

export function parseConsoleOutput(logger: vscode.LogOutputChannel, output: string, testName: string): TestIterationResult[] { // NOSONAR
  const results: TestIterationResult[] = [];
  const lines = output.split('\n');
  logger.appendLine(`TestResultParser: Parsing console output for test: ${testName}`);

  if (testName.includes('#')) {
    const placeholderPattern = /^.*>\s*([^>]+?)\s*>\s*([^>]+?)\s*(PASSED|FAILED|SKIPPED)$/;
    for (const line of lines) {
      const match = matchPlaceholderIteration(line, testName, placeholderPattern);
      if (!match) {
        continue;
      }
      const unrolledName = match[2].trim();
      const success = match[3] === 'PASSED';
      results.push({
        index: results.length,
        displayName: `${testName} > ${unrolledName}`,
        parameters: extractParametersFromUnrolledName(unrolledName),
        success,
        duration: 0,
        output: line.trim(),
        errorInfo: success ? undefined : { error: `Test failed: ${unrolledName}` },
      });
      logger.appendLine(`TestResultParser: Found unrolled test: ${unrolledName} - ${success ? 'PASSED' : 'FAILED'}`);
    }
    logger.appendLine(`TestResultParser: Parsed ${results.length} iterations from console output`);
    return results;
  }

  const escapedTestName = testName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const testNameRegex = new RegExp(String.raw`>\s*${escapedTestName}\s*\[`);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const statusMatch = /\s*(PASSED|FAILED|SKIPPED)\s*$/.exec(line);
    if (!statusMatch || !testNameRegex.exec(line)) {
      continue;
    }

    const status = statusMatch[1];
    const afterTestName = line.substring(line.indexOf('['));
    const beforeStatus = afterTestName.substring(0, afterTestName.lastIndexOf(status)).trim();
    const iterationInfo = extractIterationFromName(`${testName} ${beforeStatus}`);
    if (!iterationInfo) {
      continue;
    }

    const success = status === 'PASSED';
    results.push({
      index: iterationInfo.index,
      displayName: `${testName} [${iterationInfo.parametersString}, #${iterationInfo.index}]`,
      parameters: parseParameters(iterationInfo.parametersString),
      success,
      duration: 0,
      output: line.trim(),
      errorInfo: success ? undefined : { error: captureFailureBlock(lines, index + 1) || `Iteration ${iterationInfo.index} ${status}` },
    });
    logger.appendLine(`TestResultParser: Found iteration #${iterationInfo.index}: ${success ? 'PASSED' : 'FAILED'}`);
  }

  logger.appendLine(`TestResultParser: Parsed ${results.length} iterations from console output`);
  return results;
}

function matchPlaceholderIteration(
  line: string,
  testName: string,
  placeholderPattern: RegExp,
): RegExpExecArray | undefined {
  const match = placeholderPattern.exec(line);
  if (!match) {
    return undefined;
  }
  return match[1].trim() === testName ? match : undefined;
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
    parameters[key] = coerceParameterValue(value);
  }
  return parameters;
}

function coerceParameterValue(value: string): any {
  if (value === 'true') { return true; }
  if (value === 'false') { return false; }
  if (!Number.isNaN(Number(value)) && value !== '') { return Number(value); }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function extractIterationInfo(testName: string): { index: number; parameters: Record<string, any> } | null {
  const info = extractIterationFromName(testName);
  if (!info) {
    return null;
  }
  return { index: info.index, parameters: parseParameters(info.parametersString) };
}

export function extractIterationFromName(fullName: string): { baseName: string; parametersString: string; index: number } | null { // NOSONAR
  const indexMatch = /,\s*#(\d+)\]\s*$/.exec(fullName);
  if (indexMatch) {
    const index = Number.parseInt(indexMatch[1], 10);
    const closingPos = fullName.length - indexMatch[0].length + indexMatch[0].indexOf(']');
    let depth = 1;
    let openPos = -1;
    for (let pos = closingPos - 1; pos >= 0; pos--) {
      if (fullName[pos] === ']') {
        depth++;
      } else if (fullName[pos] === '[') {
        depth--;
        if (depth === 0) {
          openPos = pos;
          break;
        }
      }
    }
    if (openPos !== -1) {
      const indexSuffix = `,${indexMatch[0].substring(1)}`;
      const paramsEnd = fullName.includes(indexSuffix)
        ? fullName.lastIndexOf(indexSuffix)
        : fullName.lastIndexOf(`, #${index}]`);
      return {
        baseName: fullName.substring(0, openPos).trim(),
        parametersString: fullName.substring(openPos + 1, paramsEnd).trim(),
        index,
      };
    }
  }

  const unrollMatch = /^(.+?)\[(\d+)\](.*)$/.exec(fullName);
  if (!unrollMatch) {
    return null;
  }
  return {
    baseName: unrollMatch[1].trim(),
    index: Number.parseInt(unrollMatch[2], 10),
    parametersString: unrollMatch[3].trim().replace(/^-/u, '').trim(),
  };
}

export function buildPlaceholderRegex(testName: string): RegExp | null {
  const placeholders = testName.match(/#\w+/g);
  if (!placeholders) {
    return null;
  }

  let pattern = testName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  for (const placeholder of placeholders) {
    const escaped = placeholder.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    pattern = pattern.replaceAll(escaped, '(.+?)');
  }
  return new RegExp(`^${pattern}$`);
}

export function extractParametersFromPlaceholderMatch(testName: string, match: RegExpExecArray): Record<string, any> {
  const placeholders = testName.match(/#(\w+)/g);
  if (!placeholders) {
    return {};
  }

  const parameters: Record<string, any> = {};
  for (let index = 0; index < placeholders.length; index++) {
    const value = match[index + 1];
    if (value !== undefined) {
      parameters[placeholders[index].substring(1)] = coerceParameterValue(value);
    }
  }
  return parameters;
}

export function extractParametersFromUnrolledName(unrolledName: string): Record<string, any> {
  const tokenRegex = /(-?\d+(?:\.\d+)?|true|false|'[^']*'|"[^"]*")/g;
  const parameters: Record<string, any> = {};
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = tokenRegex.exec(unrolledName)) !== null) {
    parameters[`param${index++}`] = coerceParameterValue(match[1]);
  }
  if (index === 0) {
    parameters.unrolledName = unrolledName;
  }
  return parameters;
}