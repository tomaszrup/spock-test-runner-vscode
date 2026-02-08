import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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
  private logger: vscode.OutputChannel;

  constructor(logger: vscode.OutputChannel) {
    this.logger = logger;
  }

  /**
   * Locate the JaCoCo XML report file under the project build directory.
   * Checks common JaCoCo output paths for Gradle and Maven projects.
   */
  findJacocoXmlReport(projectRoot: string): string | null {
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
      if (fs.existsSync(candidate)) {
        this.logger.appendLine(`CoverageService: Found JaCoCo XML report at ${candidate}`);
        return candidate;
      }
    }

    // Fallback: glob for any *.xml inside build/reports/jacoco or target/site/jacoco
    const jacocoDirs = [
      path.join(projectRoot, 'build', 'reports', 'jacoco'),
      path.join(projectRoot, 'target', 'site', 'jacoco'),
    ];
    for (const jacocoDir of jacocoDirs) {
      if (fs.existsSync(jacocoDir)) {
        const found = this.findXmlRecursive(jacocoDir);
        if (found) {
          this.logger.appendLine(`CoverageService: Found JaCoCo XML report (recursive) at ${found}`);
          return found;
        }
      }
    }

    this.logger.appendLine('CoverageService: No JaCoCo XML report found');
    return null;
  }

  private findXmlRecursive(dir: string): string | null {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = this.findXmlRecursive(fullPath);
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
  parseJacocoReport(xmlPath: string, projectRoot: string): SpockFileCoverage[] {
    const xml = fs.readFileSync(xmlPath, 'utf8');
    const fileCoverages: SpockFileCoverage[] = [];

    // Parse <package> elements
    const packageRegex = /<package\s+name="([^"]*)">([\s\S]*?)<\/package>/g;
    let packageMatch: RegExpExecArray | null;

    while ((packageMatch = packageRegex.exec(xml)) !== null) {
      const packageName = packageMatch[1]; // e.g. "com/example"
      const packageContent = packageMatch[2];

      // Parse <sourcefile> elements within this package
      const sourceFileRegex = /<sourcefile\s+name="([^"]*)">([\s\S]*?)<\/sourcefile>/g;
      let sourceFileMatch: RegExpExecArray | null;

      while ((sourceFileMatch = sourceFileRegex.exec(packageContent)) !== null) {
        const sourceFileName = sourceFileMatch[1]; // e.g. "BowlingGame.java"
        const sourceFileContent = sourceFileMatch[2];

        // Resolve the source file URI
        const sourceUri = this.resolveSourceFile(projectRoot, packageName, sourceFileName);
        if (!sourceUri) {
          this.logger.appendLine(`CoverageService: Could not resolve source file: ${packageName}/${sourceFileName}`);
          continue;
        }

        const coverage = this.parseSourceFileCoverage(sourceUri, sourceFileContent);
        if (coverage) {
          fileCoverages.push(coverage);
        }
      }
    }

    this.logger.appendLine(`CoverageService: Parsed ${fileCoverages.length} file coverage entries from ${xmlPath}`);
    return fileCoverages;
  }

  /**
   * Parse line and counter data from a single <sourcefile> element.
   */
  private parseSourceFileCoverage(
    sourceUri: vscode.Uri,
    sourceFileContent: string,
  ): SpockFileCoverage | null {
    const details: vscode.StatementCoverage[] = [];

    // Track aggregate counters
    let linesCovered = 0;
    let linesTotal = 0;
    let branchesCovered = 0;
    let branchesTotal = 0;

    // Parse <line> elements: <line nr="10" mi="0" ci="3" mb="0" cb="2"/>
    //   nr = line number
    //   mi = missed instructions, ci = covered instructions
    //   mb = missed branches, cb = covered branches
    const lineRegex = /<line\s+nr="(\d+)"\s+mi="(\d+)"\s+ci="(\d+)"\s+mb="(\d+)"\s+cb="(\d+)"\s*\/>/g;
    let lineMatch: RegExpExecArray | null;

    while ((lineMatch = lineRegex.exec(sourceFileContent)) !== null) {
      const lineNumber = parseInt(lineMatch[1], 10);
      const missedInstructions = parseInt(lineMatch[2], 10);
      const coveredInstructions = parseInt(lineMatch[3], 10);
      const missedBranches = parseInt(lineMatch[4], 10);
      const coveredBranches = parseInt(lineMatch[5], 10);

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

        // Represent as covered/missed branch entries
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
          executedCount > 0 ? executedCount : 0,
          position,
          branches.length > 0 ? branches : undefined,
        ),
      );
    }

    if (details.length === 0) {
      return null;
    }

    // Also try to extract method-level counters from <counter> elements
    let methodsCovered = 0;
    let methodsTotal = 0;
    const methodCounterRegex = /<counter\s+type="METHOD"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/g;
    let methodMatch: RegExpExecArray | null;
    while ((methodMatch = methodCounterRegex.exec(sourceFileContent)) !== null) {
      methodsTotal += parseInt(methodMatch[1], 10) + parseInt(methodMatch[2], 10);
      methodsCovered += parseInt(methodMatch[2], 10);
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
  private resolveSourceFile(
    projectRoot: string,
    packagePath: string, // e.g. "com/example"
    fileName: string,    // e.g. "BowlingGame.java"
  ): vscode.Uri | null {
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
      if (fs.existsSync(candidate)) {
        return vscode.Uri.file(candidate);
      }
    }

    return null;
  }
}
