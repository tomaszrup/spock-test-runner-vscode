/**
 * Centralised Spock/Groovy error-parsing utilities.
 *
 * Both TestExecutionService (single-test error parsing) and the test controller's
 * fallback error extraction share nearly identical logic for capturing Spock
 * "Condition not satisfied" blocks, stack traces, and failure lines.
 * This module de-duplicates that logic into reusable functions.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { DiffInfo } from '../types';

// ── Types ────────────────────────────────────────────────────────────────

export interface ParsedTestError {
  error: string;
  location?: vscode.Location;
  diff?: DiffInfo;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Parse a full build output to extract a structured error for a single test run.
 * Used by TestExecutionService after a process exits with non-zero code.
 *
 * Returns `undefined` when the output contains no recognizable error pattern.
 */
export function parseTestError(output: string): ParsedTestError | undefined { // NOSONAR
  const lines = output.split('\n');
  let errorMessage = 'Test execution failed';
  let location: vscode.Location | undefined;
  const stackTraceLines: string[] = [];
  let capturingStackTrace = false;
  let conditionBlock: string[] = [];
  let capturingCondition = false;

  for (const line of lines) {

    if (line.includes('FAILED') && (line.includes('Test') || line.includes('Spec'))) {
      errorMessage = line.trim();
    }

    // Capture Spock condition-not-satisfied blocks (the power assert output)
    if (line.includes('Condition not satisfied:') || line.includes('Assertion failed:')) {
      capturingCondition = true;
      conditionBlock = [line.trim()];
      continue;
    }
    if (capturingCondition) {
      // Condition blocks are indented; stop at a blank or non-indented line
      if (/^\s+/.exec(line) && !line.trim().startsWith('at ')) {
        conditionBlock.push(line.trimEnd());
        continue;
      } else {
        capturingCondition = false;
      }
    }

    // Capture stack trace lines
    if (line.trim().startsWith('at ')) {
      capturingStackTrace = true;
      stackTraceLines.push(line.trim());
    } else if (capturingStackTrace && (line.trim().startsWith('Caused by:') || line.trim().startsWith('...'))) {
      stackTraceLines.push(line.trim());
    } else if (capturingStackTrace && line.trim() === '') {
      // Allow blank lines within stack traces
    } else {
      capturingStackTrace = false;
    }

    // Capture exception lines
    if (line.includes('spock.lang.Specification') || line.includes('groovy.lang.MissingMethodException')) {
      errorMessage = line.trim();
    }
    if (line.includes('Exception') || line.includes('Error:')) {
      if (!line.includes('BUILD') && !line.includes('> Task')) {
        stackTraceLines.push(line.trim());
      }
    }

    // Extract location from stack trace
    if (line.includes('.groovy:') && line.includes('at ') && !location) {
      const match = /at\s+.*\((.+\.groovy):(\d+)\)/.exec(line);
      if (match) {
        const filePath = match[1];
        const lineNumber = Number.parseInt(match[2], 10) - 1;

        try {
          const uri = vscode.Uri.file(path.resolve(filePath));
          location = new vscode.Location(uri, new vscode.Position(lineNumber, 0));
        } catch {
          // Ignore if file path is invalid
        }
      }
    }
  }

  if (errorMessage === 'Test execution failed') {
    for (const line of lines) {
      if (line.includes('Exception') || line.includes('Error') || line.includes('failed')) {
        errorMessage = line.trim();
        break;
      }
    }
  }

  // Build a comprehensive error message with condition block and stack trace
  const parts: string[] = [];
  if (conditionBlock.length > 0) {
    parts.push(conditionBlock.join('\n'));
  } else {
    parts.push(errorMessage);
  }
  if (stackTraceLines.length > 0) {
    parts.push('', 'Stack trace:', stackTraceLines.join('\n'));
  }

  const fullError = parts.join('\n');
  return { error: fullError, location };
}

/**
 * Extract meaningful error information from console output for a specific
 * class / test.  Used as a fallback when XML result reports are unavailable.
 *
 * Looks for Spock assertion blocks, exception messages, and stack traces
 * that mention the given class or test name.
 */
