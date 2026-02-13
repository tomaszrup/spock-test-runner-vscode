import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { BuildTool } from '../types';
import { ConfigurationService } from './ConfigurationService';

const fsp = fs.promises;

/**
 * Async helper replacing fs.existsSync — resolves to true when the path is
 * accessible, false otherwise.
 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ── Security utilities ─────────────────────────────────────────────

/**
 * Shell-escape a single argument for safe inclusion in a command line.
 *
 * - **Windows (cmd.exe):** wraps in double quotes, escapes internal `"`
 *   as `\"`, `%` as `%%`, and `!` as `^^!` (delayed-expansion safe).
 * - **Unix:** wraps in single quotes, escaping embedded `'` as `'\''`.
 *
 * This replaces the previous inline `quote()` lambdas that only handled
 * spaces and were vulnerable to shell-metacharacter injection.
 */
export function shellEscape(s: string): string {
  if (process.platform === 'win32') {
    // Strip characters that cannot safely travel through cmd.exe
    let safe = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    // Remove \r and \n to prevent command splitting
    safe = safe.replace(/[\r\n]/g, '');
    // Escape double quotes for the C runtime argv parser
    safe = safe.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    // Escape cmd.exe env-var expansion and delayed-expansion
    safe = safe.replace(/%/g, '%%');
    safe = safe.replace(/!/g, '^^!');
    return `"${safe}"`;
  }
  // Unix: single-quote, escaping embedded single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Sanitize a test filter name before it reaches command construction.
 * Strips null bytes and ASCII control characters (defence-in-depth).
 */
export function sanitizeTestFilter(name: string, logger?: vscode.OutputChannel): string {
  const cleaned = name.replace(/[\x00-\x1f]/g, (ch) => {
    if (ch === ' ' || ch === '\t') { return ch; } // keep normal whitespace
    return '';
  });
  if (cleaned !== name && logger) {
    logger.appendLine(`BuildToolService: WARNING — control characters stripped from test filter: ${JSON.stringify(name)}`);
  }
  return cleaned;
}

/** Patterns that are blocked in user-supplied extra CLI arguments. */
const BLOCKED_GRADLE_ARG_PATTERNS = [
  /^--init-script$/i,
  /^-I$/,
  /^--file$/i,
  /^-f$/,
  /^--project-dir$/i,
  /^-p$/,
  /^--settings-file$/i,
  /^-c$/,
];

const BLOCKED_MAVEN_ARG_PATTERNS = [
  /^-f$/,
  /^--file$/i,
  /^-s$/,
  /^--settings$/i,
  /^--global-settings$/i,
  /^-gs$/,
];

/**
 * Validate user-supplied extra CLI arguments, rejecting known-dangerous
 * flags and arguments containing control characters or newlines.
 */
export function validateExtraArgs(
  args: string[],
  tool: 'gradle' | 'maven',
  logger?: vscode.OutputChannel,
): string[] {
  const blocked = tool === 'gradle' ? BLOCKED_GRADLE_ARG_PATTERNS : BLOCKED_MAVEN_ARG_PATTERNS;
  const safe: string[] = [];
  let skipNext = false;

  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      // This is the value following a blocked flag — skip it too
      if (logger) {
        logger.appendLine(`BuildToolService: WARNING — rejected additional arg (value of blocked flag): ${JSON.stringify(args[i])}`);
      }
      skipNext = false;
      continue;
    }

    const arg = args[i];

    // Reject args with control characters / newlines
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\r\n]/.test(arg)) {
      if (logger) {
        logger.appendLine(`BuildToolService: WARNING — rejected additional arg containing control characters: ${JSON.stringify(arg)}`);
      }
      continue;
    }

    // Check blocked patterns
    if (blocked.some(re => re.test(arg))) {
      if (logger) {
        logger.appendLine(`BuildToolService: WARNING — rejected blocked additional arg: ${JSON.stringify(arg)}`);
      }
      // If this flag takes a value (next arg), skip that too
      skipNext = true;
      continue;
    }

    safe.push(arg);
  }

  return safe;
}

/**
 * Interface for build-tool operations — enables mocking in tests.
 */
