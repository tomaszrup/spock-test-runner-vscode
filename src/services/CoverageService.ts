import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';

/**
 * Detailed coverage data for a single source file, used to provide
 * line-level information when the user drills into coverage results.
 */
export interface FileCoverageData {
  uri: vscode.Uri;
  details: (vscode.StatementCoverage | vscode.DeclarationCoverage)[];
}

/**
 * Custom FileCoverage subclass that carries a reference back to its
 * parsed detail data so {@link loadDetailedCoverage} can return it.
 */
export class SpockFileCoverage extends vscode.FileCoverage {
  public details: (vscode.StatementCoverage | vscode.DeclarationCoverage)[];

  constructor(
    uri: vscode.Uri,
    statementCoverage: vscode.TestCoverageCount,
    branchCoverage: vscode.TestCoverageCount | undefined,
    declarationCoverage: vscode.TestCoverageCount | undefined,
    details: (vscode.StatementCoverage | vscode.DeclarationCoverage)[],
  ) {
    super(uri, statementCoverage, branchCoverage, declarationCoverage);
    this.details = details;
  }
}

/**
 * Parses JaCoCo XML coverage reports and converts them into VS Code
 * {@link FileCoverage} / {@link StatementCoverage} objects.
 */
export class CoverageService {
  private readonly logger: vscode.LogOutputChannel;
  private readonly xmlParser: XMLParser;

