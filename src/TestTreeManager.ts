import * as vscode from 'vscode';
import { IBuildToolService } from './services/BuildToolService';
import { IConfigurationService } from './services/ConfigurationService';
import { ITestDiscoveryService } from './services/TestDiscoveryService';
import { ClassDeclaration } from './services/testDiscoveryShared';
import { formatAnnotationDescription } from './testTreeTags';
import { SpockAnnotation, TestData } from './types';
import {
  cleanupIterationItems,
  haveDeclarationsChanged,
  parseTestsInFile,
  TestTreeParsingContext,
} from './testTreeParsing';
import {
  extractPackageName,
  getOrCreateFile,
  getOrCreatePackageNode,
  getOrCreateRootProjectNode,
  getOrCreateSubProjectNode,
  TestTreeNodeContext,
} from './testTreeNodes';

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
  private readonly fileClassDeclarations = new Map<string, ClassDeclaration[]>();
  private discoveryInProgress = false;
  private watchers: vscode.FileSystemWatcher[] = [];

  /** Fires when discoverAllTests rebuilds the tree from scratch. */
  private readonly _onDidRebuildTree = new vscode.EventEmitter<void>();
  public readonly onDidRebuildTree = this._onDidRebuildTree.event;

  constructor(
    private readonly controller: vscode.TestController,
    private readonly logger: vscode.LogOutputChannel,
    private readonly buildToolService: IBuildToolService,
    private readonly configurationService: IConfigurationService,
    private readonly testDiscoveryService: ITestDiscoveryService,
  ) {}

  // ── File-system watchers ───────────────────────────────────────────

  setupFileWatchers(): void {
    this.dispose();

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
        watcher.onDidDelete(uri => { // NOSONAR
          this.logger.appendLine(`TestTreeManager: File deleted: ${uri.fsPath}`);
          const fileKey = uri.toString();
          const hadTrackedDeclarations = (this.fileClassDeclarations.get(fileKey)?.length || 0) > 0;
          this.fileClassDeclarations.delete(fileKey);
          this.cleanupIterationItems(fileKey);
          for (const [, subItem] of this.subProjectItems) {
            subItem.children.delete(fileKey);
          }
          for (const [, projectItem] of this.projectItems) {
            projectItem.children.delete(fileKey);
          }
          // Remove file from package nodes, then clean up empty packages
          for (const [pkgKey, pkgItem] of this.packageItems) {
            pkgItem.children.delete(fileKey);
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
          this.controller.items.delete(fileKey);

          if (hadTrackedDeclarations) {
            this.logger.appendLine('TestTreeManager: Deleted file changed class declarations — triggering full discovery');
            void this.discoverAllTests().catch(error => {
              this.logger.appendLine(`TestTreeManager: Full discovery after file deletion failed: ${error}`);
            });
          }
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
          location: vscode.ProgressLocation.Window,
          title: 'Discovering Spock Tests',
          cancellable: true,
        },
        async (progress, cancellation) => { // NOSONAR
          progress.report({ message: 'Clearing existing tests…' });
          this.controller.items.replace([]);
          this.projectItems.clear();
          this.subProjectItems.clear();
          this.packageItems.clear();
          this.fileClassDeclarations.clear();

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
                  this.fileClassDeclarations.set(uri.toString(), declarations);
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
            const fileUri = fileItem.uri?.toString();
            if (fileUri) {
              this.cleanupIterationItems(fileUri);
            }
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
      const fileKey = file.uri.toString();
      const previousDeclarations = this.fileClassDeclarations.get(fileKey) || [];
      this.fileClassDeclarations.set(fileKey, declarations);

      if (this.haveDeclarationsChanged(previousDeclarations, declarations) &&
          (previousDeclarations.length > 0 || declarations.length > 0)) {
        this.logger.appendLine(`TestTreeManager: Class declarations changed in ${file.uri.fsPath} — triggering full discovery`);
        await this.discoverAllTests();
        return;
      }

      for (const decl of declarations) {
        const simpleParent = decl.parent.includes('.') ? decl.parent.split('.').pop() : undefined;
        if (this.knownSpecBaseClasses.has(decl.parent) ||
            (simpleParent && this.knownSpecBaseClasses.has(simpleParent))) {
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
    return getOrCreateRootProjectNode(this.getNodeContext(), rootProjectPath);
  }

  async getOrCreateSubProjectNode(subProjectPath: string, rootProjectPath: string): Promise<vscode.TestItem> {
    return getOrCreateSubProjectNode(this.getNodeContext(), subProjectPath, rootProjectPath);
  }

  async getOrCreateFile(uri: vscode.Uri): Promise<vscode.TestItem> { // NOSONAR
    return getOrCreateFile(this.getNodeContext(), uri);
  }

  // ── Package extraction & node creation ─────────────────────────────

  /**
   * Extract the Java/Groovy package name from a file path relative to a project root.
   * Looks for common source root patterns like `src/test/groovy/`, `src/test/java/`, etc.
   * Returns the dotted package name (e.g. `com.example`) or empty string if not found.
   */
  extractPackageName(filePath: string, projectRoot: string): string {
    return extractPackageName(filePath, projectRoot);
  }

  getOrCreatePackageNode(packageName: string, parentNode: vscode.TestItem, parentPath: string): vscode.TestItem {
    return getOrCreatePackageNode(this.getNodeContext(), packageName, parentNode, parentPath);
  }

  // ── File parsing ───────────────────────────────────────────────────

  parseTestsInFile(file: vscode.TestItem, content: string, knownSpecBaseClasses?: Set<string>): void { // NOSONAR
    return parseTestsInFile(this.getParsingContext(), file, content, knownSpecBaseClasses);
  }
  // ── Iteration item cleanup ─────────────────────────────────────────

  cleanupIterationItems(fileUri: string): void {
    cleanupIterationItems(this.getParsingContext(), fileUri);
  }

  private haveDeclarationsChanged(previous: ClassDeclaration[], current: ClassDeclaration[]): boolean {
    return haveDeclarationsChanged(previous, current);
  }

  formatAnnotationDescription(annotations: SpockAnnotation[] | undefined): string {
    return formatAnnotationDescription(annotations);
  }

  private getNodeContext(): TestTreeNodeContext {
    return {
      controller: this.controller,
      logger: this.logger,
      buildToolService: this.buildToolService,
      testData: this.testData,
      projectItems: this.projectItems,
      subProjectItems: this.subProjectItems,
      packageItems: this.packageItems,
    };
  }

  private getParsingContext(): TestTreeParsingContext {
    return {
      controller: this.controller,
      logger: this.logger,
      testDiscoveryService: this.testDiscoveryService,
      testData: this.testData,
      iterationItems: this.iterationItems,
      projectItems: this.projectItems,
      subProjectItems: this.subProjectItems,
      packageItems: this.packageItems,
    };
  }
}
