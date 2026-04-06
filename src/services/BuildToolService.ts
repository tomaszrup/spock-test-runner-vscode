import * as vscode from 'vscode';
import { BuildTool } from '../types';
import { showWarningStatus } from '../statusBar';
import {
  buildGradleBatchCommandArgs,
  buildGradleCommandArgs,
  coalesceGradleFilters,
  estimateGradleArgsLength,
  getMaxCommandLineLength,
  splitGradleTestFilters,
} from './buildToolGradle';
import {
  buildMavenBatchCommandArgs,
  buildMavenCommandArgs,
  buildSurefireBatchFilter,
  buildSurefireBatchFilterFromDescriptors,
  escapeMethodForSurefire,
  MavenBatchCommandOptions,
  toSurefireFilter,
} from './buildToolMaven';
import {
  findGradleProjectRoot,
  findGradleRootProject,
  findMavenProjectRoot,
  findMavenRootProject,
  getMavenModuleName,
  getProjectName,
  getSubprojectPrefix,
  hasGradleWrapper,
  hasMavenWrapper,
  isGradleProject,
  isMavenProject,
  parseSettingsGradleProjectDirs,
  resolveSubprojectPrefix,
} from './buildToolProjects';
import {
  getCoverageInitScriptPath,
  getTestResultsDir,
  setExtensionPath,
} from './buildToolResources';

export { sanitizeTestFilter, shellEscape, validateExtraArgs } from './buildToolSecurity';

/**
 * Interface for build-tool operations — enables mocking in tests.
 */
export interface IBuildToolService {
  detectBuildTool(workspacePath: string): Promise<BuildTool | null>;
  findProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null>;
  findRootProject(projectPath: string, workspaceRoot: string): Promise<string>;
  getProjectName(workspacePath: string): Promise<string>;
  getSubprojectPrefix(rootProject: string, subprojectPath: string): Promise<string>;
  getMavenModuleName(rootProject: string, submodulePath: string): string;
  buildCommandArgs(testName: string, debug: boolean, workspacePath?: string, logger?: vscode.OutputChannel, subprojectPrefix?: string, buildTool?: BuildTool, debugPort?: number): Promise<string[]>;
  buildBatchCommandArgs(testFilters: string[], debug: boolean, workspacePath?: string, logger?: vscode.OutputChannel, subprojectPrefix?: string, options?: BatchCommandOptions): Promise<string[]>;
  getTestResultsDir(projectRoot: string, buildTool: BuildTool): string;
}

export interface BatchCommandOptions {
  coverage?: boolean;
  buildTool?: BuildTool;
  debugPort?: number;
  classTestCounts?: Map<string, number>;
  testDescriptors?: TestDescriptor[];
}

export interface TestDescriptor {
  className: string;
  testName?: string;
}

export class BuildToolService {
  constructor(extensionPath?: string) {
    if (extensionPath) {
      setExtensionPath(extensionPath);
    }
  }

  static async detectBuildTool(workspacePath: string): Promise<BuildTool | null> {
    if (await this.isGradleProject(workspacePath)) {
      return 'gradle';
    }
    if (await this.isMavenProject(workspacePath)) {
      return 'maven';
    }
    return null;
  }

  static async findProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null> {
    return await this.findGradleProjectRoot(filePath, workspaceRoot)
        || await this.findMavenProjectRoot(filePath, workspaceRoot);
  }

  static async findRootProject(projectPath: string, workspaceRoot: string): Promise<string> {
    if (await this.isGradleProject(projectPath)) {
      return findGradleRootProject(projectPath, workspaceRoot);
    }
    if (await this.isMavenProject(projectPath)) {
      return findMavenRootProject(projectPath, workspaceRoot);
    }
    return projectPath;
  }

  static async findGradleProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null> {
    return findGradleProjectRoot(filePath, workspaceRoot);
  }

  static async isGradleProject(dir: string): Promise<boolean> {
    return isGradleProject(dir);
  }

  static async findGradleRootProject(projectPath: string, workspaceRoot: string): Promise<string> {
    return findGradleRootProject(projectPath, workspaceRoot);
  }

  static getSubprojectPrefix(rootProject: string, subprojectPath: string): string {
    return getSubprojectPrefix(rootProject, subprojectPath);
  }

  static async resolveSubprojectPrefix(rootProject: string, subprojectPath: string): Promise<string> {
    return resolveSubprojectPrefix(rootProject, subprojectPath);
  }

  static parseSettingsGradleProjectDirs(content: string, rootProject: string): Map<string, string> {
    return parseSettingsGradleProjectDirs(content, rootProject);
  }

  static async hasGradleWrapper(workspacePath: string, workspaceRoot?: string): Promise<boolean> {
    return hasGradleWrapper(workspacePath, workspaceRoot);
  }

  static async isMavenProject(dir: string): Promise<boolean> {
    return isMavenProject(dir);
  }

  static async findMavenProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null> {
    return findMavenProjectRoot(filePath, workspaceRoot);
  }

  static async findMavenRootProject(projectPath: string, workspaceRoot: string): Promise<string> {
    return findMavenRootProject(projectPath, workspaceRoot);
  }

  static getMavenModuleName(rootProject: string, submodulePath: string): string {
    return getMavenModuleName(rootProject, submodulePath);
  }

  static async hasMavenWrapper(workspacePath: string, workspaceRoot?: string): Promise<boolean> {
    return hasMavenWrapper(workspacePath, workspaceRoot);
  }