  constructor(logger: vscode.LogOutputChannel) {
    this.logger = logger;
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      trimValues: true,
    });
  }

  /**
   * Locate the JaCoCo XML report file under the project build directory.
   * Checks common JaCoCo output paths for Gradle and Maven projects.
   */
  async findJacocoXmlReport(projectRoot: string): Promise<string | null> {
    const candidates = [
      // Gradle paths
      path.join(projectRoot, 'build', 'reports', 'jacoco', 'test', 'jacocoTestReport.xml'),
      path.join(projectRoot, 'build', 'reports', 'jacoco', 'test', 'html', 'jacocoTestReport.xml'),
      path.join(projectRoot, 'build', 'reports', 'jacoco', 'jacocoTestReport.xml'),
      // Maven paths
      path.join(projectRoot, 'target', 'site', 'jacoco', 'jacoco.xml'),
      path.join(projectRoot, 'target', 'site', 'jacoco', 'jacocoTestReport.xml'),
    ];

    for (const candidate of candidates) {
      try {
        await fsp.access(candidate);
        this.logger.appendLine(`CoverageService: Found JaCoCo XML report at ${candidate}`);
        return candidate;
      } catch { /* not found */ }
    }

    // Fallback: glob for any *.xml inside build/reports/jacoco or target/site/jacoco
    const jacocoDirs = [
      path.join(projectRoot, 'build', 'reports', 'jacoco'),
      path.join(projectRoot, 'target', 'site', 'jacoco'),
    ];
    for (const jacocoDir of jacocoDirs) {
      try {
        await fsp.access(jacocoDir);
        const found = await this.findXmlRecursive(jacocoDir);
        if (found) {
          this.logger.appendLine(`CoverageService: Found JaCoCo XML report (recursive) at ${found}`);
          return found;
        }
      } catch { /* dir not found */ }
    }

    this.logger.appendLine('CoverageService: No JaCoCo XML report found');
    return null;
  }

  /**
   * Find all JaCoCo XML reports across the root project and its sub-modules.
   * Returns an array of `{ xmlPath, projectRoot }` for aggregation.
   */
  async findAllJacocoXmlReports(rootProjectPath: string): Promise<Array<{ xmlPath: string; projectRoot: string }>> {
    const results: Array<{ xmlPath: string; projectRoot: string }> = [];

    // Check root project itself
    const rootXml = await this.findJacocoXmlReport(rootProjectPath);
    if (rootXml) {
      results.push({ xmlPath: rootXml, projectRoot: rootProjectPath });
    }

    // Scan immediate sub-directories for sub-modules with their own JaCoCo reports
    try {
      const entries = await fsp.readdir(rootProjectPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        // Skip common non-module dirs
        if (['node_modules', '.gradle', '.mvn', 'build', 'target', 'gradle', '.git', '.idea'].includes(entry.name)) { continue; }

        const subDir = path.join(rootProjectPath, entry.name);
        // A sub-module should have its own build file
        const hasBuildFile = await this.fileExists(path.join(subDir, 'build.gradle'))
          || await this.fileExists(path.join(subDir, 'build.gradle.kts'))
          || await this.fileExists(path.join(subDir, 'pom.xml'));

        if (!hasBuildFile) { continue; }

        const subXml = await this.findJacocoXmlReport(subDir);
        if (subXml) {
          results.push({ xmlPath: subXml, projectRoot: subDir });
        }
      }
    } catch { /* root dir not readable */ }

    this.logger.appendLine(`CoverageService: Found ${results.length} JaCoCo reports across project`);
    return results;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try { await fsp.access(filePath); return true; } catch { return false; }
  }

  private async findXmlRecursive(dir: string): Promise<string | null> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await this.findXmlRecursive(fullPath);
        if (found) { return found; }
      } else if (entry.name.endsWith('.xml')) {
        return fullPath;
      }
    }
    return null;
  }

  /**
   * Parse a JaCoCo XML report and return {@link SpockFileCoverage} objects.
   *
   * @param xmlPath  Absolute path to the JaCoCo XML report.
   * @param projectRoot  Gradle project root (used to resolve source file paths).
   * @returns An array of {@link SpockFileCoverage} instances.
   */
  async parseJacocoReport(xmlPath: string, projectRoot: string): Promise<SpockFileCoverage[]> {
    const xml = await fsp.readFile(xmlPath, 'utf8');
    const fileCoverages: SpockFileCoverage[] = [];

    const parsed = this.xmlParser.parse(xml);
    const report = parsed?.report;
    if (!report) {
      this.logger.appendLine('CoverageService: No <report> element found in JaCoCo XML');
      return fileCoverages;
    }

    const packages = this.asArray(report['package']);

    for (const pkg of packages) {
      const packageName = pkg['@_name'] || ''; // e.g. "com/example"
      const sourceFiles = this.asArray(pkg['sourcefile']);

      for (const sf of sourceFiles) {
        const sourceFileName = sf['@_name'] || ''; // e.g. "BowlingGame.java"

        // Resolve the source file URI
        const sourceUri = await this.resolveSourceFile(projectRoot, packageName, sourceFileName);
        if (!sourceUri) {
          this.logger.appendLine(`CoverageService: Could not resolve source file: ${packageName}/${sourceFileName}`);
          continue;
        }

        const coverage = this.parseSourceFileCoverage(sourceUri, sf);
        if (coverage) {
          fileCoverages.push(coverage);
        }
      }
    }

    this.logger.appendLine(`CoverageService: Parsed ${fileCoverages.length} file coverage entries from ${xmlPath}`);
    return fileCoverages;
  }

  /** Ensure a value is always an array (handles fast-xml-parser single-element quirk). */
  private asArray<T>(value: T | T[] | undefined): T[] {
    if (!value) { return []; }
    return Array.isArray(value) ? value : [value];
  }

  /**
   * Parse line and counter data from a parsed <sourcefile> object.
   */
  private parseSourceFileCoverage( // NOSONAR
    sourceUri: vscode.Uri,
    sourceFile: any,
  ): SpockFileCoverage | null {
    const details: vscode.StatementCoverage[] = [];

    // Track aggregate counters
    let linesCovered = 0;
    let linesTotal = 0;
    let branchesCovered = 0;
    let branchesTotal = 0;

    // Parse <line> elements: nr, mi, ci, mb, cb
    const lines = this.asArray(sourceFile['line']);

    for (const line of lines) {
      const lineNumber = Number.parseInt(line['@_nr'] || '0', 10);
      const coveredInstructions = Number.parseInt(line['@_ci'] || '0', 10);
      const missedBranches = Number.parseInt(line['@_mb'] || '0', 10);
      const coveredBranches = Number.parseInt(line['@_cb'] || '0', 10);

      // A line is "covered" if at least one instruction was executed
      const executed = coveredInstructions > 0;
      linesTotal++;
      if (executed) { linesCovered++; }

      // Build branch coverage if this line has branches
      const branches: vscode.BranchCoverage[] = [];
      const totalBranches = missedBranches + coveredBranches;
      if (totalBranches > 0) {
        branchesTotal += totalBranches;
        branchesCovered += coveredBranches;

        for (let b = 0; b < coveredBranches; b++) {
          branches.push(new vscode.BranchCoverage(true, new vscode.Position(lineNumber - 1, 0)));
        }
        for (let b = 0; b < missedBranches; b++) {
          branches.push(new vscode.BranchCoverage(false, new vscode.Position(lineNumber - 1, 0)));
        }
      }

      // VS Code lines are 0-based; JaCoCo lines are 1-based
      const position = new vscode.Position(lineNumber - 1, 0);
      const executedCount = coveredInstructions;
      details.push(
        new vscode.StatementCoverage(
          Math.max(0, executedCount),
          position,
          branches.length > 0 ? branches : undefined,
        ),
      );
    }

    if (details.length === 0) {
      return null;
    }

    // Extract METHOD counter from <counter type="METHOD" .../>
    let methodsCovered = 0;
    let methodsTotal = 0;
    const counters = this.asArray(sourceFile['counter']);
    for (const counter of counters) {
      if (counter['@_type'] === 'METHOD') {
        const missed = Number.parseInt(counter['@_missed'] || '0', 10);
        const covered = Number.parseInt(counter['@_covered'] || '0', 10);
        methodsTotal += missed + covered;
        methodsCovered += covered;
      }
    }

    const statementCount = new vscode.TestCoverageCount(linesCovered, linesTotal);
    const branchCount = branchesTotal > 0
      ? new vscode.TestCoverageCount(branchesCovered, branchesTotal)
      : undefined;
    const declarationCount = methodsTotal > 0
      ? new vscode.TestCoverageCount(methodsCovered, methodsTotal)
      : undefined;

    return new SpockFileCoverage(sourceUri, statementCount, branchCount, declarationCount, details);
  }

  /**
   * Resolve a JaCoCo package/file reference to an actual workspace URI.
   * Searches common Gradle source sets: src/main/java, src/main/groovy, etc.
   */
  private async resolveSourceFile(
    projectRoot: string,
    packagePath: string, // e.g. "com/example"
    fileName: string,    // e.g. "BowlingGame.java"
  ): Promise<vscode.Uri | null> {
    const sourceSets = [
      path.join('src', 'main', 'java'),
      path.join('src', 'main', 'groovy'),
      path.join('src', 'main', 'kotlin'),
      path.join('src', 'test', 'java'),
      path.join('src', 'test', 'groovy'),
      path.join('src', 'test', 'kotlin'),
    ];

    for (const srcSet of sourceSets) {
      const candidate = path.join(projectRoot, srcSet, packagePath, fileName);
      try {
        await fsp.access(candidate);
        return vscode.Uri.file(candidate);
      } catch { /* not found */ }
    }

    return null;
  }
}
