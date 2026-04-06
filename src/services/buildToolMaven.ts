import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConfigurationService } from './ConfigurationService';
import type { TestDescriptor } from './BuildToolService';
import {
  fileExists,
  XML_PARENT_BLOCK_REGEX,
} from './buildToolResources';
import { hasMavenWrapper } from './buildToolProjects';
import { sanitizeTestFilter, shellEscape, validateExtraArgs } from './buildToolSecurity';

const fsp = fs.promises;

export interface MavenBatchCommandOptions {
  workspacePath?: string;
  logger?: vscode.OutputChannel;
  mavenModuleName?: string;
  coverage?: boolean;
  debugPort?: number;
  testDescriptors?: TestDescriptor[];
}

async function getMavenPackaging(
  workspacePath?: string,
  mavenModuleName?: string,
  logger?: vscode.OutputChannel,
): Promise<string> {
  if (!workspacePath) {
    return 'jar';
  }

  const modulePath = mavenModuleName
    ? path.join(workspacePath, ...mavenModuleName.split('/'))
    : workspacePath;
  const pomPath = path.join(modulePath, 'pom.xml');

  try {
    if (!await fileExists(pomPath)) {
      return 'jar';
    }
    const pomContent = await fsp.readFile(pomPath, 'utf8');
    const withoutParent = pomContent.replaceAll(XML_PARENT_BLOCK_REGEX, '');
    const packagingMatch = /<packaging>([^<\s]+)<\/packaging>/i.exec(withoutParent);
    return packagingMatch?.[1]?.trim().toLowerCase() || 'jar';
  } catch (error) {
    logger?.appendLine(`BuildToolService: Could not read Maven packaging from ${pomPath}; defaulting to jar. Error: ${String(error)}`);
    return 'jar';
  }
}

async function getMavenCommand(workspacePath?: string): Promise<string> {
  const wsRoot = workspacePath
    ? (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspacePath))?.uri.fsPath ?? workspacePath)
    : undefined;
  if (workspacePath && await hasMavenWrapper(workspacePath, wsRoot)) {
    return process.platform === 'win32' ? 'mvnw.cmd' : './mvnw';
  }
  return 'mvn';
}

export async function buildMavenCommandArgs(
  testName: string,
  debug: boolean,
  workspacePath?: string,
  logger?: vscode.OutputChannel,
  mavenModuleName?: string,
  debugPort?: number,
): Promise<string[]> {
  const configScope = workspacePath ? vscode.Uri.file(workspacePath) : undefined;
  const cfg = ConfigurationService.getConfig(configScope);
  const mvnCommand = await getMavenCommand(workspacePath);
  const pomPackaging = await getMavenPackaging(workspacePath, mavenModuleName, logger) === 'pom';
  const args = [
    mvnCommand,
    ...(pomPackaging ? ['test-compile', 'surefire:test'] : ['test']),
    `-Dtest=${shellEscape(toSurefireFilter(sanitizeTestFilter(testName, logger)))}`,
    '-Dsurefire.useFile=true',
    '-Dsurefire.failIfNoSpecifiedTests=false',
  ];

  if (mavenModuleName) {
    args.push('-pl', mavenModuleName, '-am');
  }
  if (debug) {
    const port = debugPort ?? cfg.debugPort;
    args.push(`-Dmaven.surefire.debug=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:${port}`);
  }

  logger?.appendLine(`BuildToolService: Using Maven ${pomPackaging ? 'test-compile + surefire:test' : 'test phase'} to execute test`);
  args.push(...validateExtraArgs(cfg.additionalMavenArgs, 'maven', logger));
  return args;
}

