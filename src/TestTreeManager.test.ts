import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { TestTreeManager } from './TestTreeManager';
import { createMockLogger, createMockConfigurationService } from './__test_helpers__';

// --- Helpers -------------------------------------------------------------

function createMockController() {
  const items = new Map<string, any>();
  return {
    items: {
      add: (item: any) => items.set(item.id, item),
      get: (id: string) => items.get(id),
      delete: (id: string) => items.delete(id),
      replace: (arr: any[]) => { items.clear(); arr.forEach(i => items.set(i.id, i)); },
      forEach: (cb: any) => items.forEach(cb),
      get size() { return items.size; },
    },
    createTestItem: (id: string, label: string, uri?: vscode.Uri) => {
      const children = new Map<string, any>();
      const item: any = {
        id, label, uri,
        children: {
          add: (child: any) => { child.parent = item; children.set(child.id, child); },
          get: (cid: string) => children.get(cid),
          delete: (cid: string) => children.delete(cid),
          replace: (arr: any[]) => { children.clear(); arr.forEach(c => { c.parent = item; children.set(c.id, c); }); },
          forEach: (cb: any) => children.forEach(cb),
          get size() { return children.size; },
        },
        tags: [],
        range: undefined,
        canResolveChildren: false,
        parent: undefined,
        description: undefined,
      };
      return item;
    },
  } as any;
}

// createMockLogger imported from __test_helpers__

function createMockBuildToolService() {
  return {
    detectBuildTool: vi.fn().mockResolvedValue('gradle'),
    findProjectRoot: vi.fn().mockResolvedValue('/workspace/project'),
    findRootProject: vi.fn().mockResolvedValue('/workspace/project'),
    getProjectName: vi.fn().mockResolvedValue('test-project'),
    getSubprojectPrefix: vi.fn().mockReturnValue(''),
    getMavenModuleName: vi.fn().mockReturnValue(''),
    buildCommandArgs: vi.fn().mockResolvedValue(['gradle', 'test']),
    buildBatchCommandArgs: vi.fn().mockResolvedValue(['gradle', 'test']),
    getTestResultsDir: vi.fn().mockReturnValue('/workspace/project/build/test-results/test'),
  } as any;
}

// createMockConfigurationService imported from __test_helpers__

function createMockTestDiscoveryService() {
  return {
    parseTestsInFile: vi.fn().mockReturnValue([]),
    scanClassDeclarations: vi.fn().mockReturnValue([]),
    resolveAllSpecBaseClasses: vi.fn().mockReturnValue(new Set<string>()),
    hasAnnotation: vi.fn().mockReturnValue(false),
  } as any;
}

// --- Tests ---------------------------------------------------------------

