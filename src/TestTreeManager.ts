import * as path from 'path';
import * as vscode from 'vscode';
import { IBuildToolService } from './services/BuildToolService';
import { IConfigurationService } from './services/ConfigurationService';
import { ITestDiscoveryService } from './services/TestDiscoveryService';
import { SpockAnnotation, TestData } from './types';

/**
 * Manages the VS Code TestItem tree: project/subproject/file/class/method nodes,
 * file-system watchers, and Spock test discovery.
 */
export class TestTreeManager {
  public testData = new WeakMap<vscode.TestItem, TestData>();
  public iterationItems = new Map<string, vscode.TestItem[]>();
  public projectItems = new Map<string, vscode.TestItem>();
  public subProjectItems = new Map<string, vscode.TestItem>();
  public packageItems = new Map<string, vscode.TestItem>();
  public knownSpecBaseClasses = new Set<string>();
  private discoveryInProgress = false;
  private watchers: vscode.FileSystemWatcher[] = [];

  /** Fires when discoverAllTests rebuilds the tree from scratch. */
  private _onDidRebuildTree = new vscode.EventEmitter<void>();
  public readonly onDidRebuildTree = this._onDidRebuildTree.event;

  constructor(
    private controller: vscode.TestController,
    private logger: vscode.LogOutputChannel,
    private buildToolService: IBuildToolService,
    private configurationService: IConfigurationService,
    private testDiscoveryService: ITestDiscoveryService,
  ) {}

  // ── File-system watchers ───────────────────────────────────────────

  setupFileWatchers(): void {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }

    const sourcePatterns = this.configurationService.getConfig().testSourcePatterns;