export async function buildMavenBatchCommandArgs(
  testFilters: string[],
  debug: boolean,
  options: MavenBatchCommandOptions = {},
): Promise<string[]> {
  const { workspacePath, logger, mavenModuleName, coverage = false, debugPort, testDescriptors } = options;
  const configScope = workspacePath ? vscode.Uri.file(workspacePath) : undefined;
  const cfg = ConfigurationService.getConfig(configScope);
  const mvnCommand = await getMavenCommand(workspacePath);
  const pomPackaging = await getMavenPackaging(workspacePath, mavenModuleName, logger) === 'pom';
  const args = [mvnCommand, ...(pomPackaging ? ['test-compile', 'surefire:test'] : ['test'])];

  const sanitizedDescriptors = testDescriptors?.map(descriptor => ({
    className: sanitizeTestFilter(descriptor.className, logger),
    testName: descriptor.testName ? sanitizeTestFilter(descriptor.testName, logger) : undefined,
  }));
  const surefireFilter = sanitizedDescriptors?.length
    ? buildSurefireBatchFilterFromDescriptors(sanitizedDescriptors)
    : buildSurefireBatchFilter(testFilters.map(filter => sanitizeTestFilter(filter, logger)));

  if (surefireFilter) {
    args.push(`-Dtest=${shellEscape(surefireFilter)}`, '-Dsurefire.useFile=true', '-Dsurefire.failIfNoSpecifiedTests=false');
  }
  if (mavenModuleName) {
    args.push('-pl', mavenModuleName, '-am');
  }
  if (coverage) {
    args.splice(1, 0, 'org.jacoco:jacoco-maven-plugin:prepare-agent');
    args.push('org.jacoco:jacoco-maven-plugin:report');
  }
  if (debug) {
    const port = debugPort ?? cfg.debugPort;
    args.push(`-Dmaven.surefire.debug=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:${port}`);
  }

  logger?.appendLine(`BuildToolService: Maven batch execution via ${pomPackaging ? 'test-compile + surefire:test' : 'test phase'} with ${testFilters.length} test filter(s)${coverage ? ' (with coverage)' : ''}`);
  args.push(...validateExtraArgs(cfg.additionalMavenArgs, 'maven', logger));
  return args;
}

export function toSurefireFilter(testName: string): string {
  const lastDot = testName.lastIndexOf('.');
  if (lastDot <= 0) {
    return testName;
  }

  const className = testName.substring(0, lastDot);
  const methodName = testName.substring(lastDot + 1);
  return `${className}#${escapeMethodForSurefire(methodName)}`;
}

export function buildSurefireBatchFilter(testFilters: string[]): string {
  const classMap = new Map<string, string[]>();
  for (const filter of testFilters) {
    const lastDot = filter.lastIndexOf('.');
    if (lastDot <= 0) {
      classMap.set(filter, classMap.get(filter) ?? []);
      continue;
    }

    const className = filter.substring(0, lastDot);
    const methods = classMap.get(className) ?? [];
    methods.push(escapeMethodForSurefire(filter.substring(lastDot + 1)));
    classMap.set(className, methods);
  }

  return Array.from(classMap, ([className, methods]) => methods.length > 0 ? `${className}#${methods.join('+')}` : className)
    .join(',');
}

export function buildSurefireBatchFilterFromDescriptors(testDescriptors: TestDescriptor[]): string {
  const classMap = new Map<string, string[]>();
  for (const descriptor of testDescriptors) {
    const methods = classMap.get(descriptor.className) ?? [];
    if (descriptor.testName) {
      methods.push(escapeMethodForSurefire(descriptor.testName));
    }
    classMap.set(descriptor.className, methods);
  }

  return Array.from(classMap, ([className, methods]) => methods.length > 0 ? `${className}#${methods.join('+')}` : className)
    .join(',');
}

export function escapeMethodForSurefire(methodName: string): string {
  return methodName
    .replaceAll('+', '__SUREFIRE_PLUS__')
    .replaceAll(',', '__SUREFIRE_COMMA__')
    .replaceAll(/[.*?()[\]{}^$|\\]/g, String.raw`\$&`)
    .replaceAll('__SUREFIRE_PLUS__', '.')
    .replaceAll('__SUREFIRE_COMMA__', '.');
}