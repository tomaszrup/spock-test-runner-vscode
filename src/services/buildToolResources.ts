import * as fs from 'node:fs';
import * as path from 'node:path';
import { BuildTool } from '../types';

const fsp = fs.promises;

let extensionPath: string | undefined;

export const XML_PARENT_BLOCK_REGEX = /<parent>[\s\S]*?<\/parent>/g;

export function setExtensionPath(value: string): void {
  extensionPath = value;
}

export function getExtensionRoot(): string {
  return extensionPath ?? path.join(__dirname, '..', '..');
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    if (!await fileExists(filePath)) {
      return undefined;
    }
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

export async function getInitScriptPath(): Promise<string> {
  const initScriptPath = path.join(getExtensionRoot(), 'resources', 'force-tests.init.gradle');
  if (!await fileExists(initScriptPath)) {
    throw new Error(`Init script not found at: ${initScriptPath}`);
  }
  return initScriptPath;
}

export async function getCoverageInitScriptPath(): Promise<string> {
  const initScriptPath = path.join(getExtensionRoot(), 'resources', 'coverage.init.gradle');
  if (!await fileExists(initScriptPath)) {
    throw new Error(`Coverage init script not found at: ${initScriptPath}`);
  }
  return initScriptPath;
}

export function getTestResultsDir(projectRoot: string, buildTool: BuildTool): string {
  if (buildTool === 'maven') {
    return path.join(projectRoot, 'target', 'surefire-reports');
  }
  return path.join(projectRoot, 'build', 'test-results', 'test');
}