export interface IBuildToolService {
  detectBuildTool(workspacePath: string): Promise<BuildTool | null>;
  findProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null>;
  findRootProject(projectPath: string, workspaceRoot: string): Promise<string>;
  getProjectName(workspacePath: string): Promise<string>;
  getSubprojectPrefix(rootProject: string, subprojectPath: string): string;
  getMavenModuleName(rootProject: string, submodulePath: string): string;
  buildCommandArgs(testName: string, debug: boolean, workspacePath?: string, logger?: vscode.OutputChannel, subprojectPrefix?: string, buildTool?: BuildTool, debugPort?: number): Promise<string[]>;
  buildBatchCommandArgs(testFilters: string[], debug: boolean, workspacePath?: string, logger?: vscode.OutputChannel, subprojectPrefix?: string, coverage?: boolean, buildTool?: BuildTool, debugPort?: number, classTestCounts?: Map<string, number>): Promise<string[]>;
  getTestResultsDir(projectRoot: string, buildTool: BuildTool): string;
}

export class BuildToolService {
  /**
   * Detect the build tool at a given directory path.
   * Supports Gradle (build.gradle / build.gradle.kts) and Maven (pom.xml).
   * Gradle is checked first for backward compatibility.
   */
  static async detectBuildTool(workspacePath: string): Promise<BuildTool | null> {
    if (await this.isGradleProject(workspacePath)) {
      return 'gradle';
    }
    if (await this.isMavenProject(workspacePath)) {
      return 'maven';
    }
    return null;
  }

  // ── Generic project detection ──────────────────────────────────────

  /**
   * Find the nearest project root (Gradle or Maven) by walking up from a file path.
   * Checks Gradle first, then Maven, stopping at the workspace root boundary.
   */
  static async findProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null> {
    return await this.findGradleProjectRoot(filePath, workspaceRoot)
        || await this.findMavenProjectRoot(filePath, workspaceRoot);
  }

  /**
   * Find the root project (Gradle settings or Maven parent pom) by walking up
   * from a (sub)project directory.  Delegates to the appropriate build-tool
   * method based on what is detected at {@link projectPath}.
   */
  static async findRootProject(projectPath: string, workspaceRoot: string): Promise<string> {
    if (await this.isGradleProject(projectPath)) {
      return this.findGradleRootProject(projectPath, workspaceRoot);
    }
    if (await this.isMavenProject(projectPath)) {
      return this.findMavenRootProject(projectPath, workspaceRoot);
    }
    return projectPath;
  }

  // ── Gradle-specific ────────────────────────────────────────────────

  /**
   * Find the nearest Gradle project root by walking up from a file path.
   * Searches for build.gradle or build.gradle.kts in each parent directory,
   * stopping at the workspace root boundary.
   * 
   * This supports multi-level project layouts where the Gradle project
   * may be in a subdirectory of the VS Code workspace.
   * 
   * @param filePath - The path to start searching from (typically a test file)
   * @param workspaceRoot - The VS Code workspace root (search boundary)
   * @returns The Gradle project root directory, or null if not found
   */
  static async findGradleProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null> {
    let currentDir: string;
    try {
      const stat = await fsp.stat(filePath);
      currentDir = stat.isDirectory() ? filePath : path.dirname(filePath);
    } catch {
      currentDir = path.dirname(filePath);
    }

    const normalizedRoot = path.resolve(workspaceRoot);

    while (true) {
      const normalizedCurrent = path.resolve(currentDir);

      if (await this.isGradleProject(currentDir)) {
        return currentDir;
      }

      // Stop after checking the workspace root
      if (normalizedCurrent === normalizedRoot) {
        break;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // Filesystem root
      }

      currentDir = parentDir;
    }

    return null;
  }

  /**
   * Check if a directory contains a Gradle build file.
   */
  static async isGradleProject(dir: string): Promise<boolean> {
    return await fileExists(path.join(dir, 'build.gradle')) ||
           await fileExists(path.join(dir, 'build.gradle.kts'));
  }

