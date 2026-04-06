import * as vscode from 'vscode';
import { ConfigurationService } from './ConfigurationService';
import type { BatchCommandOptions, TestDescriptor } from './BuildToolService';
import { getCoverageInitScriptPath, getInitScriptPath } from './buildToolResources';
import { hasGradleWrapper } from './buildToolProjects';
import { sanitizeTestFilter, shellEscape, validateExtraArgs } from './buildToolSecurity';

function resolveGradleCommand(useWrapper: boolean): string {
  if (!useWrapper) {
    return 'gradle';
  }
  return process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
}

export async function buildGradleCommandArgs(
  testName: string,
  debug: boolean,
  workspacePath?: string,
  logger?: vscode.OutputChannel,
  subprojectPrefix?: string,
  debugPort?: number,
): Promise<string[]> {
  const configScope = workspacePath ? vscode.Uri.file(workspacePath) : undefined;
  const cfg = ConfigurationService.getConfig(configScope);
  const wsRoot = workspacePath
    ? (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspacePath))?.uri.fsPath ?? workspacePath)
    : undefined;
  const useWrapper = !!workspacePath && await hasGradleWrapper(workspacePath, wsRoot);
  const gradleCommand = resolveGradleCommand(useWrapper);
  const taskName = subprojectPrefix ? `${subprojectPrefix}:test` : 'test';
  const args = [
    gradleCommand,
    taskName,
    '--tests',
    shellEscape(sanitizeTestFilter(testName, logger)),
    '--rerun-tasks',
    '--init-script',
    shellEscape(await getInitScriptPath()),
  ];

  if (logger) {
    logger.appendLine('BuildToolService: Forcing Gradle producer tasks to rerun (--rerun-tasks) to avoid stale compiled outputs');
    logger.appendLine('BuildToolService: Using Gradle init script to force test execution (--init-script)');
  }

  if (debug) {
    const port = debugPort ?? cfg.debugPort;
    args.push('--debug-jvm', `-Dorg.gradle.jvmargs=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:${port}`);
  }

  args.push(...validateExtraArgs(cfg.additionalGradleArgs, 'gradle', logger));
  return args;
}

export async function buildGradleBatchCommandArgs(
  testFilters: string[],
  debug: boolean,
  workspacePath?: string,
  logger?: vscode.OutputChannel,
  subprojectPrefix?: string,
  options: Omit<BatchCommandOptions, 'buildTool'> = {},
): Promise<string[]> {
  const { coverage = false, debugPort, classTestCounts, testDescriptors } = options;
  const configScope = workspacePath ? vscode.Uri.file(workspacePath) : undefined;
  const cfg = ConfigurationService.getConfig(configScope);
  const wsRoot = workspacePath
    ? (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspacePath))?.uri.fsPath ?? workspacePath)
    : undefined;
  const useWrapper = !!workspacePath && await hasGradleWrapper(workspacePath, wsRoot);
  const gradleCommand = resolveGradleCommand(useWrapper);
  const taskName = subprojectPrefix ? `${subprojectPrefix}:test` : 'test';
  const args = [gradleCommand, taskName, '--rerun-tasks'];

  for (const filter of coalesceGradleFilters(testFilters, classTestCounts, logger, testDescriptors)) {
    args.push('--tests', shellEscape(sanitizeTestFilter(filter, logger)));
  }

  args.push('--init-script', shellEscape(coverage ? await getCoverageInitScriptPath() : await getInitScriptPath()));

  if (logger) {
    logger.appendLine('BuildToolService: Forcing Gradle producer tasks to rerun (--rerun-tasks) to avoid stale compiled outputs');
    logger.appendLine(`BuildToolService: Batch execution with ${testFilters.length} test filter(s)${coverage ? ' (with coverage)' : ''}`);
  }

  if (debug) {
    const port = debugPort ?? cfg.debugPort;
    args.push('--debug-jvm', `-Dorg.gradle.jvmargs=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:${port}`);
  }

  args.push(...validateExtraArgs(cfg.additionalGradleArgs, 'gradle', logger));
  return args;
}

export function coalesceGradleFilters(
  testFilters: string[],
  classTestCounts?: Map<string, number>,
  logger?: vscode.OutputChannel,
  testDescriptors?: TestDescriptor[],
): string[] {
  if (!(classTestCounts?.size)) {
    return testFilters;
  }

  const selectedByClass = new Map<string, string[]>();
  const descriptors = testDescriptors?.length === testFilters.length
    ? testDescriptors
    : testFilters.map(filter => {
      const lastDot = filter.lastIndexOf('.');
      return {
        className: lastDot > 0 ? filter.substring(0, lastDot) : filter,
        testName: lastDot > 0 ? filter.substring(lastDot + 1) : undefined,
      };
    });

  descriptors.forEach((descriptor, index) => {
    if (!descriptor.className || !descriptor.testName) {
      return;
    }
    const filters = selectedByClass.get(descriptor.className) ?? [];
    filters.push(testFilters[index]);
    selectedByClass.set(descriptor.className, filters);
  });

  const result: string[] = [];
  const coalescedClasses = new Set<string>();
  for (const [className, filters] of selectedByClass) {
    const totalMethods = classTestCounts.get(className);
    if (totalMethods !== undefined && filters.length >= totalMethods) {
      result.push(`${className}.*`);
      coalescedClasses.add(className);
    } else {
      result.push(...filters);
    }
  }

  if (coalescedClasses.size > 0 && logger) {
    logger.appendLine(`BuildToolService: Coalesced ${coalescedClasses.size} class(es) to wildcard filters (reduced ${testFilters.length} → ${result.length} filters)`);
  }
  return result;
}

export function estimateGradleArgsLength(baseArgs: string[], testFilters: string[]): number {
  let length = baseArgs.join(' ').length;
  for (const filter of testFilters) {
    length += ' --tests '.length + shellEscape(sanitizeTestFilter(filter)).length;
  }
  return length;
}

export function getMaxCommandLineLength(): number {
  return process.platform === 'win32' ? 7500 : 120_000;
}

export function splitGradleTestFilters(
  testFilters: string[],
  baseArgs: string[],
  maxLen?: number,
): string[][] {
  const limit = maxLen ?? getMaxCommandLineLength();
  const baseLen = baseArgs.join(' ').length;
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentLen = baseLen;

  for (const filter of testFilters) {
    const addition = ' --tests '.length + shellEscape(sanitizeTestFilter(filter)).length;
    if (currentBatch.length > 0 && currentLen + addition > limit) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLen = baseLen;
    }
    currentBatch.push(filter);
    currentLen += addition;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches.length > 0 ? batches : [testFilters];
}