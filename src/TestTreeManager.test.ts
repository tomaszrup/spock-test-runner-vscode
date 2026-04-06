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
    getSubprojectPrefix: vi.fn().mockResolvedValue(''),
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

    it('should dispose existing watchers before recreating them', () => {
      const disposeSpy = vi.fn();
      (manager as any).watchers = [{ dispose: disposeSpy }];

      const originalCreateWatcher = vscode.workspace.createFileSystemWatcher;
      try {
        (vscode.workspace as any).createFileSystemWatcher = vi.fn(() => ({
          onDidCreate: () => ({ dispose: () => {} }),
          onDidChange: () => ({ dispose: () => {} }),
          onDidDelete: () => ({ dispose: () => {} }),
          dispose: () => {},
        }));

        manager.setupFileWatchers();

        expect(disposeSpy).toHaveBeenCalled();
      } finally {
        (vscode.workspace as any).createFileSystemWatcher = originalCreateWatcher;
      }
    });

    it('should trigger full discovery when a deleted file had cached class declarations', async () => {
      const callbacks: {
        delete?: (uri: vscode.Uri) => void;
      } = {};

      const originalCreateWatcher = vscode.workspace.createFileSystemWatcher;
      try {
        (vscode.workspace as any).createFileSystemWatcher = vi.fn(() => ({
          onDidCreate: () => ({ dispose: () => {} }),
          onDidChange: () => ({ dispose: () => {} }),
          onDidDelete: (cb: (uri: vscode.Uri) => void) => {
            callbacks.delete = cb;
            return { dispose: () => {} };
          },
          dispose: () => {},
        }));

        const fullDiscoverySpy = vi.spyOn(manager, 'discoverAllTests').mockResolvedValue();
        const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/BaseSpec.groovy');
        (manager as any).fileClassDeclarations.set(fileUri.toString(), [
          { name: 'BaseSpec', parent: 'Specification', isAbstract: true },
        ]);

        manager.setupFileWatchers();
        callbacks.delete?.(fileUri);
        await Promise.resolve();

        expect(fullDiscoverySpy).toHaveBeenCalled();
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
        { name: 'Ignore', argument: undefined, line: 0 },
        { name: 'Issue', argument: '"PROJ-123"', line: 1 },
      ]);
      expect(result).toBe('@Ignore @Issue("PROJ-123")');
    });

    it('should skip non-display annotations', () => {
      const result = manager.formatAnnotationDescription([
        { name: 'Unroll', argument: undefined, line: 0 },
      ]);
      expect(result).toBe('');
    });

    it('should return empty string for undefined/empty', () => {
      expect(manager.formatAnnotationDescription(undefined)).toBe('');
      expect(manager.formatAnnotationDescription([])).toBe('');
    });
  });

  // ── Annotation-based test tags ────────────────────────────────────

  describe('annotation tags', () => {
    it('should add annotation-specific tags alongside runnable for class annotations', () => {
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
          annotations: [{ name: 'Stepwise', line: 0 }],
          methods: [
            { name: 'step one', range: new vscode.Range(2, 0, 4, 0), isDataDriven: false, annotations: [] },
          ],
        },
      ]);

      manager.parseTestsInFile(file, '@Stepwise class StepSpec extends Specification {}');

      let classNode: any;
      file.children.forEach((child: any) => { classNode = child; });

      // Class should have runnable + spock:Stepwise
      expect(classNode.tags.some((t: any) => t.id === 'runnable')).toBe(true);
      expect(classNode.tags.some((t: any) => t.id === 'spock:Stepwise')).toBe(true);

      // Child method should inherit class annotation tag
      let methodNode: any;
      classNode.children.forEach((child: any) => { methodNode = child; });
      expect(methodNode.tags.some((t: any) => t.id === 'runnable')).toBe(true);
      expect(methodNode.tags.some((t: any) => t.id === 'spock:Stepwise')).toBe(true);
    });

    it('should add annotation tags for method-level annotations', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/TimeoutSpec.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'TimeoutSpec.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.hasAnnotation.mockImplementation(
        (annotations: any, name: string) => annotations?.some((a: any) => a.name === name),
      );

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'TimeoutSpec',
          range: new vscode.Range(0, 0, 10, 0),
          isAbstract: false,
          annotations: [],
          methods: [
            { name: 'slow test', range: new vscode.Range(2, 0, 5, 0), isDataDriven: false, annotations: [{ name: 'Timeout', argument: '10', line: 1 }] },
            { name: 'fast test', range: new vscode.Range(6, 0, 9, 0), isDataDriven: false, annotations: [] },
          ],
        },
      ]);

      manager.parseTestsInFile(file, 'class TimeoutSpec extends Specification {}');

      const methods: any[] = [];
      file.children.forEach((cls: any) => cls.children.forEach((m: any) => { methods.push(m); }));

      // 'slow test' should have Timeout tag
      const slowTest = methods.find((m: any) => m.label === 'slow test');
      expect(slowTest.tags.some((t: any) => t.id === 'spock:Timeout')).toBe(true);
      expect(slowTest.tags.some((t: any) => t.id === 'runnable')).toBe(true);

      // 'fast test' should have only runnable tag
      const fastTest = methods.find((m: any) => m.label === 'fast test');
      expect(fastTest.tags.some((t: any) => t.id === 'spock:Timeout')).toBe(false);
      expect(fastTest.tags.some((t: any) => t.id === 'runnable')).toBe(true);
    });

    it('should add Ignore tag to ignored items without runnable tag', () => {
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
          annotations: [{ name: 'Ignore', line: 0 }],
          methods: [
            { name: 'test one', range: new vscode.Range(2, 0, 5, 0), isDataDriven: false, annotations: [] },
          ],
        },
      ]);

      manager.parseTestsInFile(file, '@Ignore class IgnoredSpec extends Specification {}');

      let classNode: any;
      file.children.forEach((child: any) => { classNode = child; });

      // Class should have Ignore tag but NOT runnable
      expect(classNode.tags.some((t: any) => t.id === 'runnable')).toBe(false);
      expect(classNode.tags.some((t: any) => t.id === 'spock:Ignore')).toBe(true);

      // Child method inherits: Ignore tag, no runnable
      let methodNode: any;
      classNode.children.forEach((child: any) => { methodNode = child; });
      expect(methodNode.tags.some((t: any) => t.id === 'runnable')).toBe(false);
      expect(methodNode.tags.some((t: any) => t.id === 'spock:Ignore')).toBe(true);
    });

    it('should add annotation tags to data-driven methods', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/DataSpec.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'DataSpec.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.hasAnnotation.mockImplementation(
        (annotations: any, name: string) => annotations?.some((a: any) => a.name === name),
      );

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'DataSpec',
          range: new vscode.Range(0, 0, 10, 0),
          isAbstract: false,
          annotations: [],
          methods: [
            {
              name: 'add #a + #b',
              range: new vscode.Range(2, 0, 8, 0),
              isDataDriven: true,
              annotations: [{ name: 'Timeout', argument: '5', line: 1 }],
            },
          ],
        },
      ]);

      manager.parseTestsInFile(file, 'class DataSpec extends Specification {}');

      let methodNode: any;
      file.children.forEach((cls: any) => cls.children.forEach((m: any) => { methodNode = m; }));
      expect(methodNode.tags.some((t: any) => t.id === 'runnable')).toBe(true);
      expect(methodNode.tags.some((t: any) => t.id === 'spock:Timeout')).toBe(true);
    });

    it('should not duplicate tags when class and method share the same annotation', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/DupSpec.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'DupSpec.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.hasAnnotation.mockImplementation(
        (annotations: any, name: string) => annotations?.some((a: any) => a.name === name),
      );

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'DupSpec',
          range: new vscode.Range(0, 0, 10, 0),
          isAbstract: false,
          annotations: [{ name: 'Timeout', argument: '10', line: 0 }],
          methods: [
            {
              name: 'test one',
              range: new vscode.Range(2, 0, 5, 0),
              isDataDriven: false,
              annotations: [{ name: 'Timeout', argument: '5', line: 1 }],
            },
          ],
        },
      ]);

      manager.parseTestsInFile(file, '@Timeout(10) class DupSpec extends Specification {}');

      let methodNode: any;
      file.children.forEach((cls: any) => cls.children.forEach((m: any) => { methodNode = m; }));
      const timeoutTags = methodNode.tags.filter((t: any) => t.id === 'spock:Timeout');
      expect(timeoutTags).toHaveLength(1);
    });

    it('should handle PendingFeature annotation tag', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/PendingSpec.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'PendingSpec.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.hasAnnotation.mockImplementation(
        (annotations: any, name: string) => annotations?.some((a: any) => a.name === name),
      );

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'PendingSpec',
          range: new vscode.Range(0, 0, 10, 0),
          isAbstract: false,
          annotations: [],
          methods: [
            {
              name: 'future feature',
              range: new vscode.Range(2, 0, 5, 0),
              isDataDriven: false,
              annotations: [{ name: 'PendingFeature', line: 1 }],
            },
          ],
        },
      ]);

      manager.parseTestsInFile(file, 'class PendingSpec extends Specification {}');

      let methodNode: any;
      file.children.forEach((cls: any) => cls.children.forEach((m: any) => { methodNode = m; }));
      expect(methodNode.tags.some((t: any) => t.id === 'spock:PendingFeature')).toBe(true);
      expect(methodNode.tags.some((t: any) => t.id === 'runnable')).toBe(true);
    });
  });

  // ── Pre-parsed iteration items ──────────────────────────────────

  describe('pre-parsed iteration items', () => {
    it('should create iteration children from whereBlock data', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/DataSpec.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'DataSpec.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.hasAnnotation.mockReturnValue(false);

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'DataSpec',
          range: new vscode.Range(0, 0, 20, 0),
          isAbstract: false,
          annotations: [],
          methods: [
            {
              name: 'add #a + #b',
              range: new vscode.Range(2, 0, 12, 0),
              isDataDriven: true,
              annotations: [],
              whereBlock: {
                parameterNames: ['a', 'b', 'c'],
                iterationCount: 2,
                dataRows: [['1', '2', '3'], ['4', '5', '9']],
              },
            },
          ],
        },
      ]);

      manager.parseTestsInFile(file, 'class DataSpec extends Specification {}');

      // Find the parent data-driven method
      let parentMethod: any;
      file.children.forEach((cls: any) => cls.children.forEach((m: any) => { parentMethod = m; }));
      expect(parentMethod).toBeDefined();

      // Should have 2 iteration children
      let iterations: any[] = [];
      parentMethod.children.forEach((iter: any) => { iterations.push(iter); });
      expect(iterations).toHaveLength(2);

      // First iteration
      expect(iterations[0].label).toBe('add #a + #b [#0] a: 1, b: 2, c: 3');
      expect(iterations[0].tags.some((t: any) => t.id === 'runnable')).toBe(true);
      const data0 = manager.testData.get(iterations[0]);
      expect(data0?.isPreParsedIteration).toBe(true);
      expect(data0?.iterationIndex).toBe(0);
      expect(data0?.testName).toBe('add #a + #b');

      // Second iteration
      expect(iterations[1].label).toBe('add #a + #b [#1] a: 4, b: 5, c: 9');
      const data1 = manager.testData.get(iterations[1]);
      expect(data1?.isPreParsedIteration).toBe(true);
      expect(data1?.iterationIndex).toBe(1);
    });

    it('should not create iterations when whereBlock is absent', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/DataSpec2.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'DataSpec2.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.hasAnnotation.mockReturnValue(false);

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'DataSpec2',
          range: new vscode.Range(0, 0, 10, 0),
          isAbstract: false,
          annotations: [],
          methods: [
            {
              name: 'dynamic test',
              range: new vscode.Range(2, 0, 8, 0),
              isDataDriven: true,
              annotations: [],
              // No whereBlock (couldn't be parsed statically)
            },
          ],
        },
      ]);

      manager.parseTestsInFile(file, 'class DataSpec2 extends Specification {}');

      let parentMethod: any;
      file.children.forEach((cls: any) => cls.children.forEach((m: any) => { parentMethod = m; }));
      expect(parentMethod).toBeDefined();

      let count = 0;
      parentMethod.children.forEach(() => { count++; });
      expect(count).toBe(0);
    });

    it('should not create iterations for ignored data-driven methods', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/IgnoredData.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'IgnoredData.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.hasAnnotation.mockImplementation(
        (annotations: any, name: string) => name === 'Ignore' && annotations?.some((a: any) => a.name === 'Ignore'),
      );

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'IgnoredData',
          range: new vscode.Range(0, 0, 20, 0),
          isAbstract: false,
          annotations: [{ name: 'Ignore', line: 0 }],
          methods: [
            {
              name: 'data test',
              range: new vscode.Range(2, 0, 12, 0),
              isDataDriven: true,
              annotations: [],
              whereBlock: {
                parameterNames: ['a', 'b'],
                iterationCount: 2,
                dataRows: [['1', '2'], ['3', '4']],
              },
            },
          ],
        },
      ]);

      manager.parseTestsInFile(file, '@Ignore class IgnoredData extends Specification {}');

      let parentMethod: any;
      file.children.forEach((cls: any) => cls.children.forEach((m: any) => { parentMethod = m; }));
      expect(parentMethod).toBeDefined();

      let count = 0;
      parentMethod.children.forEach(() => { count++; });
      expect(count).toBe(0);
    });

    it('should track iteration items in iterationItems map', () => {
      const fileUri = vscode.Uri.file('/workspace/project/src/test/groovy/Tracked.groovy');
      const file = controller.createTestItem(fileUri.toString(), 'Tracked.groovy', fileUri);
      manager.testData.set(file, { type: 'file' });

      testDiscoveryService.hasAnnotation.mockReturnValue(false);

      testDiscoveryService.parseTestsInFile.mockReturnValue([
        {
          name: 'Tracked',
          range: new vscode.Range(0, 0, 10, 0),
          isAbstract: false,
          annotations: [],
          methods: [
            {
              name: 'test data',
              range: new vscode.Range(2, 0, 8, 0),
              isDataDriven: true,
              annotations: [],
              whereBlock: {
                parameterNames: ['x'],
                iterationCount: 3,
                dataRows: [['1'], ['2'], ['3']],
              },
            },
          ],
        },
      ]);

      manager.parseTestsInFile(file, 'class Tracked extends Specification {}');

      const iterItems = manager.iterationItems.get(fileUri.toString());
      expect(iterItems).toBeDefined();
      expect(iterItems).toHaveLength(3);
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
      (manager as any).fileClassDeclarations.set(uri.toString(), [
        { name: 'CustomBase', parent: 'Specification', isAbstract: false },
      ]);

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

    it('should trigger full discovery when class declarations change', async () => {
      const uri = vscode.Uri.file('/workspace/project/src/test/groovy/BaseSpec.groovy');
      const file = controller.createTestItem(uri.toString(), 'BaseSpec.groovy', uri);
      manager.testData.set(file, { type: 'file' });
      (manager as any).fileClassDeclarations.set(uri.toString(), [
        { name: 'BaseSpec', parent: 'Specification', isAbstract: true },
      ]);

      (vscode.workspace as any).openTextDocument = vi.fn().mockResolvedValue({
        getText: () => 'abstract class BaseSpec extends Object {}',
      });

      testDiscoveryService.scanClassDeclarations.mockReturnValue([
        { name: 'BaseSpec', parent: 'Object', isAbstract: true },
      ]);

      const fullDiscoverySpy = vi.spyOn(manager, 'discoverAllTests').mockResolvedValue();

      await manager.discoverTestsInFile(file);

      expect(fullDiscoverySpy).toHaveBeenCalled();
      expect(testDiscoveryService.parseTestsInFile).not.toHaveBeenCalled();
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

      if (!resolveFirst) {
        throw new Error('Expected the first discovery call to remain pending');
      }
      resolveFirst();
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

    it('should refresh cached class declarations during full discovery', async () => {
      const uri = vscode.Uri.file('/workspace/project/src/test/groovy/MySpec.groovy');
      (vscode.workspace as any).findFiles = vi.fn().mockResolvedValue([uri]);
      (vscode.workspace as any).openTextDocument = vi.fn().mockResolvedValue({
        getText: () => 'class MySpec extends Specification {}',
        uri,
      });
      (vscode.window as any).withProgress = vi.fn(async (_: any, task: any) => {
        return task({ report: vi.fn() }, { isCancellationRequested: false });
      });

      testDiscoveryService.scanClassDeclarations.mockReturnValue([
        { name: 'MySpec', parent: 'Specification', isAbstract: false },
      ]);
      testDiscoveryService.resolveAllSpecBaseClasses.mockReturnValue(new Set(['Specification', 'MySpec']));
      testDiscoveryService.parseTestsInFile.mockReturnValue([]);

      await manager.discoverAllTests();

      expect((manager as any).fileClassDeclarations.get(uri.toString())).toEqual([
        { name: 'MySpec', parent: 'Specification', isAbstract: false },
      ]);
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