  /**
   * Find the Gradle root project by walking up from a (sub)project directory.
   * The root project is identified by the presence of settings.gradle or
   * settings.gradle.kts.  If no settings file is found within the workspace
   * boundary, the original project path is returned (standalone project).
   *
   * @param projectPath  - The subproject (or root) directory
   * @param workspaceRoot - VS Code workspace root (search boundary)
   * @returns The Gradle root project directory
   */
  static async findGradleRootProject(projectPath: string, workspaceRoot: string): Promise<string> {
    let currentDir = projectPath;
    const normalizedRoot = path.resolve(workspaceRoot);

    while (true) {
      const normalizedCurrent = path.resolve(currentDir);

      if (await fileExists(path.join(currentDir, 'settings.gradle')) ||
          await fileExists(path.join(currentDir, 'settings.gradle.kts'))) {
        return currentDir;
      }

      // Stop after checking the workspace root
      if (normalizedCurrent === normalizedRoot) {
        break;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // Filesystem root
      }
      currentDir = parentDir;
    }

    // No settings file found; treat the original path as the root
    return projectPath;
  }

  /**
   * Compute the Gradle subproject task prefix for a subproject directory
   * relative to the root project.  Returns an empty string when the
   * subproject IS the root project.
   *
   * Example: root="/ws", sub="/ws/moduleA"       → ":moduleA"
   * Example: root="/ws", sub="/ws/parent/child"   → ":parent:child"
   */
  static getSubprojectPrefix(rootProject: string, subprojectPath: string): string {
    const normalizedRoot = path.resolve(rootProject);
    const normalizedSub  = path.resolve(subprojectPath);

    if (normalizedRoot === normalizedSub) {
      return ''; // Root project itself, no prefix needed
    }

    const relativePath = path.relative(normalizedRoot, normalizedSub);
    // Convert OS path separators to Gradle colon notation
    const gradlePath = relativePath.split(path.sep).join(':');
    return `:${gradlePath}`;
  }

  /**
   * Check if a Gradle wrapper exists at the given path or in any parent directory
   * up to (and including) the workspace root.
   */
  static async hasGradleWrapper(workspacePath: string, workspaceRoot?: string): Promise<boolean> {
    let currentDir = workspacePath;
    const boundary = workspaceRoot ? path.resolve(workspaceRoot) : undefined;
    
    while (true) {
      if (await fileExists(path.join(currentDir, 'gradlew')) ||
          await fileExists(path.join(currentDir, 'gradlew.bat'))) {
        return true;
      }
      
      const normalizedCurrent = path.resolve(currentDir);
      if (boundary && normalizedCurrent === boundary) {
        break; // Reached workspace root
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // Filesystem root
      }
      currentDir = parentDir;
    }
    
    return false;
  }

  // ── Maven-specific ─────────────────────────────────────────────────

  /**
   * Check if a directory contains a Maven pom.xml.
   */
  static async isMavenProject(dir: string): Promise<boolean> {
    return fileExists(path.join(dir, 'pom.xml'));
  }