export function extractErrorForTest(output: string, className: string, testName: string): string { // NOSONAR
  if (!output) {
    return 'Test failed';
  }

  const lines = output.split('\n');
  const simpleClassName = className.includes('.') ? className.substring(className.lastIndexOf('.') + 1) : className;
  const testHeaderRegex = new RegExp(String.raw`^\s*${escapeRegExp(simpleClassName)}\s+>\s+${escapeRegExp(testName)}\s+(STANDARD_ERROR|STANDARD_OUT)\s*$`, 'i');

  const isFailureLineForTarget = (line: string): boolean => {
    if (!line.includes(testName)) {
      return false;
    }

    const hasClass = line.includes(className) || line.includes(simpleClassName);
    if (!hasClass) {
      return false;
    }

    return /(FAILED|FAILURE|\[ERROR\]|<<<\s+FAILURE|<<<\s+ERROR)/i.test(line);
  };

  const isFailureBoundary = (line: string): boolean => {
    const gradleResultBoundary = /^\s*\S+\s+>\s+.+?\s+(PASSED|FAILED|SKIPPED)\s*$/i.test(line);
    const mavenBoundary = /^\s*\[ERROR\]\s+.+\s+<<<\s+(FAILURE|ERROR)!\s*$/i.test(line);
    return gradleResultBoundary || mavenBoundary;
  };

  const failureIndex = lines.findIndex(isFailureLineForTarget);
  if (failureIndex === -1) {
    return 'Test failed';
  }

  const fallbackFailureLine = lines[failureIndex].trim();
  const parts: string[] = [];
  let conditionBlock: string[] = [];
  let capturingCondition = false;
  const stackTraceLines: string[] = [];
  const standardOutputBlock: string[] = [];
  let capturingStandardOutput = false;
  let seenStandardOutputContent = false;
  let causeLine: string | undefined;

  for (let i = failureIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Stop at the next test result boundary to keep extraction scoped
    if (isFailureBoundary(line) && i !== failureIndex + 1) {
      break;
    }

    // Skip Gradle 8.x internal mapping diagnostics — these are not
    // part of the actual test failure output.
    if (/Failed to map supported failure/i.test(trimmed) || /with mapper.*OpenTest/i.test(trimmed)) {
      continue;
    }

    if (testHeaderRegex.test(trimmed)) {
      capturingStandardOutput = true;
      seenStandardOutputContent = false;
      continue;
    }

    if (capturingStandardOutput) {
      if (trimmed.length === 0) {
        if (seenStandardOutputContent) {
          capturingStandardOutput = false;
        }
        continue;
      }
      if (/^\S+\s+>\s+.+\s+(FAILED|PASSED|SKIPPED)\s*$/i.test(trimmed)) {
        capturingStandardOutput = false;
      } else if (/^\S+\s+>\s+.+\s+STANDARD_(ERROR|OUT)\s*$/i.test(trimmed)) {
        capturingStandardOutput = false;
      } else {
        if (!isGradleTaskNoiseLine(trimmed)) {
          standardOutputBlock.push(trimmed);
          seenStandardOutputContent = true;
        }
        continue;
      }
    }

    // Capture Spock "Condition not satisfied" / "Assertion failed" blocks
    if (trimmed.includes('Condition not satisfied:') || trimmed.includes('Assertion failed:')) {
      capturingCondition = true;
      conditionBlock = [trimmed];
      continue;
    }
    if (capturingCondition) {
      if (/^\s+/.exec(line) && !line.trim().startsWith('at ')) {
        conditionBlock.push(line.trimEnd());
        continue;
      } else {
        capturingCondition = false;
      }
    }

    // Capture stack trace lines and chain causes (test-scoped only)
    if (trimmed.startsWith('at ') || /^\.\.\.\s+\d+\s+more$/.test(trimmed)) {
      if (!isGradleInternalStackLine(trimmed)) {
        stackTraceLines.push(trimmed);
      }
      continue;
    }

    if (/^Caused by:\s+/i.test(trimmed)) {
      stackTraceLines.push(trimmed);
      continue;
    }

    if (!causeLine && trimmed.length > 0) {
      const looksLikeCause =
        (
          /(AssertionError|ComparisonFailure|Condition not satisfied|Assertion failed|Exception|Error:)/i.test(trimmed)
          || /(expected:\s*<|Actual|Expected|Compilation failed)/i.test(trimmed)
          || /^>\s*Task\s+.+\s+FAILED\s*$/i.test(trimmed)
        )
        && !isGradleTaskNoiseLine(trimmed)
        && !/^\s*\[INFO\]/i.test(trimmed)
        && !/^\s*\[DEBUG\]/i.test(trimmed);
      if (looksLikeCause) {
        causeLine = trimmed;
      }
    }
  }

  // Build the error message
  if (conditionBlock.length > 0) {
    parts.push(conditionBlock.join('\n'));
  } else if (causeLine) {
    parts.push(causeLine);
  }

  if (standardOutputBlock.length > 0) {
    const stdBlock = standardOutputBlock.join('\n').trim();
    if (stdBlock.length > 0) {
      if (parts.length > 0) { parts.push(''); }
      parts.push(stdBlock);
    }
  }

  if (stackTraceLines.length > 0) {
    if (parts.length > 0) { parts.push(''); }
    parts.push(stackTraceLines.join('\n'));
  }

  if (parts.length > 0) {
    return parts.join('\n');
  }

  return fallbackFailureLine || 'Test failed';
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function isGradleInternalStackLine(line: string): boolean {
  return /\borg\.gradle\.|\bworker\.org\.gradle\./.test(line);
}

function isGradleTaskNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!/^>\s*Task\s+/i.test(trimmed)) {
    return false;
  }
  return !/\bFAILED\s*$/i.test(trimmed);
}

/**
 * Check whether the console output contains any error/failure lines for a
 * specific class.
 */
export function hasErrorForClass(output: string, className: string): boolean {
  if (!output) { return false; }
  const lines = output.split('\n');
  for (const line of lines) {
    if (line.includes(className) && (line.includes('FAILED') || line.includes('FAILURE') || line.includes('[ERROR]'))) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether the console output contains a failure line for a specific test.
 * More precise than {@link hasErrorForClass}: only returns true when the output
 * contains a FAILED/FAILURE/ERROR line mentioning the test name together with
 * the class name.
 *
 * Handles both Gradle format ("ClassName > testName FAILED") and Maven format
 * (lines mentioning both class and test name alongside a failure keyword).
 */
export function hasErrorForTest(output: string, className: string, testName: string): boolean {
  if (!output || !testName) { return false; }
  const lines = output.split('\n');
  for (const line of lines) {
    // The line must reference the specific test name AND contain a failure keyword.
    // We match the test name AND either the class name or a failure keyword pattern
    // to avoid false positives from generic error text.
    if (line.includes(testName) && (line.includes('FAILED') || line.includes('FAILURE'))) {
      // Extra check: the class name should also appear on the same line
      // (either FQN or simple name) to avoid cross-class false positives.
      const simpleName = className.includes('.') ? className.substring(className.lastIndexOf('.') + 1) : className;
      if (line.includes(className) || line.includes(simpleName)) {
        return true;
      }
    }
  }
  return false;
}
