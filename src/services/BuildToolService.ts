import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { BuildTool } from '../types';
import { ConfigurationService } from './ConfigurationService';

export class BuildToolService {
  /**
   * Detect the build tool at a given directory path.
   * Supports Gradle (build.gradle / build.gradle.kts) and Maven (pom.xml).
   * Gradle is checked first for backward compatibility.
   */
  static detectBuildTool(workspacePath: string): BuildTool | null {
    if (this.isGradleProject(workspacePath)) {
      return 'gradle';
    }
    if (this.isMavenProject(workspacePath)) {
      return 'maven';
    }
    return null;
  }

  // ── Generic project detection ──────────────────────────────────────

  /**
   * Find the nearest project root (Gradle or Maven) by walking up from a file path.
   * Checks Gradle first, then Maven, stopping at the workspace root boundary.
   */
  static findProjectRoot(filePath: string, workspaceRoot: string): string | null {
    return this.findGradleProjectRoot(filePath, workspaceRoot)
        || this.findMavenProjectRoot(filePath, workspaceRoot);
  }

  /**
   * Find the root project (Gradle settings or Maven parent pom) by walking up
   * from a (sub)project directory.  Delegates to the appropriate build-tool
   * method based on what is detected at {@link projectPath}.
   */
  static findRootProject(projectPath: string, workspaceRoot: string): string {
    if (this.isGradleProject(projectPath)) {
      return this.findGradleRootProject(projectPath, workspaceRoot);
    }
    if (this.isMavenProject(projectPath)) {
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
  static findGradleProjectRoot(filePath: string, workspaceRoot: string): string | null {
    let currentDir: string;
    try {
      const stat = fs.statSync(filePath);
      currentDir = stat.isDirectory() ? filePath : path.dirname(filePath);
    } catch {
      currentDir = path.dirname(filePath);
    }

    const normalizedRoot = path.resolve(workspaceRoot);

    while (true) {
      const normalizedCurrent = path.resolve(currentDir);

      if (this.isGradleProject(currentDir)) {
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
  static isGradleProject(dir: string): boolean {
    return fs.existsSync(path.join(dir, 'build.gradle')) ||
           fs.existsSync(path.join(dir, 'build.gradle.kts'));
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
  static findGradleRootProject(projectPath: string, workspaceRoot: string): string {
    let currentDir = projectPath;
    const normalizedRoot = path.resolve(workspaceRoot);

    while (true) {
      const normalizedCurrent = path.resolve(currentDir);

      if (fs.existsSync(path.join(currentDir, 'settings.gradle')) ||
          fs.existsSync(path.join(currentDir, 'settings.gradle.kts'))) {
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
   * Check if a Gradle wrapper exists at the given path or in any parent directory.
   * This supports multi-level projects where gradlew is at the root project level.
   */
  static hasGradleWrapper(workspacePath: string): boolean {
    let currentDir = workspacePath;
    
    while (true) {
      if (fs.existsSync(path.join(currentDir, 'gradlew')) ||
          fs.existsSync(path.join(currentDir, 'gradlew.bat'))) {
        return true;
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
  static isMavenProject(dir: string): boolean {
    return fs.existsSync(path.join(dir, 'pom.xml'));
  }

  /**
   * Find the nearest Maven project root by walking up from a file path.
   * Searches for pom.xml in each parent directory, stopping at the
   * workspace root boundary.
   */
  static findMavenProjectRoot(filePath: string, workspaceRoot: string): string | null {
    let currentDir: string;
    try {
      const stat = fs.statSync(filePath);
      currentDir = stat.isDirectory() ? filePath : path.dirname(filePath);
    } catch {
      currentDir = path.dirname(filePath);
    }

    const normalizedRoot = path.resolve(workspaceRoot);

    while (true) {
      const normalizedCurrent = path.resolve(currentDir);

      if (this.isMavenProject(currentDir)) {
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
  static findMavenRootProject(projectPath: string, workspaceRoot: string): string {
    let currentDir = projectPath;
    const normalizedRoot = path.resolve(workspaceRoot);
    let bestCandidate = projectPath;

    while (true) {
      const normalizedCurrent = path.resolve(currentDir);

      if (this.isMavenProject(currentDir)) {
        try {
          const pomContent = fs.readFileSync(path.join(currentDir, 'pom.xml'), 'utf8');
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
   * Check if a Maven wrapper exists at the given path or in any parent directory.
   */
  static hasMavenWrapper(workspacePath: string): boolean {
    let currentDir = workspacePath;

    while (true) {
      if (fs.existsSync(path.join(currentDir, 'mvnw')) ||
          fs.existsSync(path.join(currentDir, 'mvnw.cmd'))) {
        return true;
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

  static getProjectName(workspacePath: string): string {
    // Try Gradle first
    try {
      const gradlePath = path.join(workspacePath, 'build.gradle');
      const ktsPath = path.join(workspacePath, 'build.gradle.kts');
      const actualPath = fs.existsSync(gradlePath) ? gradlePath : ktsPath;
      
      if (fs.existsSync(actualPath)) {
          const gradleContent = fs.readFileSync(actualPath, 'utf8');
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
      if (fs.existsSync(pomPath)) {
        const pomContent = fs.readFileSync(pomPath, 'utf8');
        // Match <name>...</name> that is NOT inside <parent>
        const nameMatch = pomContent.match(/<name>([^<]+)<\/name>/);
        if (nameMatch) {
          return nameMatch[1].trim();
        }
        // Fallback to artifactId
        const artifactMatch = pomContent.match(/<artifactId>([^<]+)<\/artifactId>/);
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

  static buildCommandArgs(
    testName: string, 
    debug: boolean, 
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    subprojectPrefix?: string,
    buildTool?: BuildTool
  ): string[] {
    const detectedTool = buildTool || (workspacePath ? this.detectBuildTool(workspacePath) : null) || 'gradle';

    if (detectedTool === 'maven') {
      return this.buildMavenCommandArgs(testName, debug, workspacePath, logger, subprojectPrefix);
    }
    return this.buildGradleCommandArgs(testName, debug, workspacePath, logger, subprojectPrefix);
  }

  static buildBatchCommandArgs(
    testFilters: string[],
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    subprojectPrefix?: string,
    coverage: boolean = false,
    buildTool?: BuildTool
  ): string[] {
    const detectedTool = buildTool || (workspacePath ? this.detectBuildTool(workspacePath) : null) || 'gradle';

    if (detectedTool === 'maven') {
      return this.buildMavenBatchCommandArgs(testFilters, debug, workspacePath, logger, subprojectPrefix, coverage);
    }
    return this.buildGradleBatchCommandArgs(testFilters, debug, workspacePath, logger, subprojectPrefix, coverage);
  }

  // ── Gradle command building ────────────────────────────────────────

  private static buildGradleCommandArgs(
    testName: string,
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    subprojectPrefix?: string
  ): string[] {
    const isWindows = process.platform === 'win32';
    const quote = (s: string) => isWindows && s.includes(' ') ? `"${s}"` : s;

    const escapedTestName = quote(testName);
    
    let gradleCommand: string;
    if (workspacePath && this.hasGradleWrapper(workspacePath)) {
      gradleCommand = isWindows ? 'gradlew.bat' : './gradlew';
    } else {
      gradleCommand = 'gradle';
    }
    const taskName = subprojectPrefix ? `${subprojectPrefix}:test` : 'test';
    const baseArgs = [gradleCommand, taskName, '--tests', escapedTestName, '--stacktrace'];
    
    const initScriptPath = quote(this.getInitScriptPath());
    const initScriptArgs = ['--init-script', initScriptPath];
    
    if (logger) {
      logger.appendLine(`BuildToolService: Using Gradle init script to force test execution (--init-script)`);
    }
    
    const extraArgs = ConfigurationService.getConfig().additionalGradleArgs;

    if (debug) {
      return [...baseArgs, '--debug-jvm', ...initScriptArgs, ...extraArgs];
    } else {
      return [...baseArgs, ...initScriptArgs, ...extraArgs];
    }
  }

  private static buildGradleBatchCommandArgs(
    testFilters: string[],
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    subprojectPrefix?: string,
    coverage: boolean = false
  ): string[] {
    const isWindows = process.platform === 'win32';
    const quote = (s: string) => isWindows && s.includes(' ') ? `"${s}"` : s;

    let gradleCommand: string;
    if (workspacePath && this.hasGradleWrapper(workspacePath)) {
      gradleCommand = isWindows ? 'gradlew.bat' : './gradlew';
    } else {
      gradleCommand = 'gradle';
    }

    const taskName = subprojectPrefix ? `${subprojectPrefix}:test` : 'test';
    const args = [gradleCommand, taskName];
    for (const filter of testFilters) {
      args.push('--tests', quote(filter));
    }

    args.push('--stacktrace');

    const initScriptPath = coverage
      ? quote(this.getCoverageInitScriptPath())
      : quote(this.getInitScriptPath());
    args.push('--init-script', initScriptPath);

    if (logger) {
      logger.appendLine(`BuildToolService: Batch execution with ${testFilters.length} test filter(s)${coverage ? ' (with coverage)' : ''}`);
    }

    if (debug) {
      args.push('--debug-jvm');
    }

    const extraArgs = ConfigurationService.getConfig().additionalGradleArgs;
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
  private static buildMavenCommandArgs(
    testName: string,
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    mavenModuleName?: string
  ): string[] {
    const isWindows = process.platform === 'win32';
    const quote = (s: string) => isWindows && s.includes(' ') ? `"${s}"` : s;

    const mvnCommand = this.getMavenCommand(workspacePath);

    // Convert "ClassName.methodName" to Surefire filter "ClassName#methodName"
    const surefireFilter = this.toSurefireFilter(testName);

    const args = [mvnCommand, 'test', `-Dtest=${quote(surefireFilter)}`, '-Dsurefire.useFile=true',
      '-Dsurefire.failIfNoSpecifiedTests=false'];

    // For multi-module: run only in the target module
    if (mavenModuleName) {
      args.push('-pl', mavenModuleName, '-am');
    }

    if (debug) {
      const cfg = ConfigurationService.getConfig();
      args.push(`-Dmaven.surefire.debug=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:${cfg.debugPort}`);
    }

    if (logger) {
      logger.appendLine(`BuildToolService: Using Maven Surefire to execute test`);
    }

    const extraArgs = ConfigurationService.getConfig().additionalMavenArgs;
    args.push(...extraArgs);

    return args;
  }

  /**
   * Build Maven command args for running a batch of tests.
   */
  private static buildMavenBatchCommandArgs(
    testFilters: string[],
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel,
    mavenModuleName?: string,
    coverage: boolean = false
  ): string[] {
    const isWindows = process.platform === 'win32';
    const quote = (s: string) => isWindows && s.includes(' ') ? `"${s}"` : s;

    const mvnCommand = this.getMavenCommand(workspacePath);

    // Group filters by class for Surefire: "Class1#m1+m2,Class2#m3"
    const surefireFilter = this.buildSurefireBatchFilter(testFilters);

    const args = [mvnCommand, 'test', `-Dtest=${quote(surefireFilter)}`, '-Dsurefire.useFile=true',
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
      const cfg = ConfigurationService.getConfig();
      args.push(`-Dmaven.surefire.debug=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:${cfg.debugPort}`);
    }

    if (logger) {
      logger.appendLine(`BuildToolService: Maven batch execution with ${testFilters.length} test filter(s)${coverage ? ' (with coverage)' : ''}`);
    }

    const extraArgs = ConfigurationService.getConfig().additionalMavenArgs;
    args.push(...extraArgs);

    return args;
  }

  /**
   * Get the Maven command, preferring the wrapper if available.
   */
  private static getMavenCommand(workspacePath?: string): string {
    const isWindows = process.platform === 'win32';
    if (workspacePath && this.hasMavenWrapper(workspacePath)) {
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

  // ── Shared / init scripts ──────────────────────────────────────────

  private static getInitScriptPath(): string {
    const initScriptPath = path.join(__dirname, '..', '..', 'resources', 'force-tests.init.gradle');
    
    if (!fs.existsSync(initScriptPath)) {
      throw new Error(`Init script not found at: ${initScriptPath}`);
    }           
    
    return initScriptPath;
  }

  /**
   * Path to the coverage init script that applies JaCoCo and forces tests.
   */
  static getCoverageInitScriptPath(): string {
    const initScriptPath = path.join(__dirname, '..', '..', 'resources', 'coverage.init.gradle');
    if (!fs.existsSync(initScriptPath)) {
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
}