  /**
   * Find the nearest Maven project root by walking up from a file path.
   * Searches for pom.xml in each parent directory, stopping at the
   * workspace root boundary.
   */
  static async findMavenProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null> {
    let currentDir: string;
    try {
      const stat = await fsp.stat(filePath);
      currentDir = stat.isDirectory() ? filePath : path.dirname(filePath);
    } catch {
      currentDir = path.dirname(filePath);
    }

    const normalizedRoot = path.resolve(workspaceRoot);

    while (true) {
      const normalizedCurrent = path.resolve(currentDir);

      if (await this.isMavenProject(currentDir)) {
        return currentDir;
      }

      if (normalizedCurrent === normalizedRoot) {
        break;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    return null;
  }

  /**
   * Find the Maven root project by walking up from a (sub)module directory.
   * A root project is identified as the highest pom.xml that contains
   * a {@code <modules>} section (multi-module reactor) within the workspace
   * boundary.  If no such parent is found the original path is returned.
   */
  static async findMavenRootProject(projectPath: string, workspaceRoot: string): Promise<string> {
    let currentDir = projectPath;
    const normalizedRoot = path.resolve(workspaceRoot);
    let bestCandidate = projectPath;

    while (true) {
      const normalizedCurrent = path.resolve(currentDir);

      if (await this.isMavenProject(currentDir)) {
        try {
          const pomContent = await fsp.readFile(path.join(currentDir, 'pom.xml'), 'utf8');
          if (/<modules\s*>/.test(pomContent)) {
            bestCandidate = currentDir;
          }
        } catch {
          // Ignore read errors
        }
      }

      if (normalizedCurrent === normalizedRoot) {
        break;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return bestCandidate;
  }

  /**
   * Compute the Maven module argument(s) for a sub-module directory
   * relative to the root project.  Returns an empty string when the
   * sub-module IS the root project.
   *
   * Example: root="/ws", sub="/ws/moduleA"       → "moduleA"
   * Example: root="/ws", sub="/ws/parent/child"   → "parent/child"
   */
  static getMavenModuleName(rootProject: string, submodulePath: string): string {
    const normalizedRoot = path.resolve(rootProject);
    const normalizedSub  = path.resolve(submodulePath);

    if (normalizedRoot === normalizedSub) {
      return '';
    }

    const relativePath = path.relative(normalizedRoot, normalizedSub);
    // Maven uses forward slash for module path regardless of OS
    return relativePath.split(path.sep).join('/');
  }

  /**
   * Check if a Maven wrapper exists at the given path or in any parent directory
   * up to (and including) the workspace root.
   */
  static async hasMavenWrapper(workspacePath: string, workspaceRoot?: string): Promise<boolean> {
    let currentDir = workspacePath;
    const boundary = workspaceRoot ? path.resolve(workspaceRoot) : undefined;

    while (true) {
      if (await fileExists(path.join(currentDir, 'mvnw')) ||
          await fileExists(path.join(currentDir, 'mvnw.cmd'))) {
        return true;
      }

      const normalizedCurrent = path.resolve(currentDir);
      if (boundary && normalizedCurrent === boundary) {
        break; // Reached workspace root
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return false;
  }

  // ── Project name ───────────────────────────────────────────────────

  static async getProjectName(workspacePath: string): Promise<string> {
    // Try settings.gradle / settings.gradle.kts first (canonical location for rootProject.name)
    try {
      const settingsPath = path.join(workspacePath, 'settings.gradle');
      const settingsKtsPath = path.join(workspacePath, 'settings.gradle.kts');
      const actualSettingsPath = await fileExists(settingsPath) ? settingsPath : settingsKtsPath;

      if (await fileExists(actualSettingsPath)) {
        const settingsContent = await fsp.readFile(actualSettingsPath, 'utf8');
        const nameMatch = settingsContent.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
        if (nameMatch) {
          return nameMatch[1];
        }
      }
    } catch (error) {
      // Fallback below
    }

    // Try build.gradle / build.gradle.kts
    try {
      const gradlePath = path.join(workspacePath, 'build.gradle');
      const ktsPath = path.join(workspacePath, 'build.gradle.kts');
      const actualPath = await fileExists(gradlePath) ? gradlePath : ktsPath;
      
      if (await fileExists(actualPath)) {
          const gradleContent = await fsp.readFile(actualPath, 'utf8');
          const nameMatch = gradleContent.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/) || 
          gradleContent.match(/name\s*=\s*['"]([^'"]+)['"]/);
          if (nameMatch) {
              return nameMatch[1];
            }
        }
    } catch (error) {
      // Fallback below
    }
    
    // Try Maven
    try {
      const pomPath = path.join(workspacePath, 'pom.xml');
      if (await fileExists(pomPath)) {
        const pomContent = await fsp.readFile(pomPath, 'utf8');
        // Strip the <parent>…</parent> block so we don't accidentally
        // match <name> or <artifactId> from the parent declaration.
        const withoutParent = pomContent.replace(/<parent>[\s\S]*?<\/parent>/g, '');
        const nameMatch = withoutParent.match(/<name>([^<]+)<\/name>/);
        if (nameMatch) {
          return nameMatch[1].trim();
        }
        // Fallback to artifactId (also outside <parent>)
        const artifactMatch = withoutParent.match(/<artifactId>([^<]+)<\/artifactId>/);
        if (artifactMatch) {
          return artifactMatch[1].trim();
        }
      }
    } catch (error) {
      // Fallback below
    }

    return path.basename(workspacePath);
  }

  // ── Command building ───────────────────────────────────────────────

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
      void vscode.window.showWarningMessage(
        'Spock Test Runner: No Gradle or Maven project detected in the workspace. Defaulting to Gradle.'
      );
    }
    const detectedTool: BuildTool = detected || 'gradle';

    if (detectedTool === 'maven') {
      return this.buildMavenCommandArgs(testName, debug, workspacePath, logger, subprojectPrefix, debugPort);
    }
    return this.buildGradleCommandArgs(testName, debug, workspacePath, logger, subprojectPrefix, debugPort);
  }

  static async buildBatchCommandArgs(
    testFilters: string[],
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    subprojectPrefix?: string,
    coverage: boolean = false,
    buildTool?: BuildTool,
    debugPort?: number,
    classTestCounts?: Map<string, number>
  ): Promise<string[]> {
    const detected = buildTool || (workspacePath ? await this.detectBuildTool(workspacePath) : null);
    if (!detected && logger) {
      logger.appendLine('BuildToolService: WARNING — neither Gradle nor Maven detected, defaulting to Gradle');
      void vscode.window.showWarningMessage(
        'Spock Test Runner: No Gradle or Maven project detected in the workspace. Defaulting to Gradle.'
      );
    }
    const detectedTool: BuildTool = detected || 'gradle';

    if (detectedTool === 'maven') {
      return this.buildMavenBatchCommandArgs(testFilters, debug, workspacePath, logger, subprojectPrefix, coverage, debugPort);
    }
    return this.buildGradleBatchCommandArgs(testFilters, debug, workspacePath, logger, subprojectPrefix, coverage, debugPort, classTestCounts);
  }

  // ── Gradle command building ────────────────────────────────────────

  private static async buildGradleCommandArgs(
    testName: string,
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    subprojectPrefix?: string,
    debugPort?: number
  ): Promise<string[]> {
    const sanitized = sanitizeTestFilter(testName, logger);
    const escapedTestName = shellEscape(sanitized);
    
    let gradleCommand: string;
    const wsRoot = workspacePath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspacePath))?.uri.fsPath : undefined;
    if (workspacePath && await this.hasGradleWrapper(workspacePath, wsRoot)) {
      gradleCommand = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    } else {
      gradleCommand = 'gradle';
    }
    const taskName = subprojectPrefix ? `${subprojectPrefix}:test` : 'test';
    const baseArgs = [gradleCommand, taskName, '--tests', escapedTestName, '--stacktrace'];
    
    const initScriptPath = shellEscape(await this.getInitScriptPath());
    const initScriptArgs = ['--init-script', initScriptPath];
    
    if (logger) {
      logger.appendLine(`BuildToolService: Using Gradle init script to force test execution (--init-script)`);
    }
    
    const extraArgs = validateExtraArgs(ConfigurationService.getConfig().additionalGradleArgs, 'gradle', logger);

    if (debug) {
      const port = debugPort ?? ConfigurationService.getConfig().debugPort;
      const jvmDebugArg = `-Dorg.gradle.jvmargs=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:${port}`;
      return [...baseArgs, '--debug-jvm', jvmDebugArg, ...initScriptArgs, ...extraArgs];
    } else {
      return [...baseArgs, ...initScriptArgs, ...extraArgs];
    }
  }

  private static async buildGradleBatchCommandArgs(
    testFilters: string[],
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    subprojectPrefix?: string,
    coverage: boolean = false,
    debugPort?: number,
    classTestCounts?: Map<string, number>
  ): Promise<string[]> {
    let gradleCommand: string;
    const wsRoot = workspacePath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspacePath))?.uri.fsPath : undefined;
    if (workspacePath && await this.hasGradleWrapper(workspacePath, wsRoot)) {
      gradleCommand = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    } else {
      gradleCommand = 'gradle';
    }

