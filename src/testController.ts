import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BuildToolService } from './services/BuildToolService';
import { CoverageService, SpockFileCoverage } from './services/CoverageService';
import { TestDiscoveryService } from './services/TestDiscoveryService';
import { TestExecutionService } from './services/TestExecutionService';
import { TestResultParser } from './services/TestResultParser';
import { ConfigurationService } from './services/ConfigurationService';
import { SpockAnnotation, TestIterationResult, DiffInfo, BuildTool } from './types';

export class SpockTestController {
  private controller: vscode.TestController;
  private logger: vscode.OutputChannel;
  private testData = new WeakMap<vscode.TestItem, TestData>();
  private testExecutionService: TestExecutionService;
  private testResultParser: TestResultParser;
  private coverageService: CoverageService;
  private iterationItems = new Map<string, vscode.TestItem[]>(); // Track iteration items by file URI
  private projectItems = new Map<string, vscode.TestItem>(); // Track project nodes by project root path
  private knownSpecBaseClasses = new Set<string>(); // Workspace-level spec base class names for inheritance resolution

  constructor(context: vscode.ExtensionContext, logger: vscode.OutputChannel) {
    this.logger = logger;
    this.logger.appendLine('SpockTestController: Initializing...');
    
    this.controller = vscode.tests.createTestController(
      'spock-test-runner-vscode',
      'Spock Tests'
    );
    
    this.testExecutionService = new TestExecutionService(this.logger);
    this.testResultParser = new TestResultParser(this.logger);
    this.coverageService = new CoverageService(this.logger);
    this.logger.appendLine('SpockTestController: TestController created');

    this.setupTestController();
    this.setupFileWatchers();
    this.createRunProfiles();
    this.registerCommands(context);

    // Add debugging to see if VS Code calls any methods on our controller
    this.logger.appendLine('SpockTestController: Setting up controller debugging...');
    
    // Override the controller's items property to track when it's accessed
    const originalItems = this.controller.items;
    Object.defineProperty(this.controller, 'items', {
      get: () => {
        this.logger.appendLine('SpockTestController: controller.items accessed');
        return originalItems;
      },
      enumerable: true,
      configurable: true
    });

    // Automatically discover tests on startup
    this.logger.appendLine('SpockTestController: Starting automatic test discovery...');
    this.discoverAllTests().catch(error => {
      this.logger.appendLine(`SpockTestController: Error during automatic discovery: ${error}`);
    });

    context.subscriptions.push(this.controller);
  }

  private setupTestController(): void {
    this.controller.resolveHandler = async (test) => {
      this.logger.appendLine(`SpockTestController: resolveHandler called with test: ${test ? test.id : 'null'}`);
      this.logger.appendLine(`SpockTestController: resolveHandler test type: ${test ? typeof test : 'null'}`);
      this.logger.appendLine(`SpockTestController: resolveHandler test label: ${test ? test.label : 'null'}`);
      this.logger.appendLine(`SpockTestController: resolveHandler test uri: ${test ? test.uri?.fsPath : 'null'}`);
      
      if (!test) {
        this.logger.appendLine('SpockTestController: Discovering all tests (reload triggered)...');
        await this.discoverAllTests();
      } else {
        this.logger.appendLine(`SpockTestController: Discovering tests in file: ${test.uri?.fsPath}`);
        await this.discoverTestsInFile(test);
      }
    };
  }

  private setupFileWatchers(): void {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }

    vscode.workspace.workspaceFolders.forEach(workspaceFolder => {
      const pattern = new vscode.RelativePattern(workspaceFolder, '**/*.groovy');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      watcher.onDidCreate(uri => {
        // Only process files that are NOT in the bin directory
        const fsPath = uri.fsPath;
        if (!fsPath.includes('/bin/') && !fsPath.includes('\\bin\\')) {
          this.logger.appendLine(`SpockTestController: File created: ${fsPath}`);
          this.discoverTestsInFile(this.getOrCreateFile(uri));
        }
      });
      watcher.onDidChange(uri => {
        // Only process files that are NOT in the bin directory
        const fsPath = uri.fsPath;
        if (!fsPath.includes('/bin/') && !fsPath.includes('\\bin\\')) {
          this.logger.appendLine(`SpockTestController: File changed: ${fsPath}`);
          this.discoverTestsInFile(this.getOrCreateFile(uri));
        }
      });
      watcher.onDidDelete(uri => {
        this.logger.appendLine(`SpockTestController: File deleted: ${uri.fsPath}`);
        // Remove from project nodes
        for (const [, projectItem] of this.projectItems) {
          projectItem.children.delete(uri.toString());
        }
        // Also try top-level removal (fallback files)
        this.controller.items.delete(uri.toString());
      });
    });
  }

  private createRunProfiles(): void {
    const runnableTag = new vscode.TestTag('runnable');
    
    const runProfile = this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runHandler(false, request, token),
      true,
      runnableTag
    );

    const debugProfile = this.controller.createRunProfile(
      'Debug',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.runHandler(true, request, token),
      true,
      runnableTag
    );

    const coverageProfile = this.controller.createRunProfile(
      'Coverage',
      vscode.TestRunProfileKind.Coverage,
      (request, token) => this.runHandler(false, request, token, true),
      true,
      runnableTag
    );

    coverageProfile.loadDetailedCoverage = async (_testRun, fileCoverage, _token) => {
      if (fileCoverage instanceof SpockFileCoverage) {
        return fileCoverage.details;
      }
      return [];
    };
  }

  private registerCommands(context: vscode.ExtensionContext): void {
    // Register a manual reload command for debugging
    const reloadCommand = vscode.commands.registerCommand('spock-test-runner.reloadTests', async () => {
      this.logger.appendLine('SpockTestController: Manual reload command triggered');
      await this.discoverAllTests();
      this.logger.appendLine('SpockTestController: Manual reload completed');
    });

    // Try to hook into VS Code's test refresh mechanism
    const refreshCommand = vscode.commands.registerCommand('testing.refreshTests', async () => {
      this.logger.appendLine('SpockTestController: VS Code refresh command intercepted');
      await this.discoverAllTests();
      this.logger.appendLine('SpockTestController: VS Code refresh completed');
    });

    context.subscriptions.push(reloadCommand, refreshCommand);
  }

  private async discoverAllTests(): Promise<void> {
    this.logger.appendLine('SpockTestController: discoverAllTests called');
    
    // Clear all existing test items to avoid caching issues
    this.logger.appendLine('SpockTestController: Clearing existing test items...');
    this.controller.items.replace([]);
    this.projectItems.clear();
    
    if (!vscode.workspace.workspaceFolders) {
      this.logger.appendLine('SpockTestController: No workspace folders found');
      return;
    }

    this.logger.appendLine(`SpockTestController: Found ${vscode.workspace.workspaceFolders.length} workspace folders`);
    
    // Phase 1: Scan all .groovy files and collect class declarations for inheritance resolution
    const allFileContents = new Map<string, { uri: vscode.Uri; content: string }>();
    const allClassDeclarations: Array<{ name: string; parent: string; isAbstract: boolean }> = [];

    for (const workspaceFolder of vscode.workspace.workspaceFolders) {
      this.logger.appendLine(`SpockTestController: Searching in workspace: ${workspaceFolder.uri.fsPath}`);
      const pattern = new vscode.RelativePattern(workspaceFolder, '**/*.groovy');
      const excludePattern = new vscode.RelativePattern(workspaceFolder, '**/bin/**');
      const files = await vscode.workspace.findFiles(pattern, excludePattern);
      
      this.logger.appendLine(`SpockTestController: Found ${files.length} .groovy files`);
      
      for (const file of files) {
        try {
          const document = await vscode.workspace.openTextDocument(file);
          const content = document.getText();
          allFileContents.set(file.toString(), { uri: file, content });
          const declarations = TestDiscoveryService.scanClassDeclarations(content);
          allClassDeclarations.push(...declarations);
        } catch (error) {
          this.logger.appendLine(`SpockTestController: Error reading file ${file.fsPath}: ${error}`);
        }
      }
    }

    // Phase 2: Resolve cross-file inheritance to determine all spec base classes
    this.knownSpecBaseClasses = TestDiscoveryService.resolveAllSpecBaseClasses(allClassDeclarations);
    this.logger.appendLine(`SpockTestController: Resolved ${this.knownSpecBaseClasses.size} spec base class names: ${[...this.knownSpecBaseClasses].join(', ')}`);

    // Phase 3: Parse all files with full inheritance knowledge
    for (const [uriStr, { uri, content }] of allFileContents) {
      this.logger.appendLine(`SpockTestController: Processing file: ${uri.fsPath}`);
      const fileItem = this.getOrCreateFile(uri);
      this.cleanupIterationItems(fileItem.uri!.toString());
      this.parseTestsInFile(fileItem, content, this.knownSpecBaseClasses);
    }
  }

  /**
   * Get or create a project node for the given Gradle project root.
   */
  private getOrCreateProjectNode(projectRoot: string, workspaceFolder: vscode.WorkspaceFolder): vscode.TestItem {
    const existing = this.projectItems.get(projectRoot);
    if (existing) {
      return existing;
    }

    const projectName = BuildToolService.getProjectName(projectRoot);
    const projectUri = vscode.Uri.file(projectRoot);
    const projectItem = this.controller.createTestItem(
      `project:${projectRoot}`,
      projectName,
      projectUri
    );
    projectItem.canResolveChildren = true;
    projectItem.tags = [new vscode.TestTag('runnable')];
    this.testData.set(projectItem, { type: 'project' });
    this.controller.items.add(projectItem);
    this.projectItems.set(projectRoot, projectItem);
    this.logger.appendLine(`SpockTestController: Created project node: ${projectName} (${projectRoot})`);
    return projectItem;
  }

  private async discoverTestsInFile(file: vscode.TestItem): Promise<void> {
    if (!file.uri) {
      return;
    }

    this.logger.appendLine(`SpockTestController: discoverTestsInFile called for: ${file.uri.fsPath}`);
    
    // Clean up old iteration items for this file
    this.cleanupIterationItems(file.uri.toString());
    
    try {
      const document = await vscode.workspace.openTextDocument(file.uri);
      const content = document.getText();

      // If the file introduces new class declarations, update the workspace-level
      // inheritance map so that specs extending local base classes are found.
      const declarations = TestDiscoveryService.scanClassDeclarations(content);
      for (const decl of declarations) {
        // Re-resolve: if this file defines a class extending Specification,
        // add it so other files (and this file) can reference it.
        if (this.knownSpecBaseClasses.has(decl.parent) ||
            (decl.parent.includes('.') && this.knownSpecBaseClasses.has(decl.parent.split('.').pop()!))) {
          this.knownSpecBaseClasses.add(decl.name);
        }
      }

      this.parseTestsInFile(file, content, this.knownSpecBaseClasses);
    } catch (error) {
      this.logger.appendLine(`Error discovering tests in ${file.uri.fsPath}: ${error}`);
    }
  }

  private getOrCreateFile(uri: vscode.Uri): vscode.TestItem {
    const existing = this.controller.items.get(uri.toString());
    if (existing) {
      return existing;
    }

    // Also check inside project nodes
    for (const [, projectItem] of this.projectItems) {
      const existingInProject = projectItem.children.get(uri.toString());
      if (existingInProject) {
        return existingInProject;
      }
    }

    const file = this.controller.createTestItem(uri.toString(), path.basename(uri.fsPath), uri);
    file.canResolveChildren = true;
    file.tags = []; // Will be set properly in parseTestsInFile based on content
    this.testData.set(file, { type: 'file' });

    // Find the project root (Gradle or Maven) for this file and nest under it
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      const projectRoot = BuildToolService.findProjectRoot(uri.fsPath, workspaceFolder.uri.fsPath);
      if (projectRoot) {
        const projectNode = this.getOrCreateProjectNode(projectRoot, workspaceFolder);
        projectNode.children.add(file);
        return file;
      }
    }

    // Fallback: add to top level if no project root found
    this.controller.items.add(file);
    return file;
  }

  private parseTestsInFile(file: vscode.TestItem, content: string, knownSpecBaseClasses?: Set<string>): void {
    if (!file.uri) {
      return;
    }

    this.logger.appendLine(`SpockTestController: Parsing tests in file: ${file.uri.fsPath}`);

    // Clear existing children
    file.children.replace([]);

    const testClasses = TestDiscoveryService.parseTestsInFile(content, knownSpecBaseClasses);
    let testCount = 0;
    let hasRunnableClasses = false;
    let hasAnyClasses = false;

    for (const testClass of testClasses) {
      this.logger.appendLine(`SpockTestController: Found test class: ${testClass.name}`);
      
      this.logger.appendLine(`[DEBUG] Class ${testClass.name} - isAbstract: ${testClass.isAbstract}, annotations: ${JSON.stringify(testClass.annotations?.map(a => a.name))}`);
      
      // Skip abstract classes entirely - they shouldn't appear in the test tree
      if (testClass.isAbstract) {
        this.logger.appendLine(`[DEBUG] Class ${testClass.name} - SKIPPED (abstract class)`);
        continue;
      }

      hasAnyClasses = true;

      // Check class-level annotations
      const classIgnored = TestDiscoveryService.hasAnnotation(testClass.annotations, 'Ignore');
      const classStepwise = TestDiscoveryService.hasAnnotation(testClass.annotations, 'Stepwise');
      const classPending = TestDiscoveryService.hasAnnotation(testClass.annotations, 'PendingFeature');
      const classConditional = TestDiscoveryService.hasAnnotation(testClass.annotations, 'IgnoreIf')
        || TestDiscoveryService.hasAnnotation(testClass.annotations, 'Requires');

      // Build the class label with annotation indicators
      let classLabel = testClass.name;
      if (classIgnored) {
        classLabel = `${testClass.name} ⊘ Ignored`;
      } else if (classStepwise) {
        classLabel = `${testClass.name} ⟳ Stepwise`;
      }
      
      const classItem = this.controller.createTestItem(
        `${file.uri.toString()}#${testClass.name}`,
        classLabel,
        file.uri
      );
      classItem.range = testClass.range;

      if (classIgnored) {
        // Ignored classes still shown but not runnable
        classItem.tags = [];
        classItem.description = this.formatAnnotationDescription(testClass.annotations);
      } else {
        classItem.tags = [new vscode.TestTag('runnable')];
        hasRunnableClasses = true;
        if (classConditional || classStepwise) {
          classItem.description = this.formatAnnotationDescription(testClass.annotations);
        }
      }

      this.logger.appendLine(`[DEBUG] Class ${testClass.name} - label: "${classLabel}", ignored: ${classIgnored}`);
      this.testData.set(classItem, { type: 'class', className: testClass.name });
      file.children.add(classItem);

      for (const testMethod of testClass.methods) {
        this.logger.appendLine(`SpockTestController: Found test method: ${testMethod.name}`);

        // Determine effective method-level annotations (class @Ignore propagates)
        const methodIgnored = classIgnored || TestDiscoveryService.hasAnnotation(testMethod.annotations, 'Ignore');
        const methodPending = classPending || TestDiscoveryService.hasAnnotation(testMethod.annotations, 'PendingFeature');
        const methodConditional = TestDiscoveryService.hasAnnotation(testMethod.annotations, 'IgnoreIf')
          || TestDiscoveryService.hasAnnotation(testMethod.annotations, 'Requires');

        // Build label with annotation indicators
        let methodLabel = testMethod.name;
        if (methodIgnored) {
          methodLabel = `${testMethod.name} ⊘`;
        } else if (methodPending) {
          methodLabel = `${testMethod.name} ⏳`;
        }

        this.logger.appendLine(`[DEBUG] Method ${testMethod.name} in class ${testClass.name} - ignored: ${methodIgnored}, pending: ${methodPending}`);
        
        testCount++;
        
        if (testMethod.isDataDriven) {
          this.logger.appendLine(`[DEBUG] Found data-driven method: ${testMethod.name} in class ${testClass.name}`);
          // Create parent test item for data-driven test
          const parentTestItem = this.controller.createTestItem(
            `${file.uri.toString()}#${testClass.name}#${testMethod.name}`,
            methodLabel,
            file.uri
          );
          parentTestItem.range = testMethod.range;
          parentTestItem.canResolveChildren = false;

          if (methodIgnored) {
            parentTestItem.tags = [];
            parentTestItem.description = this.formatAnnotationDescription(testMethod.annotations);
          } else {
            parentTestItem.tags = [new vscode.TestTag('runnable')];
            if (methodPending || methodConditional) {
              parentTestItem.description = this.formatAnnotationDescription(testMethod.annotations);
            }
          }

          this.logger.appendLine(`[DEBUG] Data-driven method ${testMethod.name} - ignored: ${methodIgnored}`);
          this.testData.set(parentTestItem, {
            type: 'test',
            className: testClass.name,
            testName: testMethod.name,
            isDataDriven: true
          });
          classItem.children.add(parentTestItem);
          
          // Don't create individual test items for data iterations
          // They will be shown in test results when the parent test runs
          // but won't have individual run actions
        } else {
          // Regular test method
          const testItem = this.controller.createTestItem(
            `${file.uri.toString()}#${testClass.name}#${testMethod.name}`,
            methodLabel,
            file.uri
          );
          testItem.range = testMethod.range;

          if (methodIgnored) {
            testItem.tags = [];
            testItem.description = this.formatAnnotationDescription(testMethod.annotations);
          } else {
            testItem.tags = [new vscode.TestTag('runnable')];
            if (methodPending || methodConditional) {
              testItem.description = this.formatAnnotationDescription(testMethod.annotations);
            }
          }

          this.logger.appendLine(`[DEBUG] Regular method ${testMethod.name} - ignored: ${methodIgnored}`);
          this.testData.set(testItem, {
            type: 'test',
            className: testClass.name,
            testName: testMethod.name
          });
          classItem.children.add(testItem);
        }
      }
    }
    
    // Set file-level runnable tag based on whether it contains any runnable classes
    if (hasRunnableClasses) {
      file.tags = [new vscode.TestTag('runnable')];
      this.logger.appendLine(`[DEBUG] File ${file.uri.fsPath} - ASSIGNED runnable tag (has runnable classes)`);
    } else if (hasAnyClasses) {
      // File has classes (e.g. all @Ignore) but none are runnable – keep in tree without runnable tag
      file.tags = [];
      this.logger.appendLine(`[DEBUG] File ${file.uri.fsPath} - Kept in tree (has classes, none runnable)`);
    } else {
      // Remove files with no runnable tests from the tree entirely
      this.logger.appendLine(`[DEBUG] File ${file.uri.fsPath} - Removing from tree (no runnable tests)`);
      // Remove from parent project node
      for (const [projectRoot, projectItem] of this.projectItems) {
        projectItem.children.delete(file.id);
        // If the project node is now empty, remove it too
        if (projectItem.children.size === 0) {
          this.controller.items.delete(projectItem.id);
          this.projectItems.delete(projectRoot);
          this.logger.appendLine(`[DEBUG] Project ${projectItem.label} - Removed (no files with tests)`);
        }
      }
      // Also try top-level removal (fallback)
      this.controller.items.delete(file.id);
      return;
    }
    
    // Debug: Log the actual tags on the file
    this.logger.appendLine(`[DEBUG] File ${file.uri.fsPath} - Final tags: ${JSON.stringify(file.tags.map(t => t.id))}`);
    
    this.logger.appendLine(`SpockTestController: Parsed ${testCount} tests in file: ${file.uri.fsPath}`);
  }

  private async runHandler(debug: boolean, request: vscode.TestRunRequest, token: vscode.CancellationToken, coverage: boolean = false): Promise<void> {
    const run = this.controller.createTestRun(request);

    this.logger.appendLine(`SpockTestController: runHandler called. debug=${debug}, coverage=${coverage}`);
    this.logger.appendLine(`SpockTestController: request.include=${request.include ? request.include.length + ' items' : 'undefined (run all)'}`);
    if (request.include) {
      for (const item of request.include) {
        const d = this.testData.get(item);
        this.logger.appendLine(`SpockTestController:   include item: id=${item.id}, label=${item.label}, type=${d?.type}, className=${d?.className}, testName=${d?.testName}`);
      }
    }

    // Phase 1: Collect all leaf test items
    const leafTests: Array<{test: vscode.TestItem, data: TestData}> = [];
    const queue: vscode.TestItem[] = [];

    if (request.include) {
      request.include.forEach(test => queue.push(test));
    } else {
      this.controller.items.forEach(test => queue.push(test));
    }

    while (queue.length > 0 && !token.isCancellationRequested) {
      const test = queue.pop()!;

      if (request.exclude?.includes(test)) {
        continue;
      }

      const data = this.testData.get(test);
      if (!data) {
        continue;
      }

      switch (data.type) {
        case 'project':
          test.children.forEach(child => queue.push(child));
          break;
        case 'file':
          if (test.children.size === 0) {
            await this.discoverTestsInFile(test);
          }
          test.children.forEach(child => queue.push(child));
          break;
        case 'class':
          test.children.forEach(child => queue.push(child));
          break;
        case 'test':
          leafTests.push({test, data});
          break;
      }
    }

    if (token.isCancellationRequested || leafTests.length === 0) {
      run.end();
      return;
    }

    // Phase 2: Group by project root
    const groups = new Map<string, Array<{test: vscode.TestItem, data: TestData}>>();

    for (const item of leafTests) {
      if (!item.test.uri) { continue; }
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(item.test.uri);
      if (!workspaceFolder) { continue; }

      const projectRoot = BuildToolService.findProjectRoot(item.test.uri.fsPath, workspaceFolder.uri.fsPath);
      if (!projectRoot) { continue; }

      if (!groups.has(projectRoot)) { groups.set(projectRoot, []); }
      groups.get(projectRoot)!.push(item);
    }

    // Phase 3: Execute each group as a single batch
    for (const [projectRoot, tests] of groups) {
      if (token.isCancellationRequested) { break; }
      await this.runBatch(projectRoot, tests, run, debug, token, coverage);
    }

    run.end();
  }

  private async runBatch(
    projectRoot: string,
    tests: Array<{test: vscode.TestItem, data: TestData}>,
    run: vscode.TestRun,
    debug: boolean,
    token: vscode.CancellationToken,
    coverage: boolean = false
  ): Promise<void> {
    const start = Date.now();

    // Detect the build tool for this project
    const buildTool: BuildTool = BuildToolService.detectBuildTool(projectRoot) || 'gradle';

    // Resolve the root project (where settings.gradle / gradlew or parent pom.xml live)
    // and derive the subproject/module identifier for multi-module builds.
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const rootProject = workspaceFolder
      ? BuildToolService.findRootProject(projectRoot, workspaceFolder.uri.fsPath)
      : projectRoot;

    // For Gradle: subproject prefix like ":moduleA"
    // For Maven: module name like "moduleA" (used with -pl)
    const subprojectPrefix = buildTool === 'gradle'
      ? BuildToolService.getSubprojectPrefix(rootProject, projectRoot)
      : BuildToolService.getMavenModuleName(rootProject, projectRoot);

    if (subprojectPrefix) {
      this.logger.appendLine(`SpockTestController: Multi-module detected — root: ${rootProject}, ${buildTool === 'gradle' ? 'subproject prefix' : 'module name'}: ${subprojectPrefix}`);
    }

    // Mark all tests as started
    for (const {test} of tests) {
      run.started(test);
    }

    // Build test filters
    const testFilters: string[] = [];
    for (const {data} of tests) {
      if (data.className && data.testName) {
        testFilters.push(`${data.className}.${data.testName}`);
      } else {
        this.logger.appendLine(`SpockTestController: Skipping test with missing className=${data.className} testName=${data.testName}`);
      }
    }

    if (testFilters.length === 0) {
      this.logger.appendLine('SpockTestController: No valid test filters, skipping batch');
      for (const {test} of tests) {
        run.skipped(test);
      }
      return;
    }

    // Build lookup map for real-time updates: "className#testName" -> entry
    const testLookup = new Map<string, {test: vscode.TestItem, data: TestData, resolved: boolean}>();
    for (const item of tests) {
      const key = `${item.data.className}#${item.data.testName}`;
      testLookup.set(key, {...item, resolved: false});
    }

    const commandArgs = BuildToolService.buildBatchCommandArgs(
      testFilters, debug, rootProject, this.logger, subprojectPrefix, coverage, buildTool
    );

    this.logger.appendLine(`SpockTestController: Running batch of ${tests.length} test(s) in ${projectRoot}${coverage ? ' (with coverage)' : ''}`);
    this.logger.appendLine(`SpockTestController: Build tool: ${buildTool}, root project: ${rootProject}`);
    this.logger.appendLine(`SpockTestController: Command: ${commandArgs.join(' ')}`);
    this.logger.appendLine(`SpockTestController: Test filters: ${JSON.stringify(testFilters)}`);

    // Execute with real-time output parsing
    // CWD must be the root project (where gradlew / mvnw lives), but test result
    // XML files are under the subproject's build/ or target/ directory.
    const result = await this.testExecutionService.executeBatch({
      commandArgs,
      workspacePath: rootProject,
      run,
      testItems: tests.map(t => t.test),
      debug,
      token,
      onOutputLine: (line: string) => {
        // Parse Gradle test output: "ClassName > test name PASSED/FAILED/SKIPPED"
        const gradleMatch = line.match(/^\s*(\S+)\s+>\s+(.+?)\s+(PASSED|FAILED|SKIPPED)\s*$/);
        if (gradleMatch) {
          const className = gradleMatch[1];
          const testPart = gradleMatch[2].trim();
          const status = gradleMatch[3];

          // Skip data-driven iteration lines like "Class > testName > iteration PASSED"
          // or "Class > testName [params, #N] PASSED" — let handleDataDrivenTestResults process those
          if (testPart.includes(' > ') || /\[.*#\d+\]$/.test(testPart)) {
            return;
          }

          const key = `${className}#${testPart}`;
          const entry = testLookup.get(key);

          if (entry && !entry.resolved && !entry.data.isDataDriven) {
            entry.resolved = true;
            if (status === 'PASSED') {
              run.passed(entry.test, Date.now() - start);
            } else if (status === 'FAILED') {
              // Don't resolve yet — let XML parsing provide detailed error info with stack trace
              entry.resolved = false;
            } else {
              run.skipped(entry.test);
            }
          }
        }
      }
    });

    // If cancelled, mark all unresolved tests as skipped and return early
    if (token.isCancellationRequested) {
      for (const [, entry] of testLookup) {
        if (!entry.resolved) {
          run.skipped(entry.test);
          entry.resolved = true;
        }
      }
      return;
    }

    // Handle data-driven tests that need iteration results
    for (const [key, entry] of testLookup) {
      if (entry.data.isDataDriven && !entry.resolved) {
        try {
          await this.handleDataDrivenTestResults(entry.test, entry.data, result, run, projectRoot, buildTool);
          entry.resolved = true;
        } catch (error) {
          this.logger.appendLine(`SpockTestController: Error handling data-driven results: ${error}`);
        }
      }
    }

    // Resolve remaining unresolved tests using XML reports
    const unresolvedClasses = new Set<string>();
    for (const [key, entry] of testLookup) {
      if (!entry.resolved && entry.data.className) {
        unresolvedClasses.add(entry.data.className);
      }
    }

    for (const className of unresolvedClasses) {
      const xmlResults = await this.testResultParser.parseClassTestResults(projectRoot, className, buildTool);
      for (const [key, entry] of testLookup) {
        if (!entry.resolved && entry.data.className === className && entry.data.testName) {
          const xmlResult = xmlResults.get(entry.data.testName);
          if (xmlResult) {
            entry.resolved = true;
            if (xmlResult.success) {
              run.passed(entry.test, Date.now() - start);
            } else {
              run.failed(entry.test, this.createTestMessage(xmlResult.errorMessage || 'Test failed', xmlResult.diff), Date.now() - start);
            }
          }
        }
      }
    }

    // Final fallback for still-unresolved tests
    for (const [key, entry] of testLookup) {
      if (!entry.resolved) {
        if (result.success) {
          run.passed(entry.test, Date.now() - start);
        } else {
          const errorMessage = this.extractErrorFromOutput(result.output, entry.data.className!, entry.data.testName!);
          run.failed(entry.test, this.createTestMessage(errorMessage), Date.now() - start);
        }
      }
    }

    // Phase: Attach coverage data if this is a coverage run
    if (coverage) {
      this.logger.appendLine('SpockTestController: Parsing JaCoCo coverage report...');
      const xmlPath = this.coverageService.findJacocoXmlReport(projectRoot);
      if (xmlPath) {
        const fileCoverages = this.coverageService.parseJacocoReport(xmlPath, projectRoot);
        for (const fc of fileCoverages) {
          run.addCoverage(fc);
        }
        this.logger.appendLine(`SpockTestController: Added ${fileCoverages.length} file coverage entries`);
      } else {
        this.logger.appendLine('SpockTestController: No JaCoCo XML report found — coverage data unavailable');
      }
    }
  }

  /**
   * Handle results for data-driven tests by creating iteration test items
   */
  private async handleDataDrivenTestResults(
    test: vscode.TestItem, 
    data: TestData, 
    result: any, 
    run: vscode.TestRun, 
    workspacePath: string,
    buildTool: BuildTool = 'gradle'
  ): Promise<void> {
    this.logger.appendLine(`SpockTestController: Handling data-driven test results for ${data.className}.${data.testName}`);
    
    try {
      // Parse iteration results
      const iterationResults = await this.testResultParser.parseTestResults(
        result.output || '',
        data.testName!,
        data.className!,
        workspacePath,
        buildTool
      );

      if (iterationResults.length > 0) {
        this.logger.appendLine(`SpockTestController: Found ${iterationResults.length} iteration results`);
        
        // Update test data with iteration results
        data.iterationResults = iterationResults;
        this.testData.set(test, data);
        
        // Create flat test items for each iteration with test name prepended
        this.createFlatIterationItems(test, iterationResults, run);
      } else {
        // No iteration results found, treat as regular test
        this.logger.appendLine(`SpockTestController: No iteration results found, treating as regular test`);
        if (result.success) {
          run.passed(test, Date.now() - Date.now());
        } else {
          const errorMessage = this.extractErrorFromOutput(result.output || '', data.className!, data.testName!);
          const message = this.createTestMessage(errorMessage);
          run.failed(test, message, Date.now() - Date.now());
        }
      }
    } catch (error) {
      this.logger.appendLine(`SpockTestController: Error handling data-driven test results: ${error}`);
      // Fallback to regular test result
      if (result.success) {
        run.passed(test, Date.now() - Date.now());
      } else {
        const errorMessage = this.extractErrorFromOutput(result.output || '', data.className!, data.testName!);
        const message = this.createTestMessage(errorMessage);
        run.failed(test, message, Date.now() - Date.now());
      }
    }
  }

  /**
   * Extract meaningful error information from console output for a specific test.
   * Looks for Spock assertion blocks, exception messages, and stack traces.
   */
  private extractErrorFromOutput(output: string, className: string, testName: string): string {
    if (!output) {
      return 'Test failed';
    }

    const lines = output.split('\n');
    const parts: string[] = [];
    let conditionBlock: string[] = [];
    let capturingCondition = false;
    const stackTraceLines: string[] = [];
    let foundRelevantFailure = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect the FAILED line for our specific test
      if (line.includes('FAILED') && (line.includes(className) || line.includes(testName))) {
        foundRelevantFailure = true;
      }

      // Capture Spock "Condition not satisfied" / "Assertion failed" blocks
      if (line.includes('Condition not satisfied:') || line.includes('Assertion failed:')) {
        capturingCondition = true;
        conditionBlock = [line.trim()];
        continue;
      }
      if (capturingCondition) {
        if (line.match(/^\s+/) && !line.trim().startsWith('at ')) {
          conditionBlock.push(line.trimEnd());
          continue;
        } else {
          capturingCondition = false;
        }
      }

      // Capture stack trace lines from test code (not Gradle internals)
      if (line.trim().startsWith('at ') && line.includes('.groovy:')) {
        stackTraceLines.push(line.trim());
      }
    }

    // Build the error message
    if (conditionBlock.length > 0) {
      parts.push(conditionBlock.join('\n'));
    }
    if (stackTraceLines.length > 0) {
      if (parts.length > 0) { parts.push(''); }
      parts.push(stackTraceLines.join('\n'));
    }

    if (parts.length > 0) {
      return parts.join('\n');
    }

    // If we found a FAILED line but couldn't extract details, report that
    if (foundRelevantFailure) {
      return `${className}.${testName} FAILED (see console output for details)`;
    }

    return 'Test failed';
  }


  /**
   * Clean up old iteration items for a file
   */
  private cleanupIterationItems(fileUri: string): void {
    const items = this.iterationItems.get(fileUri);
    if (items) {
      this.logger.appendLine(`SpockTestController: Cleaning up ${items.length} old iteration items for ${fileUri}`);
      for (const item of items) {
        // Remove from parent's children
        if (item.parent) {
          item.parent.children.delete(item.id);
        }
        // Also try top-level removal as fallback
        this.controller.items.delete(item.id);
        this.testData.delete(item);
      }
      this.iterationItems.delete(fileUri);
    }
  }

  /**
   * Create flat test items for parameterized test iterations
   */
  private createFlatIterationItems(
    parentTest: vscode.TestItem, 
    iterationResults: TestIterationResult[], 
    run: vscode.TestRun
  ): void {
    this.logger.appendLine(`SpockTestController: Creating ${iterationResults.length} flat iteration items`);
    
    // Get the test name from the parent test
    const testName = parentTest.label;
    const className = this.testData.get(parentTest)?.className || 'Unknown';
    const fileUri = parentTest.uri?.toString() || '';
    
    // Sort iterations by index, with fallback to parameter-based sorting
    const sortedResults = iterationResults.sort((a, b) => {
      // First try to sort by index
      if (a.index !== b.index) {
        return a.index - b.index;
      }
      
      // Fallback: sort by parameter values for consistent ordering
      const aParams = Object.values(a.parameters).join(',');
      const bParams = Object.values(b.parameters).join(',');
      return aParams.localeCompare(bParams);
    });
    
    // Track iteration items for cleanup
    const newIterationItems: vscode.TestItem[] = [];
    
    for (const iteration of sortedResults) {
      // Create a flat test item with test name prepended
      const iterationId = `${parentTest.id}#iteration-${iteration.index}`;
      const iterationLabel = `${testName} [#${iteration.index}] ${this.formatParameters(iteration.parameters)}`;
      
      const iterationItem = this.controller.createTestItem(
        iterationId,
        iterationLabel,
        parentTest.uri
      );
      
      // Set the range to the specific line in the where block for this iteration
      const iterationRange = this.calculateIterationRange(parentTest, iteration);
      iterationItem.range = iterationRange;
      
      // Set iteration data
      this.testData.set(iterationItem, {
        type: 'test',
        className: className,
        testName: testName,
        isDataDriven: false // Individual iterations are not data-driven themselves
      });
      
      // Add as a child of the parent test item
      parentTest.children.add(iterationItem);
      
      // Track this iteration item for cleanup
      newIterationItems.push(iterationItem);
      
      // Set result status for the iteration
      if (iteration.success) {
        run.passed(iterationItem, iteration.duration * 1000);
      } else {
        const message = this.createTestMessage(
          iteration.errorInfo?.error || 'Iteration failed',
          iteration.errorInfo?.diff
        );
        if (iteration.errorInfo?.location) {
          message.location = iteration.errorInfo.location;
        }
        run.failed(iterationItem, message, iteration.duration * 1000);
      }
      
      this.logger.appendLine(`SpockTestController: Created flat iteration item: ${iterationLabel}`);
    }
    
    // Store the new iteration items for this file
    this.iterationItems.set(fileUri, newIterationItems);
    
    // Do NOT set explicit pass/fail on the parent test.
    // VS Code infers the parent's status from its children, and this avoids
    // the parent appearing as a separate entry in the Test Results tab —
    // only the individual iterations will be shown there.
  }

  /**
   * Calculate the range for a specific iteration in the where block
   */
  private calculateIterationRange(parentTest: vscode.TestItem, iteration: TestIterationResult): vscode.Range {
    if (!parentTest.uri) {
      return parentTest.range || new vscode.Range(0, 0, 0, 0);
    }

    try {
      // Read the file content to find the where block
      const content = fs.readFileSync(parentTest.uri.fsPath, 'utf8');
      const lines = content.split('\n');
      
      // Find the test method and where block
      const testName = parentTest.label;
      let testMethodLine = -1;
      let whereBlockLine = -1;
      
      // Find the test method line
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(`def "${testName}"`) || line.includes(`def ${testName}`)) {
          testMethodLine = i;
          break;
        }
      }
      
      if (testMethodLine === -1) {
        return parentTest.range || new vscode.Range(0, 0, 0, 0);
      }
      
      // Find the where block after the test method
      for (let i = testMethodLine; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === 'where:') {
          whereBlockLine = i;
          break;
        }
      }
      
      if (whereBlockLine === -1) {
        return parentTest.range || new vscode.Range(0, 0, 0, 0);
      }
      
      // Calculate the line for this iteration
      // Skip the header line (e.g., "a | b | c") and go to the data line
      const dataStartLine = whereBlockLine + 2; // Skip "where:" and header
      const iterationLine = dataStartLine + iteration.index;
      
      // Make sure we don't go beyond the file
      if (iterationLine >= lines.length) {
        return parentTest.range || new vscode.Range(0, 0, 0, 0);
      }
      
      // Return the range for the specific iteration line
      return new vscode.Range(iterationLine, 0, iterationLine, lines[iterationLine].length);
      
    } catch (error) {
      this.logger.appendLine(`Error calculating iteration range: ${error}`);
      return parentTest.range || new vscode.Range(0, 0, 0, 0);
    }
  }

  /**
   * Format parameters for display in test item label
   */
  private formatParameters(parameters: Record<string, any>): string {
    const entries = Object.entries(parameters);
    if (entries.length === 0) {
      return '';
    }
    
    return entries
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
  }

  /**
   * Create a TestMessage, using diff() when expected/actual values are available
   * so VS Code renders a rich inline diff view.
   * Gated behind the (Preview) `showDiffView` setting.
   */
  private createTestMessage(errorText: string, diff?: DiffInfo): vscode.TestMessage {
    const useDiff = ConfigurationService.getConfig().showDiffView;
    if (useDiff && diff) {
      return vscode.TestMessage.diff(errorText, diff.expected, diff.actual);
    }
    // Try to extract diff info from the error text as a fallback
    if (useDiff) {
      const parsed = this.testResultParser.parseExpectedActual(errorText);
      if (parsed) {
        return vscode.TestMessage.diff(errorText, parsed.expected, parsed.actual);
      }
    }
    return new vscode.TestMessage(errorText);
  }

  /**
   * Build a human-readable description string from a list of annotations.
   * Used as the `description` property of test items to show annotation context
   * in the Test Explorer sidebar.
   */
  private formatAnnotationDescription(annotations: SpockAnnotation[] | undefined): string {
    if (!annotations || annotations.length === 0) {
      return '';
    }

    const DISPLAY_ANNOTATIONS = new Set([
      'Ignore', 'PendingFeature', 'Stepwise', 'IgnoreIf', 'IgnoreRest',
      'Requires', 'Timeout', 'Issue'
    ]);

    const parts: string[] = [];
    for (const a of annotations) {
      if (!DISPLAY_ANNOTATIONS.has(a.name)) {
        continue;
      }
      if (a.argument) {
        parts.push(`@${a.name}(${a.argument})`);
      } else {
        parts.push(`@${a.name}`);
      }
    }
    return parts.join(' ');
  }
}

interface TestData {
  type: 'project' | 'file' | 'class' | 'test';
  className?: string;
  testName?: string;
  isDataDriven?: boolean;
  iterationResults?: TestIterationResult[];
}