describe('TestTreeManager', () => {
  let controller: ReturnType<typeof createMockController>;
  let logger: ReturnType<typeof createMockLogger>;
  let buildToolService: ReturnType<typeof createMockBuildToolService>;
  let configurationService: ReturnType<typeof createMockConfigurationService>;
  let testDiscoveryService: ReturnType<typeof createMockTestDiscoveryService>;
  let manager: TestTreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = createMockController();
    logger = createMockLogger();
    buildToolService = createMockBuildToolService();
    configurationService = createMockConfigurationService();
    testDiscoveryService = createMockTestDiscoveryService();

    (vscode.workspace as any).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 },
    ];
    (vscode.workspace as any).getWorkspaceFolder = vi.fn(() => ({
      uri: vscode.Uri.file('/workspace'),
      name: 'workspace',
      index: 0,
    }));

    manager = new TestTreeManager(
      controller, logger, buildToolService, configurationService, testDiscoveryService,
    );
  });

  // ── File watcher behavior ───────────────────────────────────────

  describe('setupFileWatchers', () => {
    it('should discover tests when a watched file is created', async () => {
      const callbacks: {
        create?: (uri: vscode.Uri) => Promise<void> | void;
        change?: (uri: vscode.Uri) => Promise<void> | void;
        delete?: (uri: vscode.Uri) => void;
      } = {};

      const originalCreateWatcher = vscode.workspace.createFileSystemWatcher;
      try {
        (vscode.workspace as any).createFileSystemWatcher = vi.fn(() => ({
          onDidCreate: (cb: (uri: vscode.Uri) => Promise<void>) => {
            callbacks.create = cb;
            return { dispose: () => {} };
          },
          onDidChange: (cb: (uri: vscode.Uri) => Promise<void>) => {
            callbacks.change = cb;
            return { dispose: () => {} };
          },
          onDidDelete: (cb: (uri: vscode.Uri) => void) => {
            callbacks.delete = cb;
            return { dispose: () => {} };
          },
          dispose: () => {},
        }));

        const discoverSpy = vi.spyOn(manager, 'discoverTestsInFile').mockResolvedValue();

        manager.setupFileWatchers();
        const newFileUri = vscode.Uri.file('/workspace/project/src/test/groovy/NewSpec.groovy');
        await callbacks.create?.(newFileUri);

        expect(discoverSpy).toHaveBeenCalledTimes(1);
        expect(discoverSpy.mock.calls[0][0].uri?.toString()).toBe(newFileUri.toString());
      } finally {
        (vscode.workspace as any).createFileSystemWatcher = originalCreateWatcher;
      }
    });

    it('should remove deleted file from test tree and cleanup empty grouping nodes', async () => {
      const callbacks: {
        create?: (uri: vscode.Uri) => Promise<void> | void;
        change?: (uri: vscode.Uri) => Promise<void> | void;
        delete?: (uri: vscode.Uri) => void;
      } = {};

      const originalCreateWatcher = vscode.workspace.createFileSystemWatcher;
      try {
        (vscode.workspace as any).createFileSystemWatcher = vi.fn(() => ({
          onDidCreate: (cb: (uri: vscode.Uri) => Promise<void>) => {
            callbacks.create = cb;
            return { dispose: () => {} };
          },
          onDidChange: (cb: (uri: vscode.Uri) => Promise<void>) => {
            callbacks.change = cb;
            return { dispose: () => {} };
          },
          onDidDelete: (cb: (uri: vscode.Uri) => void) => {
            callbacks.delete = cb;
            return { dispose: () => {} };
          },
          dispose: () => {},
        }));

        manager.setupFileWatchers();
        const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/DeleteMeSpec.groovy');
        await manager.getOrCreateFile(fileUri);

        let fileFoundBeforeDelete = false;
        manager.projectItems.forEach(projectItem => {
          projectItem.children.forEach((child: any) => {
            if (child.id === fileUri.toString()) {
              fileFoundBeforeDelete = true;
              return;
            }
            child.children?.forEach((nested: any) => {
              if (nested.id === fileUri.toString()) {
                fileFoundBeforeDelete = true;
              }
            });
          });
        });
        expect(fileFoundBeforeDelete).toBe(true);
        expect(manager.projectItems.size).toBeGreaterThan(0);

        callbacks.delete?.(fileUri);

        let fileFoundAfterDelete = false;
        manager.projectItems.forEach(projectItem => {
          projectItem.children.forEach((child: any) => {
            if (child.id === fileUri.toString()) {
              fileFoundAfterDelete = true;
              return;
            }
            child.children?.forEach((nested: any) => {
              if (nested.id === fileUri.toString()) {
                fileFoundAfterDelete = true;
              }
            });
          });
        });
        expect(fileFoundAfterDelete).toBe(false);
        expect(manager.packageItems.size).toBe(0);
        expect(manager.subProjectItems.size).toBe(0);
        expect(manager.projectItems.size).toBe(0);
      } finally {
        (vscode.workspace as any).createFileSystemWatcher = originalCreateWatcher;
      }
    });
  });

  // ── parseTestsInFile ─────────────────────────────────────────────

  describe('parseTestsInFile', () => {
    it('should create class and test nodes for a simple spec', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/MySpec.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'MySpec.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'MySpec',
          range: new vscode.Range(0, 0, 10, 0),
          isAbstract: false,
          annotations: [],
          methods: [
            { name: 'should add numbers', range: new vscode.Range(2, 0, 5, 0), isDataDriven: false, annotations: [] },
            { name: 'should subtract', range: new vscode.Range(6, 0, 9, 0), isDataDriven: false, annotations: [] },
          ],
        },
      ]);

      manager.parseTestsInFile(file, 'class MySpec extends Specification {}');

      // class node added
      let classNode: any;
      file.children.forEach((child: any) => { classNode = child; });
      expect(classNode).toBeDefined();
      expect(classNode.label).toBe('MySpec');

      // two test methods
      let methodCount = 0;
      classNode.children.forEach(() => { methodCount++; });
      expect(methodCount).toBe(2);

      // runnable tag on file
      expect(file.tags.some((t: any) => t.id === 'runnable')).toBe(true);
    });

    it('should mark data-driven methods correctly', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/DataSpec.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'DataSpec.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'DataSpec',
          range: new vscode.Range(0, 0, 10, 0),
          isAbstract: false,
          annotations: [],
          methods: [
            { name: 'add #a + #b', range: new vscode.Range(2, 0, 8, 0), isDataDriven: true, annotations: [] },
          ],
        },
      ]);

      manager.parseTestsInFile(file, 'class DataSpec extends Specification {}');

      let methodNode: any;
      file.children.forEach((cls: any) => cls.children.forEach((m: any) => { methodNode = m; }));
      expect(methodNode).toBeDefined();

      const data = manager.testData.get(methodNode);
      expect(data?.isDataDriven).toBe(true);
    });

    it('should skip abstract classes', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/BaseSpec.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'BaseSpec.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'BaseSpec',
          range: new vscode.Range(0, 0, 5, 0),
          isAbstract: true,
          annotations: [],
          methods: [
            { name: 'test one', range: new vscode.Range(2, 0, 4, 0), isDataDriven: false, annotations: [] },
          ],
        },
      ]);

      manager.parseTestsInFile(file, 'abstract class BaseSpec extends Specification {}');

      // No children because abstract → skipped, and no runnable classes so file is removed
      let count = 0;
      file.children.forEach(() => count++);
      expect(count).toBe(0);
    });

    it('should mark ignored class and its methods as not runnable', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/IgnoredSpec.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'IgnoredSpec.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.hasAnnotation.mockImplementation(
        (annotations: any, name: string) => name === 'Ignore' && annotations?.some((a: any) => a.name === 'Ignore'),
      );

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'IgnoredSpec',
          range: new vscode.Range(0, 0, 10, 0),
          isAbstract: false,
          annotations: [{ name: 'Ignore' }],
          methods: [
            { name: 'test one', range: new vscode.Range(2, 0, 5, 0), isDataDriven: false, annotations: [] },
          ],
        },
      ]);

      manager.parseTestsInFile(file, '@Ignore class IgnoredSpec extends Specification {}');

      let classNode: any;
      file.children.forEach((child: any) => { classNode = child; });
      expect(classNode).toBeDefined();
      expect(classNode.label).toContain('⊘ Ignored');
      expect(classNode.tags.some((t: any) => t.id === 'runnable')).toBe(false);

      // child method should also be not runnable
      let methodNode: any;
      classNode.children.forEach((child: any) => { methodNode = child; });
      expect(methodNode.tags.some((t: any) => t.id === 'runnable')).toBe(false);
    });

    it('should label stepwise classes', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/StepSpec.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'StepSpec.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.hasAnnotation.mockImplementation(
        (annotations: any, name: string) => annotations?.some((a: any) => a.name === name),
      );

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'StepSpec',
          range: new vscode.Range(0, 0, 10, 0),
          isAbstract: false,
          annotations: [{ name: 'Stepwise' }],
          methods: [
            { name: 'step one', range: new vscode.Range(2, 0, 4, 0), isDataDriven: false, annotations: [] },
          ],
        },
      ]);

      manager.parseTestsInFile(file, '@Stepwise class StepSpec extends Specification {}');

      let classNode: any;
      file.children.forEach((child: any) => { classNode = child; });
      expect(classNode.label).toContain('⟳ Stepwise');
    });

    it('should remove file from tree when no concrete classes are found', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/Empty.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'Empty.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });
      controller.items.add(file);

      testDiscoveryService.parseTestsInFile.mockReturnValue([]);

      manager.parseTestsInFile(file, '// empty');

      expect(controller.items.get(file.id)).toBeUndefined();
    });
  });

  // ── getOrCreateFile ──────────────────────────────────────────────

  describe('getOrCreateFile', () => {
    it('should create a file item under a package node under its project node', async () => {
      const uri = vscode.Uri.file('/workspace/project/src/test/groovy/com/example/Spec.groovy');

      const file = await manager.getOrCreateFile(uri);

      expect(file).toBeDefined();
      expect(file.label).toBe('Spec.groovy');
      expect(manager.testData.get(file)?.type).toBe('file');

      // project node should have been created
      expect(manager.projectItems.size).toBe(1);

      // package node should have been created
      expect(manager.packageItems.size).toBe(1);
      const pkgItem = [...manager.packageItems.values()][0];
      expect(pkgItem.label).toBe('com.example');

      // file should be child of package
      expect(pkgItem.children.get(file.id)).toBe(file);
    });

    it('should place file directly under project when no package is detected', async () => {
      const uri = vscode.Uri.file('/workspace/project/src/test/groovy/Spec.groovy');

      const file = await manager.getOrCreateFile(uri);

      expect(file).toBeDefined();
      expect(file.label).toBe('Spec.groovy');
      expect(manager.testData.get(file)?.type).toBe('file');

      // project node should have been created
      expect(manager.projectItems.size).toBe(1);

      // no package node
      expect(manager.packageItems.size).toBe(0);
    });

    it('should return existing file item without duplicates', async () => {
      const uri = vscode.Uri.file('/workspace/project/src/test/groovy/com/example/Spec.groovy');

      const file1 = await manager.getOrCreateFile(uri);
      const file2 = await manager.getOrCreateFile(uri);

      expect(file1).toBe(file2);
    });

    it('should create subproject node when project root differs from root project', async () => {
      const uri = vscode.Uri.file('/workspace/project/sub/src/test/groovy/com/example/Spec.groovy');

      buildToolService.findProjectRoot.mockResolvedValue('/workspace/project/sub');
      buildToolService.findRootProject.mockResolvedValue('/workspace/project');
      buildToolService.getProjectName.mockImplementation(async (path: string) =>
        path.includes('sub') ? 'sub-module' : 'root-project',
      );

      const file = await manager.getOrCreateFile(uri);

      expect(file).toBeDefined();
      expect(manager.subProjectItems.size).toBe(1);
      expect(manager.projectItems.size).toBe(1);
      expect(manager.packageItems.size).toBe(1);
    });
  });

  // ── getOrCreateRootProjectNode ───────────────────────────────────

  describe('getOrCreateRootProjectNode', () => {
    it('should reuse existing project node', async () => {
      const node1 = await manager.getOrCreateRootProjectNode('/workspace/project');
      const node2 = await manager.getOrCreateRootProjectNode('/workspace/project');
      expect(node1).toBe(node2);
    });

    it('should tag project as runnable', async () => {
      const node = await manager.getOrCreateRootProjectNode('/workspace/project');
      expect(node.tags.some((t: any) => t.id === 'runnable')).toBe(true);
      expect(manager.testData.get(node)?.type).toBe('project');
    });
  });

  // ── getOrCreateSubProjectNode ────────────────────────────────────

  describe('getOrCreateSubProjectNode', () => {
    it('should create subproject as child of root project', async () => {
      buildToolService.getProjectName.mockImplementation(async (p: string) =>
        p.includes('sub') ? 'sub-module' : 'root',
      );

      const sub = await manager.getOrCreateSubProjectNode('/workspace/project/sub', '/workspace/project');

      expect(sub.label).toBe('sub-module');
      expect(sub.tags.some((t: any) => t.id === 'runnable')).toBe(true);
      expect(manager.subProjectItems.size).toBe(1);
    });
  });

  // ── extractPackageName ─────────────────────────────────────────

  describe('extractPackageName', () => {
    it('should extract package from standard Groovy test path', () => {
      const result = manager.extractPackageName(
        '/workspace/project/src/test/groovy/com/example/MySpec.groovy',
        '/workspace/project',
      );
      expect(result).toBe('com.example');
    });

    it('should extract package from standard Java test path', () => {
      const result = manager.extractPackageName(
        '/workspace/project/src/test/java/org/foo/bar/MyTest.java',
        '/workspace/project',
      );
      expect(result).toBe('org.foo.bar');
    });

    it('should extract package from main source path', () => {
      const result = manager.extractPackageName(
        '/workspace/project/src/main/groovy/com/example/MyClass.groovy',
        '/workspace/project',
      );
      expect(result).toBe('com.example');
    });

    it('should return empty string when file is directly in source root', () => {
      const result = manager.extractPackageName(
        '/workspace/project/src/test/groovy/MySpec.groovy',
        '/workspace/project',
      );
      expect(result).toBe('');
    });

    it('should return empty string when path has no recognized source root', () => {
      const result = manager.extractPackageName(
        '/workspace/project/tests/MySpec.groovy',
        '/workspace/project',
      );
      expect(result).toBe('');
    });

    it('should handle deeply nested packages', () => {
      const result = manager.extractPackageName(
        '/workspace/project/src/test/groovy/com/example/deep/nested/pkg/MySpec.groovy',
        '/workspace/project',
      );
      expect(result).toBe('com.example.deep.nested.pkg');
    });
  });

  // ── getOrCreatePackageNode ─────────────────────────────────────

  describe('getOrCreatePackageNode', () => {
    it('should create a package node as child of parent', async () => {
      const parent = await manager.getOrCreateRootProjectNode('/workspace/project');

      const pkg = manager.getOrCreatePackageNode('com.example', parent, '/workspace/project');

      expect(pkg.label).toBe('com.example');
      expect(pkg.tags.some((t: any) => t.id === 'runnable')).toBe(true);
      expect(manager.testData.get(pkg)?.type).toBe('package');
      expect(manager.packageItems.size).toBe(1);
    });

    it('should reuse existing package node', async () => {
      const parent = await manager.getOrCreateRootProjectNode('/workspace/project');

      const pkg1 = manager.getOrCreatePackageNode('com.example', parent, '/workspace/project');
      const pkg2 = manager.getOrCreatePackageNode('com.example', parent, '/workspace/project');

      expect(pkg1).toBe(pkg2);
      expect(manager.packageItems.size).toBe(1);
    });

    it('should create separate packages for different names', async () => {
      const parent = await manager.getOrCreateRootProjectNode('/workspace/project');

      const pkg1 = manager.getOrCreatePackageNode('com.example', parent, '/workspace/project');
      const pkg2 = manager.getOrCreatePackageNode('org.other', parent, '/workspace/project');

      expect(pkg1).not.toBe(pkg2);
      expect(manager.packageItems.size).toBe(2);
    });
  });

  // ── cleanupIterationItems ────────────────────────────────────────

  describe('cleanupIterationItems', () => {
    it('should remove tracked iteration items from tree', () => {
      const parent = controller.createTestItem('parent', 'parent test');
      const iter1 = controller.createTestItem('iter1', 'iteration 1');
      const iter2 = controller.createTestItem('iter2', 'iteration 2');
      parent.children.add(iter1);
      parent.children.add(iter2);
      manager.testData.set(iter1, { type: 'test', className: 'Spec', testName: 'iter1' });
      manager.testData.set(iter2, { type: 'test', className: 'Spec', testName: 'iter2' });

      manager.iterationItems.set('file:///spec.groovy', [iter1, iter2]);

      manager.cleanupIterationItems('file:///spec.groovy');

      expect(manager.iterationItems.has('file:///spec.groovy')).toBe(false);
      expect(parent.children.get('iter1')).toBeUndefined();
      expect(parent.children.get('iter2')).toBeUndefined();
    });

    it('should be a no-op when no iteration items exist', () => {
      manager.cleanupIterationItems('file:///nonexistent.groovy');
      // just ensures no error is thrown
    });
  });

  // ── formatAnnotationDescription ──────────────────────────────────

  describe('formatAnnotationDescription', () => {
    it('should format display-worthy annotations', () => {
      const result = manager.formatAnnotationDescription([
        { name: 'Ignore', argument: undefined },
        { name: 'Issue', argument: '"PROJ-123"' },
      ]);
      expect(result).toBe('@Ignore @Issue("PROJ-123")');
    });

    it('should skip non-display annotations', () => {
      const result = manager.formatAnnotationDescription([
        { name: 'Unroll', argument: undefined },
      ]);
      expect(result).toBe('');
    });

    it('should return empty string for undefined/empty', () => {
      expect(manager.formatAnnotationDescription(undefined)).toBe('');
      expect(manager.formatAnnotationDescription([])).toBe('');
    });
  });

  // ── discoverTestsInFile ──────────────────────────────────────────

  describe('discoverTestsInFile', () => {
    it('should read document and parse tests', async () => {
      const uri = vscode.Uri.file('/workspace/project/src/test/groovy/MySpec.groovy');
      const file = controller.createTestItem(uri.toString(), 'MySpec.groovy', uri);
      manager.testData.set(file, { type: 'file' });

      (vscode.workspace as any).openTextDocument = vi.fn().mockResolvedValue({
        getText: () => 'class MySpec extends Specification { def "test"() {} }',
      });

      testDiscoveryService.scanClassDeclarations.mockReturnValue([]);
      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'MySpec',
          range: new vscode.Range(0, 0, 1, 0),
          isAbstract: false,
          annotations: [],
          methods: [
            { name: 'test', range: new vscode.Range(0, 0, 0, 50), isDataDriven: false, annotations: [] },
          ],
        },
      ]);

      await manager.discoverTestsInFile(file);

      expect(testDiscoveryService.parseTestsInFile).toHaveBeenCalled();
      let classCount = 0;
      file.children.forEach(() => classCount++);
      expect(classCount).toBe(1);
    });

    it('should update knownSpecBaseClasses from declarations', async () => {
      const uri = vscode.Uri.file('/workspace/project/src/test/groovy/CustomBase.groovy');
      const file = controller.createTestItem(uri.toString(), 'CustomBase.groovy', uri);
      manager.testData.set(file, { type: 'file' });

      manager.knownSpecBaseClasses.add('Specification');

      (vscode.workspace as any).openTextDocument = vi.fn().mockResolvedValue({
        getText: () => 'class CustomBase extends Specification {}',
      });

      testDiscoveryService.scanClassDeclarations.mockReturnValue([
        { name: 'CustomBase', parent: 'Specification', isAbstract: false },
      ]);
      testDiscoveryService.parseTestsInFile.mockReturnValue([]);

      await manager.discoverTestsInFile(file);

      expect(manager.knownSpecBaseClasses.has('CustomBase')).toBe(true);
    });

    it('should handle missing uri gracefully', async () => {
      const file = controller.createTestItem('no-uri', 'no uri');
      // uri is undefined
      await manager.discoverTestsInFile(file);
      // should not throw
    });
  });

  // ── discoverAllTests ─────────────────────────────────────────────

  describe('discoverAllTests', () => {
    it('should skip when discovery is already in progress', async () => {
      // Start first discovery (but don't resolve it immediately)
      let resolveFirst: () => void;
      const firstBlock = new Promise<void>(r => { resolveFirst = r; });

      (vscode.workspace as any).findFiles = vi.fn().mockReturnValue(firstBlock.then(() => []));
      (vscode.window as any).withProgress = vi.fn(async (_: any, task: any) => {
        return task({ report: vi.fn() });
      });

      const first = manager.discoverAllTests();

      // Second call should be guarded
      const second = manager.discoverAllTests();
      expect(logger.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('already in progress'),
      );

      resolveFirst!();
      await first;
      await second;
    });

    it('should replace existing items and clear maps', async () => {
      (vscode.workspace as any).findFiles = vi.fn().mockResolvedValue([]);
      (vscode.window as any).withProgress = vi.fn(async (_: any, task: any) => {
        return task({ report: vi.fn() });
      });

      // Pre-populate
      manager.projectItems.set('/old', controller.createTestItem('old', 'old'));
      manager.subProjectItems.set('/oldsub', controller.createTestItem('oldsub', 'oldsub'));
      manager.packageItems.set('/old:com.example', controller.createTestItem('pkg', 'com.example'));

      await manager.discoverAllTests();

      expect(manager.projectItems.size).toBe(0);
      expect(manager.subProjectItems.size).toBe(0);
      expect(manager.packageItems.size).toBe(0);
    });
  });

  // ── dispose ──────────────────────────────────────────────────────

  describe('dispose', () => {
    it('should dispose all file system watchers', () => {
      const disposeSpy1 = vi.fn();
      const disposeSpy2 = vi.fn();
      (manager as any).watchers = [{ dispose: disposeSpy1 }, { dispose: disposeSpy2 }];

      manager.dispose();

      expect(disposeSpy1).toHaveBeenCalled();
      expect(disposeSpy2).toHaveBeenCalled();
      expect((manager as any).watchers).toHaveLength(0);
    });
  });
});