    const taskName = subprojectPrefix ? `${subprojectPrefix}:test` : 'test';
    const args = [gradleCommand, taskName];
    const coalesced = this.coalesceGradleFilters(testFilters, classTestCounts, logger);
    for (const filter of coalesced) {
      args.push('--tests', shellEscape(sanitizeTestFilter(filter, logger)));
    }

    args.push('--stacktrace');

    const initScriptPath = coverage
      ? shellEscape(await this.getCoverageInitScriptPath())
      : shellEscape(await this.getInitScriptPath());
    args.push('--init-script', initScriptPath);

    if (logger) {
      logger.appendLine(`BuildToolService: Batch execution with ${testFilters.length} test filter(s)${coverage ? ' (with coverage)' : ''}`);
    }

    if (debug) {
      const cfg = ConfigurationService.getConfig();
      const port = debugPort ?? cfg.debugPort;
      args.push('--debug-jvm');
      args.push(`-Dorg.gradle.jvmargs=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:${port}`);
    }

    const extraArgs = validateExtraArgs(ConfigurationService.getConfig().additionalGradleArgs, 'gradle', logger);
    args.push(...extraArgs);

    return args;
  }

  // ── Maven command building ─────────────────────────────────────────

  /**
   * Build Maven command args for running a single test.
   * Uses Surefire's {@code -Dtest} filter.
   *
   * @param testName  Fully qualified "ClassName.methodName"
   */
  private static async buildMavenCommandArgs(
    testName: string,
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    mavenModuleName?: string,
    debugPort?: number
  ): Promise<string[]> {
    const sanitized = sanitizeTestFilter(testName, logger);
    const mvnCommand = await this.getMavenCommand(workspacePath);

    // Convert "ClassName.methodName" to Surefire filter "ClassName#methodName"
    const surefireFilter = this.toSurefireFilter(sanitized);

    const args = [mvnCommand, 'test', `-Dtest=${shellEscape(surefireFilter)}`, '-Dsurefire.useFile=true',
      '-Dsurefire.failIfNoSpecifiedTests=false'];

    // For multi-module: run only in the target module
    if (mavenModuleName) {
      args.push('-pl', mavenModuleName, '-am');
    }

    if (debug) {
      const port = debugPort ?? ConfigurationService.getConfig().debugPort;
      args.push(`-Dmaven.surefire.debug=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:${port}`);
    }

    if (logger) {
      logger.appendLine(`BuildToolService: Using Maven Surefire to execute test`);
    }

    const extraArgs = validateExtraArgs(ConfigurationService.getConfig().additionalMavenArgs, 'maven', logger);
    args.push(...extraArgs);

    return args;
  }

  /**
   * Build Maven command args for running a batch of tests.
   */
  private static async buildMavenBatchCommandArgs(
    testFilters: string[],
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    mavenModuleName?: string,
    coverage: boolean = false,
    debugPort?: number
  ): Promise<string[]> {
    const mvnCommand = await this.getMavenCommand(workspacePath);

    // Group filters by class for Surefire: "Class1#m1+m2,Class2#m3"
    const sanitizedFilters = testFilters.map(f => sanitizeTestFilter(f, logger));
    const surefireFilter = this.buildSurefireBatchFilter(sanitizedFilters);

    const args = [mvnCommand, 'test', `-Dtest=${shellEscape(surefireFilter)}`, '-Dsurefire.useFile=true',
      '-Dsurefire.failIfNoSpecifiedTests=false'];

    if (mavenModuleName) {
      args.push('-pl', mavenModuleName, '-am');
    }

    if (coverage) {
      // Use JaCoCo Maven plugin goals inline (works without pom.xml configuration)
      args.splice(1, 0, 'org.jacoco:jacoco-maven-plugin:prepare-agent');
      args.push('org.jacoco:jacoco-maven-plugin:report');
    }

    if (debug) {
      const port = debugPort ?? ConfigurationService.getConfig().debugPort;
      args.push(`-Dmaven.surefire.debug=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:${port}`);
    }

    if (logger) {
      logger.appendLine(`BuildToolService: Maven batch execution with ${testFilters.length} test filter(s)${coverage ? ' (with coverage)' : ''}`);
    }

    const extraArgs = validateExtraArgs(ConfigurationService.getConfig().additionalMavenArgs, 'maven', logger);
    args.push(...extraArgs);

    return args;
  }

  /**
   * Get the Maven command, preferring the wrapper if available.
   */
  private static async getMavenCommand(workspacePath?: string): Promise<string> {
    const isWindows = process.platform === 'win32';
    const wsRoot = workspacePath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspacePath))?.uri.fsPath : undefined;
    if (workspacePath && await this.hasMavenWrapper(workspacePath, wsRoot)) {
      return isWindows ? 'mvnw.cmd' : './mvnw';
    }
    return 'mvn';
  }

  /**
   * Convert a Gradle-style test filter ("ClassName.methodName") to
   * Surefire's format ("ClassName#methodName").
   */
  static toSurefireFilter(testName: string): string {
    // "com.example.MySpec.test name" → "com.example.MySpec#test name"
    // The last dot before a lowercase/space segment separates class from method
    const lastDot = testName.lastIndexOf('.');
    if (lastDot > 0) {
      const className = testName.substring(0, lastDot);
      const methodName = testName.substring(lastDot + 1);
      return className + '#' + this.escapeMethodForSurefire(methodName);
    }
    return testName;
  }

  /**
   * Build a combined Surefire -Dtest filter for multiple tests.
   * Groups methods by class: "Class1#m1+m2,Class2#m3"
   *
   * Method names are escaped via {@link escapeMethodForSurefire} so that
   * characters with structural meaning in Surefire (`+`, `,`) don't break
   * the filter syntax.
   */
  static buildSurefireBatchFilter(testFilters: string[]): string {
    const classMap = new Map<string, string[]>();
    for (const filter of testFilters) {
      const lastDot = filter.lastIndexOf('.');
      if (lastDot > 0) {
        const className = filter.substring(0, lastDot);
        const methodName = filter.substring(lastDot + 1);
        if (!classMap.has(className)) {
          classMap.set(className, []);
        }
        classMap.get(className)!.push(this.escapeMethodForSurefire(methodName));
      } else {
        // No dot — treat as class-only filter
        if (!classMap.has(filter)) {
          classMap.set(filter, []);
        }
      }
    }

    const parts: string[] = [];
    for (const [className, methods] of classMap) {
      if (methods.length === 0) {
        parts.push(className);
      } else {
        parts.push(`${className}#${methods.join('+')}`);
      }
    }

    return parts.join(',');
  }

  /**
   * Escape a Spock method/display name for use in Surefire's `-Dtest` filter.
   *
   * Surefire uses structural separators that cannot be escaped:
   *   `+`  — separates method names within a class
   *   `,`  — separates class entries
   *
   * After splitting on those separators, each method pattern is treated as a
   * regex.  We therefore:
   *   1. Replace `+` and `,` with regex-any-char (`.`).
   *   2. Escape other regex-special characters so the rest matches literally.
   */
  static escapeMethodForSurefire(methodName: string): string {
    // Step 1: Replace Surefire structural separators with unique placeholders
    let result = methodName
      .replace(/\+/g, '\x00P')
      .replace(/,/g, '\x00C');

    // Step 2: Escape regex-special characters (NOT + and , — already replaced)
    result = result.replace(/[.*?()\[\]{}^$|\\]/g, '\\$&');

    // Step 3: Replace placeholders with '.' (regex any-char)
    result = result
      .replace(/\x00P/g, '.')
      .replace(/\x00C/g, '.');

    return result;
  }

  // ── Command-line length management ─────────────────────────────────

  /**
   * Coalesce individual Gradle test filters into class-level wildcards.
   *
   * When every known test method of a class is present in the filter list,
   * replaces all `ClassName.method1`, `ClassName.method2`, … with a single
   * `ClassName.*`.  This dramatically reduces the number of `--tests` args.
   *
   * @param testFilters  Original filters in `ClassName.methodName` format.
   * @param classTestCounts  Optional map of `className → total method count`
   *   from the full test tree.  When provided, wildcard coalescing only
   *   happens if *all* methods of the class are selected.  When absent,
   *   coalescing is skipped (conservative).
   * @returns The (potentially shorter) filter list.
   */
  static coalesceGradleFilters(
    testFilters: string[],
    classTestCounts?: Map<string, number>,
    logger?: vscode.OutputChannel,
  ): string[] {
    if (!classTestCounts || classTestCounts.size === 0) {
      return testFilters;
    }

    // Group selected filters by class name
    const selectedByClass = new Map<string, string[]>();
    for (const filter of testFilters) {
      const dotIdx = filter.indexOf('.');
      if (dotIdx > 0) {
        const className = filter.substring(0, dotIdx);
        if (!selectedByClass.has(className)) {
          selectedByClass.set(className, []);
        }
        selectedByClass.get(className)!.push(filter);
      }
    }

    const result: string[] = [];
    const coalescedClasses = new Set<string>();

    for (const [className, filters] of selectedByClass) {
      const totalMethods = classTestCounts.get(className);
      if (totalMethods !== undefined && filters.length >= totalMethods) {
        // All methods of this class are selected → use wildcard
        result.push(`${className}.*`);
        coalescedClasses.add(className);
      } else {
        // Only some methods selected → keep individual filters
        result.push(...filters);
      }
    }

    if (coalescedClasses.size > 0 && logger) {
      logger.appendLine(`BuildToolService: Coalesced ${coalescedClasses.size} class(es) to wildcard filters (reduced ${testFilters.length} → ${result.length} filters)`);
    }

    return result;
  }

  /**
   * Estimate the total command-line length (in characters) for a set of
   * Gradle `--tests` arguments.  Used to decide whether sub-batching is
   * required.
   */
  static estimateGradleArgsLength(baseArgs: string[], testFilters: string[]): number {
    // base command + spaces
    let len = baseArgs.join(' ').length;
    for (const filter of testFilters) {
      // " --tests " + shellEscape(filter)
      len += ' --tests '.length + shellEscape(sanitizeTestFilter(filter)).length;
    }
    return len;
  }

  /**
   * Maximum safe command-line length per platform.
   * Windows cmd.exe: 8191 chars; other OSes: 128 KB (conservative).
   */
  static getMaxCommandLineLength(): number {
    return process.platform === 'win32' ? 7500 : 120_000;
  }

  /**
   * Split test filters into sub-batches so that each batch's estimated
   * command-line length stays below the OS limit.
   *
   * @param testFilters  Full list of Gradle test filters.
   * @param baseArgs     The command args *without* `--tests` entries
   *                     (e.g. `['gradlew.bat', 'test', '--stacktrace', ...]`).
   * @param maxLen       Maximum allowed command-line length.
   * @returns Array of filter sub-arrays.  If everything fits, returns a
   *          single-element array containing the original filters.
   */
  static splitGradleTestFilters(
    testFilters: string[],
    baseArgs: string[],
    maxLen?: number,
  ): string[][] {
    const limit = maxLen ?? this.getMaxCommandLineLength();
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

  // ── Shared / init scripts ──────────────────────────────────────────

  private static async getInitScriptPath(): Promise<string> {
    const initScriptPath = path.join(__dirname, '..', '..', 'resources', 'force-tests.init.gradle');
    
    if (!await fileExists(initScriptPath)) {
      throw new Error(`Init script not found at: ${initScriptPath}`);
    }           
    
    return initScriptPath;
  }

  /**
   * Path to the coverage init script that applies JaCoCo and forces tests.
   */
  static async getCoverageInitScriptPath(): Promise<string> {
    const initScriptPath = path.join(__dirname, '..', '..', 'resources', 'coverage.init.gradle');
    if (!await fileExists(initScriptPath)) {
      throw new Error(`Coverage init script not found at: ${initScriptPath}`);
    }
    return initScriptPath;
  }

  /**
   * Return the directory where JUnit XML test reports are written.
   * Gradle: build/test-results/test
   * Maven:  target/surefire-reports
   */
  static getTestResultsDir(projectRoot: string, buildTool: BuildTool): string {
    if (buildTool === 'maven') {
      return path.join(projectRoot, 'target', 'surefire-reports');
    }
    return path.join(projectRoot, 'build', 'test-results', 'test');
  }

  // ── Instance methods (delegate to static — for DI / mocking) ───────

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
  getSubprojectPrefix(rootProject: string, subprojectPath: string): string {
    return BuildToolService.getSubprojectPrefix(rootProject, subprojectPath);
  }
  getMavenModuleName(rootProject: string, submodulePath: string): string {
    return BuildToolService.getMavenModuleName(rootProject, submodulePath);
  }
  async buildCommandArgs(testName: string, debug: boolean, workspacePath?: string, logger?: vscode.OutputChannel, subprojectPrefix?: string, buildTool?: BuildTool, debugPort?: number): Promise<string[]> {
    return BuildToolService.buildCommandArgs(testName, debug, workspacePath, logger, subprojectPrefix, buildTool, debugPort);
  }
  async buildBatchCommandArgs(testFilters: string[], debug: boolean, workspacePath?: string, logger?: vscode.OutputChannel, subprojectPrefix?: string, coverage: boolean = false, buildTool?: BuildTool, debugPort?: number, classTestCounts?: Map<string, number>): Promise<string[]> {
    return BuildToolService.buildBatchCommandArgs(testFilters, debug, workspacePath, logger, subprojectPrefix, coverage, buildTool, debugPort, classTestCounts);
  }
  getTestResultsDir(projectRoot: string, buildTool: BuildTool): string {
    return BuildToolService.getTestResultsDir(projectRoot, buildTool);
  }
}