  static async getProjectName(workspacePath: string): Promise<string> {
    return getProjectName(workspacePath);
  }

  static async buildCommandArgs(
    testName: string,
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    subprojectPrefix?: string,
    buildTool?: BuildTool,
    debugPort?: number
  ): Promise<string[]> {
    const detected = buildTool || (workspacePath ? await this.detectBuildTool(workspacePath) : null);
    if (!detected && logger) {
      logger.appendLine('BuildToolService: WARNING — neither Gradle nor Maven detected, defaulting to Gradle');
      showWarningStatus('No Gradle or Maven project detected in the workspace. Defaulting to Gradle.');
    }
    const detectedTool: BuildTool = detected || 'gradle';

    if (detectedTool === 'maven') {
      return buildMavenCommandArgs(testName, debug, workspacePath, logger, subprojectPrefix, debugPort);
    }
    return buildGradleCommandArgs(testName, debug, workspacePath, logger, subprojectPrefix, debugPort);
  }

  static async buildBatchCommandArgs(
    testFilters: string[],
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    subprojectPrefix?: string,
    options: BatchCommandOptions = {}
  ): Promise<string[]> {
    const { coverage = false, buildTool, debugPort, classTestCounts, testDescriptors } = options;
    const detected = buildTool || (workspacePath ? await this.detectBuildTool(workspacePath) : null);
    if (!detected && logger) {
      logger.appendLine('BuildToolService: WARNING — neither Gradle nor Maven detected, defaulting to Gradle');
      showWarningStatus('No Gradle or Maven project detected in the workspace. Defaulting to Gradle.');
    }
    const detectedTool: BuildTool = detected || 'gradle';

    if (detectedTool === 'maven') {
      const mavenOptions: MavenBatchCommandOptions = {
        workspacePath,
        logger,
        mavenModuleName: subprojectPrefix,
        coverage,
        debugPort,
        testDescriptors,
      };
      return buildMavenBatchCommandArgs(testFilters, debug, mavenOptions);
    }
    return buildGradleBatchCommandArgs(testFilters, debug, workspacePath, logger, subprojectPrefix, { coverage, debugPort, classTestCounts, testDescriptors });
  }

  static toSurefireFilter(testName: string): string {
    return toSurefireFilter(testName);
  }

  static buildSurefireBatchFilter(testFilters: string[]): string {
    return buildSurefireBatchFilter(testFilters);
  }

  static buildSurefireBatchFilterFromDescriptors(testDescriptors: TestDescriptor[]): string {
    return buildSurefireBatchFilterFromDescriptors(testDescriptors);
  }

  static escapeMethodForSurefire(methodName: string): string {
    return escapeMethodForSurefire(methodName);
  }

  static coalesceGradleFilters(
    testFilters: string[],
    classTestCounts?: Map<string, number>,
    logger?: vscode.OutputChannel,
    testDescriptors?: TestDescriptor[],
  ): string[] {
    return coalesceGradleFilters(testFilters, classTestCounts, logger, testDescriptors);
  }

  static estimateGradleArgsLength(baseArgs: string[], testFilters: string[]): number {
    return estimateGradleArgsLength(baseArgs, testFilters);
  }

  static getMaxCommandLineLength(): number {
    return getMaxCommandLineLength();
  }

  static splitGradleTestFilters(testFilters: string[], baseArgs: string[], maxLen?: number): string[][] {
    return splitGradleTestFilters(testFilters, baseArgs, maxLen);
  }

  static async getCoverageInitScriptPath(): Promise<string> {
    return getCoverageInitScriptPath();
  }

  static getTestResultsDir(projectRoot: string, buildTool: BuildTool): string {
    return getTestResultsDir(projectRoot, buildTool);
  }

  async detectBuildTool(workspacePath: string): Promise<BuildTool | null> {
    return BuildToolService.detectBuildTool(workspacePath);
  }
  async findProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null> {
    return BuildToolService.findProjectRoot(filePath, workspaceRoot);
  }
  async findRootProject(projectPath: string, workspaceRoot: string): Promise<string> {
    return BuildToolService.findRootProject(projectPath, workspaceRoot);
  }
  async getProjectName(workspacePath: string): Promise<string> {
    return BuildToolService.getProjectName(workspacePath);
  }
  async getSubprojectPrefix(rootProject: string, subprojectPath: string): Promise<string> {
    return BuildToolService.resolveSubprojectPrefix(rootProject, subprojectPath);
  }
  getMavenModuleName(rootProject: string, submodulePath: string): string {
    return BuildToolService.getMavenModuleName(rootProject, submodulePath);
  }
  async buildCommandArgs(testName: string, debug: boolean, workspacePath?: string, logger?: vscode.OutputChannel, subprojectPrefix?: string, buildTool?: BuildTool, debugPort?: number): Promise<string[]> {
    return BuildToolService.buildCommandArgs(testName, debug, workspacePath, logger, subprojectPrefix, buildTool, debugPort);
  }
  async buildBatchCommandArgs(testFilters: string[], debug: boolean, workspacePath?: string, logger?: vscode.OutputChannel, subprojectPrefix?: string, options: BatchCommandOptions = {}): Promise<string[]> {
    return BuildToolService.buildBatchCommandArgs(testFilters, debug, workspacePath, logger, subprojectPrefix, options);
  }
  getTestResultsDir(projectRoot: string, buildTool: BuildTool): string {
    return BuildToolService.getTestResultsDir(projectRoot, buildTool);
  }
}
