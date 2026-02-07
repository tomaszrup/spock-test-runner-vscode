import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { BuildTool } from '../types';

export class BuildToolService {
  /**
   * Detect the build tool at a given directory path.
   * Supports build.gradle (Groovy DSL) and build.gradle.kts (Kotlin DSL).
   */
  static detectBuildTool(workspacePath: string): BuildTool | null {
    if (this.isGradleProject(workspacePath)) {
      return 'gradle';
    }
    return null;
  }

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

  static getProjectName(workspacePath: string): string {
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
      // Fallback to workspace folder name
    }
    
    return path.basename(workspacePath);
  }

  static buildCommandArgs(
    testName: string, 
    debug: boolean, 
    workspacePath?: string,
    logger?: vscode.OutputChannel
  ): string[] {
    const isWindows = process.platform === 'win32';
    // On Windows with shell: true, arguments with spaces must be quoted
    const quote = (s: string) => isWindows && s.includes(' ') ? `"${s}"` : s;

    const escapedTestName = quote(testName);
    
    let gradleCommand: string;
    if (workspacePath && this.hasGradleWrapper(workspacePath)) {
      gradleCommand = isWindows ? 'gradlew.bat' : './gradlew';
    } else {
      gradleCommand = 'gradle';
    }
    const baseArgs = [gradleCommand, 'test', '--tests', escapedTestName, '--stacktrace'];
    
    // Use init script to force test execution
    const initScriptPath = quote(this.getInitScriptPath());
    const initScriptArgs = ['--init-script', initScriptPath];
    
    // Log the force execution approach
    if (logger) {
      logger.appendLine(`BuildToolService: Using Gradle init script to force test execution (--init-script)`);
    }
    
    if (debug) {
      return [...baseArgs, '--debug-jvm', ...initScriptArgs];
    } else {
      return [...baseArgs, ...initScriptArgs];
    }
  }

  static buildBatchCommandArgs(
    testFilters: string[],
    debug: boolean,
    workspacePath?: string,
    logger?: vscode.OutputChannel
  ): string[] {
    const isWindows = process.platform === 'win32';
    const quote = (s: string) => isWindows && s.includes(' ') ? `"${s}"` : s;

    let gradleCommand: string;
    if (workspacePath && this.hasGradleWrapper(workspacePath)) {
      gradleCommand = isWindows ? 'gradlew.bat' : './gradlew';
    } else {
      gradleCommand = 'gradle';
    }

    const args = [gradleCommand, 'test'];
    for (const filter of testFilters) {
      args.push('--tests', quote(filter));
    }

    args.push('--stacktrace');

    const initScriptPath = quote(this.getInitScriptPath());
    args.push('--init-script', initScriptPath);

    if (logger) {
      logger.appendLine(`BuildToolService: Batch execution with ${testFilters.length} test filter(s)`);
    }

    if (debug) {
      args.push('--debug-jvm');
    }

    return args;
  }

  private static getInitScriptPath(): string {
    // Get the path to the init script relative to the extension
    const initScriptPath = path.join(__dirname, '..', '..', 'resources', 'force-tests.init.gradle');
    
    // Verify the init script exists
    if (!fs.existsSync(initScriptPath)) {
      throw new Error(`Init script not found at: ${initScriptPath}`);
    }           
    
    return initScriptPath;
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
}