    vscode.workspace.workspaceFolders.forEach(workspaceFolder => {
      for (const srcPattern of sourcePatterns) {
        const pattern = new vscode.RelativePattern(workspaceFolder, srcPattern);
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.watchers.push(watcher);

        watcher.onDidCreate(async uri => {
          const fsPath = uri.fsPath;
          if (!fsPath.includes('/bin/') && !fsPath.includes('\\bin\\')) {
            this.logger.appendLine(`TestTreeManager: File created: ${fsPath}`);
            this.discoverTestsInFile(await this.getOrCreateFile(uri));
          }
        });
        watcher.onDidChange(async uri => {
          const fsPath = uri.fsPath;
          if (!fsPath.includes('/bin/') && !fsPath.includes('\\bin\\')) {
            this.logger.appendLine(`TestTreeManager: File changed: ${fsPath}`);
            this.discoverTestsInFile(await this.getOrCreateFile(uri));
          }
        });
        watcher.onDidDelete(uri => {
          this.logger.appendLine(`TestTreeManager: File deleted: ${uri.fsPath}`);
          // Remove file from package nodes, then clean up empty packages
          for (const [pkgKey, pkgItem] of this.packageItems) {
            pkgItem.children.delete(uri.toString());
            if (pkgItem.children.size === 0) {
              // Remove empty package from its parent (subproject or project)
              for (const [, subItem] of this.subProjectItems) {
                subItem.children.delete(pkgItem.id);
              }
              for (const [, projectItem] of this.projectItems) {
                projectItem.children.delete(pkgItem.id);
              }
              this.packageItems.delete(pkgKey);
            }
          }
          for (const [subPath, subItem] of this.subProjectItems) {
            if (subItem.children.size === 0) {
              for (const [, projectItem] of this.projectItems) {
                projectItem.children.delete(subItem.id);
              }
              this.subProjectItems.delete(subPath);
            }
          }
          for (const [rootPath, projectItem] of this.projectItems) {
            if (projectItem.children.size === 0) {
              this.controller.items.delete(projectItem.id);
              this.projectItems.delete(rootPath);
            }
          }
          this.controller.items.delete(uri.toString());
        });
      }
    });
  }

  /**
   * Dispose all file-system watchers created by {@link setupFileWatchers}.
   */
  dispose(): void {
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = [];
  }

  // ── Full workspace discovery ───────────────────────────────────────

  async discoverAllTests(): Promise<void> {
    if (this.discoveryInProgress) {
      this.logger.appendLine('TestTreeManager: discoverAllTests skipped — already in progress');
      return;
    }
    this.discoveryInProgress = true;
    this.logger.appendLine('TestTreeManager: discoverAllTests called');

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Discovering Spock Tests',
          cancellable: true,
        },
        async (progress, cancellation) => {
          progress.report({ message: 'Clearing existing tests…' });
          this.controller.items.replace([]);
          this.projectItems.clear();
          this.subProjectItems.clear();
          this.packageItems.clear();

          // Notify listeners that tree was rebuilt (e.g. to clear stale re-run state)
          this._onDidRebuildTree.fire();

          if (!vscode.workspace.workspaceFolders) {
            this.logger.appendLine('TestTreeManager: No workspace folders found');
            return;
          }

          this.logger.appendLine(`TestTreeManager: Found ${vscode.workspace.workspaceFolders.length} workspace folders`);

          // Phase 1: Scan all .groovy files and collect class declarations
          progress.report({ message: 'Scanning for .groovy files…' });
          const allFileContents = new Map<string, { uri: vscode.Uri; content: string }>();
          const allClassDeclarations: Array<{ name: string; parent: string; isAbstract: boolean }> = [];

          const sourcePatterns = this.configurationService.getConfig().testSourcePatterns;

          for (const workspaceFolder of vscode.workspace.workspaceFolders) {
            this.logger.appendLine(`TestTreeManager: Searching in workspace: ${workspaceFolder.uri.fsPath}`);
            const excludePattern = new vscode.RelativePattern(workspaceFolder, '**/bin/**');

            let allFiles: vscode.Uri[] = [];
            for (const srcPattern of sourcePatterns) {
              const pattern = new vscode.RelativePattern(workspaceFolder, srcPattern);
              const files = await vscode.workspace.findFiles(pattern, excludePattern);
              allFiles.push(...files);
            }
            // Deduplicate by URI string
            const seen = new Set<string>();
            allFiles = allFiles.filter(f => {
              const key = f.toString();
              if (seen.has(key)) { return false; }
              seen.add(key);
              return true;
            });

            this.logger.appendLine(`TestTreeManager: Found ${allFiles.length} .groovy files`);

            // Open files in parallel batches for performance
            const BATCH_SIZE = 20;
            let scanned = 0;
            for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
              if (cancellation?.isCancellationRequested) {
                this.logger.appendLine('TestTreeManager: Discovery cancelled by user');
                return;
              }
              const batch = allFiles.slice(i, i + BATCH_SIZE);
              const results = await Promise.allSettled(
                batch.map(async (file) => {
                  const document = await vscode.workspace.openTextDocument(file);
                  return { uri: file, content: document.getText() };
                }),
              );
              for (const result of results) {
                if (result.status === 'fulfilled') {
                  const { uri, content } = result.value;
                  allFileContents.set(uri.toString(), { uri, content });
                  const declarations = this.testDiscoveryService.scanClassDeclarations(content);
                  allClassDeclarations.push(...declarations);
                } else {
                  this.logger.appendLine(`TestTreeManager: Error reading file: ${result.reason}`);
                }
              }
              scanned += batch.length;
              progress.report({
                message: `Scanning files… (${scanned}/${allFiles.length})`,
                increment: (batch.length / allFiles.length) * 100,
              });
            }
          }

          // Phase 2: Resolve cross-file inheritance
          progress.report({ message: 'Resolving class inheritance…' });
          this.knownSpecBaseClasses = this.testDiscoveryService.resolveAllSpecBaseClasses(allClassDeclarations);
          this.logger.appendLine(`TestTreeManager: Resolved ${this.knownSpecBaseClasses.size} spec base class names: ${[...this.knownSpecBaseClasses].join(', ')}`);

          // Phase 3: Parse all files
          let parsed = 0;
          const totalFiles = allFileContents.size;
          for (const [, { uri, content }] of allFileContents) {
            if (cancellation?.isCancellationRequested) {
              this.logger.appendLine('TestTreeManager: Discovery cancelled by user');
              return;
            }
            this.logger.appendLine(`TestTreeManager: Processing file: ${uri.fsPath}`);
            const fileItem = await this.getOrCreateFile(uri);
            this.cleanupIterationItems(fileItem.uri!.toString());
            this.parseTestsInFile(fileItem, content, this.knownSpecBaseClasses);
            parsed++;
            if (parsed % 10 === 0 || parsed === totalFiles) {
              progress.report({
                message: `Parsing tests… (${parsed}/${totalFiles})`,
                increment: (10 / totalFiles) * 100,
              });
            }
          }

          progress.report({ message: 'Discovery complete.' });
        },
      );
    } finally {
      this.discoveryInProgress = false;
    }
  }

  // ── Single-file discovery ──────────────────────────────────────────

  async discoverTestsInFile(file: vscode.TestItem): Promise<void> {
    if (!file.uri) {
      return;
    }

    this.logger.appendLine(`TestTreeManager: discoverTestsInFile called for: ${file.uri.fsPath}`);

    this.cleanupIterationItems(file.uri.toString());

    try {
      const document = await vscode.workspace.openTextDocument(file.uri);
      const content = document.getText();

      const declarations = this.testDiscoveryService.scanClassDeclarations(content);
      for (const decl of declarations) {
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

  // ── Node creation ──────────────────────────────────────────────────

  async getOrCreateRootProjectNode(rootProjectPath: string): Promise<vscode.TestItem> {
    const existing = this.projectItems.get(rootProjectPath);
    if (existing) {
      return existing;
    }

    const projectName = await this.buildToolService.getProjectName(rootProjectPath);
    const projectUri = vscode.Uri.file(rootProjectPath);
    const projectItem = this.controller.createTestItem(
      `project:${rootProjectPath}`,
      projectName,
      projectUri,
    );
    projectItem.canResolveChildren = true;
    projectItem.tags = [new vscode.TestTag('runnable')];
    this.testData.set(projectItem, { type: 'project' });
    this.controller.items.add(projectItem);
    this.projectItems.set(rootProjectPath, projectItem);
    this.logger.appendLine(`TestTreeManager: Created root project node: ${projectName} (${rootProjectPath})`);
    return projectItem;
  }

  async getOrCreateSubProjectNode(subProjectPath: string, rootProjectPath: string): Promise<vscode.TestItem> {
    const existing = this.subProjectItems.get(subProjectPath);
    if (existing) {
      return existing;
    }

    const subName = await this.buildToolService.getProjectName(subProjectPath);
    const subUri = vscode.Uri.file(subProjectPath);
    const subItem = this.controller.createTestItem(
      `subproject:${subProjectPath}`,
      subName,
      subUri,
    );
    subItem.canResolveChildren = true;
    subItem.tags = [new vscode.TestTag('runnable')];
    this.testData.set(subItem, { type: 'subproject' });

    const rootNode = await this.getOrCreateRootProjectNode(rootProjectPath);
    rootNode.children.add(subItem);
    this.subProjectItems.set(subProjectPath, subItem);
    this.logger.appendLine(`TestTreeManager: Created subproject node: ${subName} under ${rootNode.label} (${subProjectPath})`);
    return subItem;
  }

  async getOrCreateFile(uri: vscode.Uri): Promise<vscode.TestItem> {
    const existing = this.controller.items.get(uri.toString());
    if (existing) {
      return existing;
    }

    for (const [, projectItem] of this.projectItems) {
      const existingInProject = projectItem.children.get(uri.toString());
      if (existingInProject) {
        return existingInProject;
      }
    }
    for (const [, subItem] of this.subProjectItems) {
      const existingInSub = subItem.children.get(uri.toString());
      if (existingInSub) {
        return existingInSub;
      }
    }
    for (const [, pkgItem] of this.packageItems) {
      const existingInPkg = pkgItem.children.get(uri.toString());
      if (existingInPkg) {
        return existingInPkg;
      }
    }

    const file = this.controller.createTestItem(uri.toString(), path.basename(uri.fsPath), uri);
    file.canResolveChildren = true;
    file.tags = [];
    this.testData.set(file, { type: 'file' });

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      const projectRoot = await this.buildToolService.findProjectRoot(uri.fsPath, workspaceFolder.uri.fsPath);
      if (projectRoot) {
        const rootProject = await this.buildToolService.findRootProject(projectRoot, workspaceFolder.uri.fsPath);
        let parentNode: vscode.TestItem;
        let parentPath: string;
        if (path.resolve(projectRoot) !== path.resolve(rootProject)) {
          parentNode = await this.getOrCreateSubProjectNode(projectRoot, rootProject);
          parentPath = projectRoot;
        } else {
          parentNode = await this.getOrCreateRootProjectNode(rootProject);
          parentPath = rootProject;
        }

        const packageName = this.extractPackageName(uri.fsPath, projectRoot);
        if (packageName) {
          const pkgNode = this.getOrCreatePackageNode(packageName, parentNode, parentPath);
          pkgNode.children.add(file);
        } else {
          parentNode.children.add(file);
        }
        return file;
      }
    }

    this.controller.items.add(file);
    return file;
  }

  // ── Package extraction & node creation ─────────────────────────────

  /**
   * Extract the Java/Groovy package name from a file path relative to a project root.
   * Looks for common source root patterns like `src/test/groovy/`, `src/test/java/`, etc.
   * Returns the dotted package name (e.g. `com.example`) or empty string if not found.
   */
  extractPackageName(filePath: string, projectRoot: string): string {
    const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    // Match patterns like src/{sourceSet}/{language}/ — e.g. src/test/groovy/, src/main/java/
    const sourceRootPattern = /^(.*?src\/[^/]+\/(?:groovy|java|kotlin|scala))\//;
    const match = relativePath.match(sourceRootPattern);
    if (match) {
      const afterSourceRoot = relativePath.substring(match[1].length + 1);
      const dir = afterSourceRoot.substring(0, afterSourceRoot.lastIndexOf('/'));
      if (dir) {
        return dir.replace(/\//g, '.');
      }
    }
    return '';
  }

  getOrCreatePackageNode(packageName: string, parentNode: vscode.TestItem, parentPath: string): vscode.TestItem {
    const key = `${parentPath}:${packageName}`;
    const existing = this.packageItems.get(key);
    if (existing) {
      return existing;
    }

    const pkgItem = this.controller.createTestItem(
      `package:${key}`,
      packageName,
    );
    pkgItem.canResolveChildren = true;
    pkgItem.tags = [new vscode.TestTag('runnable')];
    this.testData.set(pkgItem, { type: 'package' });
    parentNode.children.add(pkgItem);
    this.packageItems.set(key, pkgItem);
    this.logger.appendLine(`TestTreeManager: Created package node: ${packageName} under ${parentNode.label}`);
    return pkgItem;
  }

  // ── File parsing ───────────────────────────────────────────────────

  parseTestsInFile(file: vscode.TestItem, content: string, knownSpecBaseClasses?: Set<string>): void {
    if (!file.uri) {
      return;
    }

    this.logger.appendLine(`TestTreeManager: Parsing tests in file: ${file.uri.fsPath}`);

    file.children.replace([]);

    const testClasses = this.testDiscoveryService.parseTestsInFile(content, knownSpecBaseClasses);
    let testCount = 0;
    let hasRunnableClasses = false;
    let hasAnyClasses = false;

    for (const testClass of testClasses) {
      this.logger.appendLine(`TestTreeManager: Found test class: ${testClass.name}`);
      this.logger.debug(`Class ${testClass.name} - isAbstract: ${testClass.isAbstract}, annotations: ${JSON.stringify(testClass.annotations?.map(a => a.name))}`);

      if (testClass.isAbstract) {
        this.logger.debug(`Class ${testClass.name} - SKIPPED (abstract class)`);
        continue;
      }

      hasAnyClasses = true;

      const classIgnored = this.testDiscoveryService.hasAnnotation(testClass.annotations, 'Ignore');
      const classStepwise = this.testDiscoveryService.hasAnnotation(testClass.annotations, 'Stepwise');
      const classPending = this.testDiscoveryService.hasAnnotation(testClass.annotations, 'PendingFeature');
      const classConditional = this.testDiscoveryService.hasAnnotation(testClass.annotations, 'IgnoreIf')
        || this.testDiscoveryService.hasAnnotation(testClass.annotations, 'Requires');

      let classLabel = testClass.name;
      if (classIgnored) {
        classLabel = `${testClass.name} ⊘ Ignored`;
      } else if (classStepwise) {
        classLabel = `${testClass.name} ⟳ Stepwise`;
      }

      const classItem = this.controller.createTestItem(
        `${file.uri.toString()}#${testClass.name}`,
        classLabel,
        file.uri,
      );
      classItem.range = testClass.range;

      if (classIgnored) {
        classItem.tags = [];
        classItem.description = this.formatAnnotationDescription(testClass.annotations);
      } else {
        classItem.tags = [new vscode.TestTag('runnable')];
        hasRunnableClasses = true;
        if (classConditional || classStepwise) {
          classItem.description = this.formatAnnotationDescription(testClass.annotations);
        }
      }

      this.logger.debug(`Class ${testClass.name} - label: "${classLabel}", ignored: ${classIgnored}`);
      this.testData.set(classItem, { type: 'class', className: testClass.name });
      file.children.add(classItem);

      for (const testMethod of testClass.methods) {
        this.logger.appendLine(`TestTreeManager: Found test method: ${testMethod.name}`);

        const methodIgnored = classIgnored || this.testDiscoveryService.hasAnnotation(testMethod.annotations, 'Ignore');
        const methodPending = classPending || this.testDiscoveryService.hasAnnotation(testMethod.annotations, 'PendingFeature');
        const methodConditional = this.testDiscoveryService.hasAnnotation(testMethod.annotations, 'IgnoreIf')
          || this.testDiscoveryService.hasAnnotation(testMethod.annotations, 'Requires');

        let methodLabel = testMethod.name;
        if (methodIgnored) {
          methodLabel = `${testMethod.name} ⊘`;
        } else if (methodPending) {
          methodLabel = `${testMethod.name} ⏳`;
        }

        this.logger.debug(`Method ${testMethod.name} in class ${testClass.name} - ignored: ${methodIgnored}, pending: ${methodPending}`);

        testCount++;

        if (testMethod.isDataDriven) {
          this.logger.debug(`Found data-driven method: ${testMethod.name} in class ${testClass.name}`);
          const parentTestItem = this.controller.createTestItem(
            `${file.uri.toString()}#${testClass.name}#${testMethod.name}`,
            methodLabel,
            file.uri,
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

          this.logger.debug(`Data-driven method ${testMethod.name} - ignored: ${methodIgnored}`);
          this.testData.set(parentTestItem, {
            type: 'test',
            className: testClass.name,
            testName: testMethod.name,
            isDataDriven: true,
          });
          classItem.children.add(parentTestItem);
        } else {
          const testItem = this.controller.createTestItem(
            `${file.uri.toString()}#${testClass.name}#${testMethod.name}`,
            methodLabel,
            file.uri,
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

          this.logger.debug(`Regular method ${testMethod.name} - ignored: ${methodIgnored}`);
          this.testData.set(testItem, {
            type: 'test',
            className: testClass.name,
            testName: testMethod.name,
          });
          classItem.children.add(testItem);
        }
      }
    }

    if (hasRunnableClasses) {
      file.tags = [new vscode.TestTag('runnable')];
      this.logger.debug(`File ${file.uri.fsPath} - ASSIGNED runnable tag (has runnable classes)`);
    } else if (hasAnyClasses) {
      file.tags = [];
      this.logger.debug(`File ${file.uri.fsPath} - Kept in tree (has classes, none runnable)`);
    } else {
      this.logger.debug(`File ${file.uri.fsPath} - Removing from tree (no runnable tests)`);
      // Remove file from package nodes, then clean up empty packages/subprojects/projects
      for (const [pkgKey, pkgItem] of this.packageItems) {
        pkgItem.children.delete(file.id);
        if (pkgItem.children.size === 0) {
          for (const [subPath, subItem] of this.subProjectItems) {
            subItem.children.delete(pkgItem.id);
            if (subItem.children.size === 0) {
              for (const [, projectItem] of this.projectItems) {
                projectItem.children.delete(subItem.id);
              }
              this.subProjectItems.delete(subPath);
              this.logger.debug(`Subproject ${subItem.label} - Removed (empty)`);
            }
          }
          for (const [projectRoot, projectItem] of this.projectItems) {
            projectItem.children.delete(pkgItem.id);
            if (projectItem.children.size === 0) {
              this.controller.items.delete(projectItem.id);
              this.projectItems.delete(projectRoot);
              this.logger.debug(`Root project ${projectItem.label} - Removed (empty)`);
            }
          }
          this.packageItems.delete(pkgKey);
          this.logger.debug(`Package ${pkgItem.label} - Removed (empty)`);
        }
      }
      for (const [subPath, subItem] of this.subProjectItems) {
        subItem.children.delete(file.id);
        if (subItem.children.size === 0) {
          for (const [rootPath, projectItem] of this.projectItems) {
            projectItem.children.delete(subItem.id);
            if (projectItem.children.size === 0) {
              this.controller.items.delete(projectItem.id);
              this.projectItems.delete(rootPath);
              this.logger.debug(`Root project ${projectItem.label} - Removed (empty)`);
            }
          }
          this.subProjectItems.delete(subPath);
          this.logger.debug(`Subproject ${subItem.label} - Removed (empty)`);
        }
      }
      for (const [projectRoot, projectItem] of this.projectItems) {
        projectItem.children.delete(file.id);
        if (projectItem.children.size === 0) {
          this.controller.items.delete(projectItem.id);
          this.projectItems.delete(projectRoot);
          this.logger.debug(`Project ${projectItem.label} - Removed (no files with tests)`);
        }
      }
      this.controller.items.delete(file.id);
      return;
    }

    this.logger.debug(`File ${file.uri.fsPath} - Final tags: ${JSON.stringify(file.tags.map(t => t.id))}`);
    this.logger.appendLine(`TestTreeManager: Parsed ${testCount} tests in file: ${file.uri.fsPath}`);
  }

  // ── Iteration item cleanup ─────────────────────────────────────────

  cleanupIterationItems(fileUri: string): void {
    const items = this.iterationItems.get(fileUri);
    if (items) {
      this.logger.appendLine(`TestTreeManager: Cleaning up ${items.length} old iteration items for ${fileUri}`);
      for (const item of items) {
        if (item.parent) {
          item.parent.children.delete(item.id);
        }
        this.controller.items.delete(item.id);
        this.testData.delete(item);
      }
      this.iterationItems.delete(fileUri);
    }
  }

  // ── Annotation formatting ──────────────────────────────────────────

  formatAnnotationDescription(annotations: SpockAnnotation[] | undefined): string {
    if (!annotations || annotations.length === 0) {
      return '';
    }

    const DISPLAY_ANNOTATIONS = new Set([
      'Ignore', 'PendingFeature', 'Stepwise', 'IgnoreIf', 'IgnoreRest',
      'Requires', 'Timeout', 'Issue',
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
