import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BuildToolService } from '../services/BuildToolService';

// Mock fs and ConfigurationService
vi.mock('node:fs');
vi.mock('../services/ConfigurationService', () => ({
  ConfigurationService: {
    getConfig: () => ({
      debugPort: 5005,
      testTimeout: 300,
      debugConnectionTimeout: 60,
      debugRetries: 3,
      additionalGradleArgs: [],
      additionalMavenArgs: [],
    }),
  },
}));

const mockedFs = vi.mocked(fs, { deep: true });

describe('BuildToolService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── detectBuildTool ────────────────────────────────────────────────

  describe('detectBuildTool', () => {
    it('should detect Gradle project with build.gradle', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (!String(p).endsWith('build.gradle')) throw new Error('ENOENT');
      });
      expect(await BuildToolService.detectBuildTool('/project')).toBe('gradle');
    });

    it('should detect Gradle project with build.gradle.kts', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (!String(p).endsWith('build.gradle.kts')) throw new Error('ENOENT');
      });
      expect(await BuildToolService.detectBuildTool('/project')).toBe('gradle');
    });

    it('should detect Maven project with pom.xml', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (!String(p).endsWith('pom.xml')) throw new Error('ENOENT');
      });
      expect(await BuildToolService.detectBuildTool('/project')).toBe('maven');
    });

    it('should prefer Gradle over Maven when both exist', async () => {
      mockedFs.promises.access.mockResolvedValue(undefined);
      expect(await BuildToolService.detectBuildTool('/project')).toBe('gradle');
    });

    it('should return null if no build file found', async () => {
      mockedFs.promises.access.mockRejectedValue(new Error('ENOENT'));
      expect(await BuildToolService.detectBuildTool('/project')).toBeNull();
    });
  });

  // ── isGradleProject ───────────────────────────────────────────────

  describe('isGradleProject', () => {
    it('should return true when build.gradle exists', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (!String(p).endsWith('build.gradle')) throw new Error('ENOENT');
      });
      expect(await BuildToolService.isGradleProject('/my-project')).toBe(true);
    });

    it('should return true when build.gradle.kts exists', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (!String(p).endsWith('build.gradle.kts')) throw new Error('ENOENT');
      });
      expect(await BuildToolService.isGradleProject('/my-project')).toBe(true);
    });

    it('should return false when neither exists', async () => {
      mockedFs.promises.access.mockRejectedValue(new Error('ENOENT'));
      expect(await BuildToolService.isGradleProject('/my-project')).toBe(false);
    });
  });

  // ── findGradleProjectRoot ─────────────────────────────────────────

  describe('findGradleProjectRoot', () => {
    it('should find project root at file directory level', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (String(p) !== path.join('/workspace/project', 'build.gradle')) throw new Error('ENOENT');
      });
      mockedFs.promises.stat.mockImplementation(async () => {
        throw new Error('Not a directory');
      });

      const result = await BuildToolService.findGradleProjectRoot(
        '/workspace/project/src/test/Spec.groovy',
        '/workspace'
      );
      // Should walk up and find the build.gradle
      expect(result).not.toBeNull();
    });

    it('should return null when no gradle files exist in hierarchy', async () => {
      mockedFs.promises.access.mockRejectedValue(new Error('ENOENT'));
      mockedFs.promises.stat.mockImplementation(async () => {
        throw new Error('nope');
      });

      const result = await BuildToolService.findGradleProjectRoot(
        '/workspace/src/test/Spec.groovy',
        '/workspace'
      );
      expect(result).toBeNull();
    });
  });

  // ── findGradleRootProject ─────────────────────────────────────────

  describe('findGradleRootProject', () => {
    it('should find root project with settings.gradle', async () => {
      const wsRoot = path.resolve('/workspace');
      const subDir = path.join(wsRoot, 'subproject');
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (String(p) !== path.join(wsRoot, 'settings.gradle')) throw new Error('ENOENT');
      });

      const result = await BuildToolService.findGradleRootProject(subDir, wsRoot);
      expect(result).toBe(wsRoot);
    });

    it('should find root project with settings.gradle.kts', async () => {
      const wsRoot = path.resolve('/workspace');
      const subDir = path.join(wsRoot, 'subproject');
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (String(p) !== path.join(wsRoot, 'settings.gradle.kts')) throw new Error('ENOENT');
      });

      const result = await BuildToolService.findGradleRootProject(subDir, wsRoot);
      expect(result).toBe(wsRoot);
    });

    it('should return original project path when no settings file found', async () => {
      mockedFs.promises.access.mockRejectedValue(new Error('ENOENT'));

      const result = await BuildToolService.findGradleRootProject(
        '/workspace/subproject',
        '/workspace'
      );
      expect(result).toBe('/workspace/subproject');
    });
  });

  // ── getSubprojectPrefix ───────────────────────────────────────────

  describe('getSubprojectPrefix', () => {
    it('should return empty string when subproject is root', () => {
      expect(BuildToolService.getSubprojectPrefix('/root', '/root')).toBe('');
    });

    it('should return colon-delimited prefix for single-level subproject', () => {
      const result = BuildToolService.getSubprojectPrefix('/root', path.join('/root', 'moduleA'));
      expect(result).toBe(':moduleA');
    });

    it('should return colon-delimited prefix for nested subproject', () => {
      const result = BuildToolService.getSubprojectPrefix(
        '/root',
        path.join('/root', 'parent', 'child')
      );
      expect(result).toBe(':parent:child');
    });
  });

  // ── parseSettingsGradleProjectDirs ─────────────────────────────────

  describe('parseSettingsGradleProjectDirs', () => {
    it('should parse simple include statements', () => {
      const content = `
rootProject.name = 'my-project'
include 'moduleA', 'moduleB'
`;
      const map = BuildToolService.parseSettingsGradleProjectDirs(content, '/root');
      expect(map.get(path.resolve('/root', 'moduleA'))).toBe(':moduleA');
      expect(map.get(path.resolve('/root', 'moduleB'))).toBe(':moduleB');
    });

    it('should parse include with parentheses (Kotlin DSL)', () => {
      const content = `
rootProject.name = "my-project"
include("moduleA", "moduleB")
`;
      const map = BuildToolService.parseSettingsGradleProjectDirs(content, '/root');
      expect(map.get(path.resolve('/root', 'moduleA'))).toBe(':moduleA');
      expect(map.get(path.resolve('/root', 'moduleB'))).toBe(':moduleB');
    });

    it('should parse projectDir overrides', () => {
      const content = `
rootProject.name = 'my-project'
include 'commons-alpha', 'commons-beta'
project(':commons-alpha').projectDir = file('commons/commons-alpha')
project(':commons-beta').projectDir = file('commons/commons-beta')
`;
      const map = BuildToolService.parseSettingsGradleProjectDirs(content, '/root');
      expect(map.get(path.resolve('/root', 'commons', 'commons-alpha'))).toBe(':commons-alpha');
      expect(map.get(path.resolve('/root', 'commons', 'commons-beta'))).toBe(':commons-beta');
    });

    it('should handle colon-delimited nested includes without overrides', () => {
      const content = `include 'parent:child'`;
      const map = BuildToolService.parseSettingsGradleProjectDirs(content, '/root');
      expect(map.get(path.resolve('/root', 'parent', 'child'))).toBe(':parent:child');
    });

    it('should handle multiple include lines', () => {
      const content = `
include 'alpha'
include 'beta'
include 'gamma'
`;
      const map = BuildToolService.parseSettingsGradleProjectDirs(content, '/root');
      expect(map.size).toBe(3);
      expect(map.get(path.resolve('/root', 'alpha'))).toBe(':alpha');
    });
  });

  // ── resolveSubprojectPrefix ───────────────────────────────────────

  describe('resolveSubprojectPrefix', () => {
    it('should return empty string when subproject is root', async () => {
      expect(await BuildToolService.resolveSubprojectPrefix('/root', '/root')).toBe('');
    });

    it('should resolve using projectDir overrides from settings.gradle', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (String(p).endsWith('settings.gradle')) return;
        throw new Error('ENOENT');
      });
      mockedFs.promises.readFile.mockResolvedValue(`
rootProject.name = 'sample'
include 'commons-beta'
project(':commons-beta').projectDir = file('commons/commons-beta')
`);
      const result = await BuildToolService.resolveSubprojectPrefix(
        '/root',
        path.join('/root', 'commons', 'commons-beta')
      );
      expect(result).toBe(':commons-beta');
    });

    it('should fall back to filesystem path when no settings.gradle', async () => {
      mockedFs.promises.access.mockRejectedValue(new Error('ENOENT'));
      const result = await BuildToolService.resolveSubprojectPrefix(
        '/root',
        path.join('/root', 'commons', 'commons-beta')
      );
      expect(result).toBe(':commons:commons-beta');
    });

    it('should fall back to filesystem path when project not found in settings', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (String(p).endsWith('settings.gradle')) return;
        throw new Error('ENOENT');
      });
      mockedFs.promises.readFile.mockResolvedValue(`
rootProject.name = 'sample'
include 'other-module'
`);
      const result = await BuildToolService.resolveSubprojectPrefix(
        '/root',
        path.join('/root', 'commons', 'commons-beta')
      );
      expect(result).toBe(':commons:commons-beta');
    });
  });

  // ── getProjectName ────────────────────────────────────────────────

  describe('getProjectName', () => {
    it('should extract rootProject.name from settings.gradle', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (String(p).endsWith('settings.gradle')) return;
        throw new Error('ENOENT');
      });
      mockedFs.promises.readFile.mockResolvedValue("rootProject.name = 'from-settings'");
      expect(await BuildToolService.getProjectName('/project')).toBe('from-settings');
    });

    it('should prefer settings.gradle over build.gradle for project name', async () => {
      mockedFs.promises.access.mockResolvedValue(undefined);
      mockedFs.promises.readFile.mockImplementation(async (p: any) => {
        if (String(p).endsWith('settings.gradle')) return "rootProject.name = 'settings-name'";
        return "rootProject.name = 'build-name'";
      });
      expect(await BuildToolService.getProjectName('/project')).toBe('settings-name');
    });

    it('should extract rootProject.name from build.gradle', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (String(p).endsWith('settings.gradle') || String(p).endsWith('settings.gradle.kts')) throw new Error('ENOENT');
      });
      mockedFs.promises.readFile.mockResolvedValue("rootProject.name = 'my-app'");
      expect(await BuildToolService.getProjectName('/project')).toBe('my-app');
    });

    it('should extract name = from build.gradle', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (String(p).endsWith('settings.gradle') || String(p).endsWith('settings.gradle.kts')) throw new Error('ENOENT');
      });
      mockedFs.promises.readFile.mockResolvedValue('name = "my-lib"');
      expect(await BuildToolService.getProjectName('/project')).toBe('my-lib');
    });

    it('should fallback to directory name', async () => {
      mockedFs.promises.access.mockRejectedValue(new Error('ENOENT'));
      const result = await BuildToolService.getProjectName('/workspace/my-project');
      expect(result).toBe('my-project');
    });
  });

  // ── buildCommandArgs ──────────────────────────────────────────────

  describe('buildCommandArgs', () => {
    beforeEach(() => {
      // hasGradleWrapper will check for gradlew
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        const s = String(p);
        if (s.endsWith('gradlew') || s.endsWith('gradlew.bat')) return;
        if (s.endsWith('force-tests.init.gradle')) return;
        throw new Error('ENOENT');
      });
    });

    it('should build basic test command', async () => {
      const args = await BuildToolService.buildCommandArgs('MySpec', false, '/project');
      expect(args[0]).toMatch(/gradlew/);
      expect(args).toContain('test');
      expect(args).toContain('--tests');
      expect(args.some(a => a.includes('MySpec'))).toBe(true);
    });

    it('should include --debug-jvm when debug is true', async () => {
      const args = await BuildToolService.buildCommandArgs('MySpec', true, '/project');
      expect(args).toContain('--debug-jvm');
    });

    it('should not include --debug-jvm when debug is false', async () => {
      const args = await BuildToolService.buildCommandArgs('MySpec', false, '/project');
      expect(args).not.toContain('--debug-jvm');
    });

    it('should include --init-script argument', async () => {
      const args = await BuildToolService.buildCommandArgs('MySpec', false, '/project');
      expect(args).toContain('--init-script');
    });

    it('should include --rerun-tasks for Gradle test runs', async () => {
      const args = await BuildToolService.buildCommandArgs('MySpec', false, '/project');
      expect(args).toContain('--rerun-tasks');
    });

    it('should use subproject prefix when provided', async () => {
      const args = await BuildToolService.buildCommandArgs('MySpec', false, '/project', undefined, ':submodule');
      expect(args).toContain(':submodule:test');
    });
  });

  // ── buildBatchCommandArgs ─────────────────────────────────────────

  describe('buildBatchCommandArgs', () => {
    beforeEach(() => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        const s = String(p);
        if (s.endsWith('gradlew') || s.endsWith('gradlew.bat')) return;
        if (s.endsWith('force-tests.init.gradle')) return;
        if (s.endsWith('coverage.init.gradle')) return;
        throw new Error('ENOENT');
      });
    });

    it('should build batch command with multiple test filters', async () => {
      const args = await BuildToolService.buildBatchCommandArgs(
        ['TestA', 'TestB'],
        false,
        '/project'
      );
      // Should contain --tests for each filter
      const testsFlags = args.filter(a => a === '--tests');
      expect(testsFlags.length).toBe(2);
    });

    it('should include coverage init script when coverage=true', async () => {
      const args = await BuildToolService.buildBatchCommandArgs(
        ['TestA'],
        false,
        '/project',
        undefined,
        undefined,
        { coverage: true }
      );
      expect(args).toContain('--init-script');
      // The init script path should be the coverage one
      const initIdx = args.indexOf('--init-script');
      expect(args[initIdx + 1]).toContain('coverage');
    });

    it('should include --rerun-tasks for Gradle batch runs', async () => {
      const args = await BuildToolService.buildBatchCommandArgs(
        ['TestA'],
        false,
        '/project'
      );
      expect(args).toContain('--rerun-tasks');
    });
  });

  // ── hasGradleWrapper ──────────────────────────────────────────────

  describe('hasGradleWrapper', () => {
    it('should return true when gradlew exists at project root', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (!String(p).endsWith('gradlew')) throw new Error('ENOENT');
      });
      expect(await BuildToolService.hasGradleWrapper('/project')).toBe(true);
    });

    it('should return false when no gradlew in hierarchy', async () => {
      mockedFs.promises.access.mockRejectedValue(new Error('ENOENT'));
      expect(await BuildToolService.hasGradleWrapper('/project')).toBe(false);
    });
  });

  // ── isMavenProject ────────────────────────────────────────────────

  describe('isMavenProject', () => {
    it('should return true when pom.xml exists', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (!String(p).endsWith('pom.xml')) throw new Error('ENOENT');
      });
      expect(await BuildToolService.isMavenProject('/my-project')).toBe(true);
    });

    it('should return false when pom.xml does not exist', async () => {
      mockedFs.promises.access.mockRejectedValue(new Error('ENOENT'));
      expect(await BuildToolService.isMavenProject('/my-project')).toBe(false);
    });
  });

  // ── findMavenProjectRoot ──────────────────────────────────────────

  describe('findMavenProjectRoot', () => {
    it('should find project root at file directory level', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (String(p) !== path.join('/workspace/project', 'pom.xml')) throw new Error('ENOENT');
      });
      mockedFs.promises.stat.mockImplementation(async () => {
        throw new Error('Not a directory');
      });

      const result = await BuildToolService.findMavenProjectRoot(
        '/workspace/project/src/test/Spec.groovy',
        '/workspace'
      );
      expect(result).not.toBeNull();
    });

    it('should return null when no pom.xml in hierarchy', async () => {
      mockedFs.promises.access.mockRejectedValue(new Error('ENOENT'));
      mockedFs.promises.stat.mockImplementation(async () => {
        throw new Error('nope');
      });

      const result = await BuildToolService.findMavenProjectRoot(
        '/workspace/src/test/Spec.groovy',
        '/workspace'
      );
      expect(result).toBeNull();
    });
  });

  // ── findMavenRootProject ──────────────────────────────────────────

  describe('findMavenRootProject', () => {
    it('should find root project with <modules> in pom.xml', async () => {
      const wsRoot = path.resolve('/workspace');
      const subDir = path.join(wsRoot, 'sub-module');

      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (String(p) !== path.join(wsRoot, 'pom.xml') &&
            String(p) !== path.join(subDir, 'pom.xml')) throw new Error('ENOENT');
      });
      mockedFs.promises.readFile.mockImplementation((async (p: string) => {
        if (p === path.join(wsRoot, 'pom.xml')) {
          return '<project><modules><module>sub-module</module></modules></project>';
        }
        return '<project></project>';
      }) as any);

      const result = await BuildToolService.findMavenRootProject(subDir, wsRoot);
      expect(result).toBe(wsRoot);
    });

    it('should return original path when no parent with modules found', async () => {
      mockedFs.promises.access.mockRejectedValue(new Error('ENOENT'));
      const result = await BuildToolService.findMavenRootProject('/workspace/sub', '/workspace');
      expect(result).toBe('/workspace/sub');
    });
  });

  // ── getMavenModuleName ────────────────────────────────────────────

  describe('getMavenModuleName', () => {
    it('should return empty string when module is root', () => {
      expect(BuildToolService.getMavenModuleName('/root', '/root')).toBe('');
    });

    it('should return module name for single-level submodule', () => {
      const result = BuildToolService.getMavenModuleName('/root', path.join('/root', 'sub-module'));
      expect(result).toBe('sub-module');
    });

    it('should return path with forward slashes for nested submodule', () => {
      const result = BuildToolService.getMavenModuleName(
        '/root',
        path.join('/root', 'parent', 'child')
      );
      expect(result).toBe('parent/child');
    });
  });

  // ── hasMavenWrapper ───────────────────────────────────────────────

  describe('hasMavenWrapper', () => {
    it('should return true when mvnw exists at project root', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (!String(p).endsWith('mvnw')) throw new Error('ENOENT');
      });
      expect(await BuildToolService.hasMavenWrapper('/project')).toBe(true);
    });

    it('should return true when mvnw.cmd exists at project root', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (!String(p).endsWith('mvnw.cmd')) throw new Error('ENOENT');
      });
      expect(await BuildToolService.hasMavenWrapper('/project')).toBe(true);
    });

    it('should return false when no mvnw in hierarchy', async () => {
      mockedFs.promises.access.mockRejectedValue(new Error('ENOENT'));
      expect(await BuildToolService.hasMavenWrapper('/project')).toBe(false);
    });
  });

  // ── findProjectRoot (generic) ─────────────────────────────────────

  describe('findProjectRoot', () => {
    it('should prefer Gradle project root when both exist', async () => {
      mockedFs.promises.access.mockResolvedValue(undefined);
      mockedFs.promises.stat.mockImplementation(async () => {
        throw new Error('nope');
      });

      const result = await BuildToolService.findProjectRoot(
        '/workspace/project/src/test/Spec.groovy',
        '/workspace'
      );
      expect(result).not.toBeNull();
    });

    it('should find Maven project root when no Gradle project', async () => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        if (!String(p).endsWith('pom.xml')) throw new Error('ENOENT');
      });
      mockedFs.promises.stat.mockImplementation(async () => {
        throw new Error('nope');
      });

      const result = await BuildToolService.findProjectRoot(
        '/workspace/project/src/test/Spec.groovy',
        '/workspace'
      );
      expect(result).not.toBeNull();
    });
  });

  // ── toSurefireFilter ──────────────────────────────────────────────

  describe('toSurefireFilter', () => {
    it('should convert ClassName.methodName to ClassName#methodName', () => {
      expect(BuildToolService.toSurefireFilter('MySpec.my test')).toBe('MySpec#my test');
    });

    it('should handle fully qualified class names', () => {
      expect(BuildToolService.toSurefireFilter('com.example.MySpec.my test'))
        .toBe('com.example.MySpec#my test');
    });

    it('should return unchanged if no dot', () => {
      expect(BuildToolService.toSurefireFilter('MySpec')).toBe('MySpec');
    });
    it('should escape + in method name', () => {
      expect(BuildToolService.toSurefireFilter('MySpec.#a + #b equals #c'))
        .toBe('MySpec##a . #b equals #c');
    });

    it('should escape , in method name', () => {
      expect(BuildToolService.toSurefireFilter('MySpec.data: #a, #b'))
        .toBe('MySpec#data: #a. #b');
    });
  });

  // ── escapeMethodForSurefire ────────────────────────────────────────────

  describe('escapeMethodForSurefire', () => {
    it('should return simple name unchanged', () => {
      expect(BuildToolService.escapeMethodForSurefire('simple test')).toBe('simple test');
    });

    it('should replace + with regex any-char', () => {
      expect(BuildToolService.escapeMethodForSurefire('#a + #b equals #c'))
        .toBe('#a . #b equals #c');
    });

    it('should replace , with regex any-char', () => {
      expect(BuildToolService.escapeMethodForSurefire('data: #a, #b'))
        .toBe('data: #a. #b');
    });

    it('should escape regex-special characters', () => {
      expect(BuildToolService.escapeMethodForSurefire('test (with parens)'))
        .toBe(String.raw`test \(with parens\)`);
    });

    it('should handle combination of + and regex chars', () => {
      expect(BuildToolService.escapeMethodForSurefire('calc(#a + #b) == #c'))
        .toBe(String.raw`calc\(#a . #b\) == #c`);
    });  });

  // ── buildSurefireBatchFilter ──────────────────────────────────────

  describe('buildSurefireBatchFilter', () => {
    it('should group methods by class with escaping', () => {
      const result = BuildToolService.buildSurefireBatchFilter([
        'MySpec.test1',
        'MySpec.test2',
        'OtherSpec.test3',
      ]);
      expect(result).toBe('MySpec#test1+test2,OtherSpec#test3');
    });

    it('should handle single filter', () => {
      const result = BuildToolService.buildSurefireBatchFilter(['MySpec.test1']);
      expect(result).toBe('MySpec#test1');
    });

    it('should escape + in method names so they are not treated as separators', () => {
      const result = BuildToolService.buildSurefireBatchFilter([
        'MySpec.#a + #b equals #c',
        'MySpec.simple test',
      ]);
      expect(result).toBe('MySpec##a . #b equals #c+simple test');
    });

    it('should escape , in method names so they are not treated as class separators', () => {
      const result = BuildToolService.buildSurefireBatchFilter([
        'MySpec.data: #a, #b should equal #c',
      ]);
      expect(result).toBe('MySpec#data: #a. #b should equal #c');
    });
  });

  // ── getTestResultsDir ─────────────────────────────────────────────

  describe('getTestResultsDir', () => {
    it('should return Gradle path for gradle build tool', () => {
      const result = BuildToolService.getTestResultsDir('/project', 'gradle');
      expect(result).toBe(path.join('/project', 'build', 'test-results', 'test'));
    });

    it('should return Maven path for maven build tool', () => {
      const result = BuildToolService.getTestResultsDir('/project', 'maven');
      expect(result).toBe(path.join('/project', 'target', 'surefire-reports'));
    });
  });

  // ── Maven command building ────────────────────────────────────────

  describe('buildCommandArgs with Maven', () => {
    beforeEach(() => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        const s = String(p);
        if (s.endsWith('pom.xml')) return;
        if (s.endsWith('mvnw') || s.endsWith('mvnw.cmd')) return;
        throw new Error('ENOENT');
      });
      mockedFs.promises.readFile.mockResolvedValue('<project><packaging>jar</packaging></project>' as any);
    });

    it('should build Maven test command', async () => {
      const args = await BuildToolService.buildCommandArgs('MySpec.myTest', false, '/project', undefined, undefined, 'maven');
      expect(args[0]).toMatch(/mvnw/);
      expect(args).toContain('test');
      expect(args.some(a => a.includes('-Dtest='))).toBe(true);
    });

    it('should include debug args when debug is true', async () => {
      const args = await BuildToolService.buildCommandArgs('MySpec.myTest', true, '/project', undefined, undefined, 'maven');
      expect(args.some(a => a.includes('maven.surefire.debug'))).toBe(true);
    });

    it('should use test-compile and surefire:test for pom packaging', async () => {
      mockedFs.promises.readFile.mockResolvedValue('<project><packaging>pom</packaging></project>' as any);

      const args = await BuildToolService.buildCommandArgs('MySpec.myTest', false, '/project', undefined, undefined, 'maven');

      expect(args).toContain('test-compile');
      expect(args).toContain('surefire:test');
      expect(args.filter(a => a === 'test')).toHaveLength(0);
    });
  });

  describe('buildBatchCommandArgs with Maven', () => {
    beforeEach(() => {
      mockedFs.promises.access.mockImplementation(async (p: fs.PathLike) => {
        const s = String(p);
        if (s.endsWith('pom.xml')) return;
        if (s.endsWith('mvnw') || s.endsWith('mvnw.cmd')) return;
        throw new Error('ENOENT');
      });
      mockedFs.promises.readFile.mockResolvedValue('<project><packaging>jar</packaging></project>' as any);
    });

    it('should build Maven batch command with grouped filters', async () => {
      const args = await BuildToolService.buildBatchCommandArgs(
        ['TestA.m1', 'TestA.m2', 'TestB.m3'],
        false,
        '/project',
        undefined,
        undefined,
        { coverage: false, buildTool: 'maven' }
      );
      expect(args[0]).toMatch(/mvnw/);
      expect(args).toContain('test');
      expect(args.some(a => a.includes('-Dtest='))).toBe(true);
    });

    it('should preserve dotted Spock display names when descriptors are provided', async () => {
      const args = await BuildToolService.buildBatchCommandArgs(
        ['com.example.ApiSpec.renders v1.2 response'],
        false,
        '/project',
        undefined,
        undefined,
        {
          coverage: false,
          buildTool: 'maven',
          testDescriptors: [{ className: 'com.example.ApiSpec', testName: 'renders v1.2 response' }],
        },
      );

      expect(args).toContain(String.raw`-Dtest=com.example.ApiSpec#renders v1\.2 response`);
    });

    it('should include JaCoCo goals when coverage=true', async () => {
      const args = await BuildToolService.buildBatchCommandArgs(
        ['TestA.m1'],
        false,
        '/project',
        undefined,
        undefined,
        { coverage: true, buildTool: 'maven' }
      );
      expect(args.some(a => a.includes('jacoco'))).toBe(true);
    });

    it('should include -pl when module name is provided', async () => {
      const args = await BuildToolService.buildBatchCommandArgs(
        ['TestA.m1'],
        false,
        '/project',
        undefined,
        'sub-module',
        { coverage: false, buildTool: 'maven' }
      );
      expect(args).toContain('-pl');
      expect(args).toContain('sub-module');
    });

    it('should use test-compile and surefire:test for pom packaging', async () => {
      mockedFs.promises.readFile.mockResolvedValue('<project><packaging>pom</packaging></project>' as any);

      const args = await BuildToolService.buildBatchCommandArgs(
        ['TestA.m1'],
        false,
        '/project',
        undefined,
        undefined,
        { coverage: false, buildTool: 'maven' }
      );

      expect(args).toContain('test-compile');
      expect(args).toContain('surefire:test');
      expect(args.filter(a => a === 'test')).toHaveLength(0);
    });

    it('should omit -Dtest when running a whole Maven module', async () => {
      const args = await BuildToolService.buildBatchCommandArgs(
        [],
        false,
        '/project',
        undefined,
        undefined,
        { coverage: false, buildTool: 'maven' }
      );

      expect(args).toContain('test');
      expect(args.some(a => a.startsWith('-Dtest='))).toBe(false);
    });
  });

  // ── shellEscape ─────────────────────────────────────────────────────

  describe('shellEscape', () => {
    let shellEscapeFn: typeof import('../services/BuildToolService').shellEscape;

    beforeEach(async () => {
      const mod = await import('../services/BuildToolService');
      shellEscapeFn = mod.shellEscape;
    });

    it('should wrap a simple string on Windows or return as-is on Unix', () => {
      const result = shellEscapeFn('hello');
      if (process.platform === 'win32') {
        expect(result.startsWith('"')).toBe(true);
      } else {
        // Unix: spawn uses shell: false, no quoting needed
        expect(result).toBe('hello');
      }
    });

    it('should handle strings with spaces', () => {
      const result = shellEscapeFn('hello world');
      expect(result).toContain('hello world');
    });

    it('should handle strings with double quotes', () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      // On Windows: double quotes are backslash-escaped inside double-quoted string
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const winResult = shellEscapeFn('say "hello"');
        expect(winResult).toContain(String.raw`\"`);
      } finally {
        if (origPlatform) {
          Object.defineProperty(process, 'platform', origPlatform);
        }
      }
      // On Unix: spawn uses shell: false, so no quoting is applied
      Object.defineProperty(process, 'platform', { value: 'linux' });
      try {
        const nixResult = shellEscapeFn('say "hello"');
        expect(nixResult).toBe('say "hello"');
      } finally {
        if (origPlatform) {
          Object.defineProperty(process, 'platform', origPlatform);
        }
      }
    });

    it('should handle percent signs on Windows', () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const result = shellEscapeFn('100%done');
        expect(result).toContain('%%');
      } finally {
        if (origPlatform) {
          Object.defineProperty(process, 'platform', origPlatform);
        }
      }
    });

    it('should handle exclamation marks on Windows', () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const result = shellEscapeFn('hello!');
        expect(result).toContain('^^!');
      } finally {
        if (origPlatform) {
          Object.defineProperty(process, 'platform', origPlatform);
        }
      }
    });

    it('should neutralize & on Windows by wrapping in quotes', () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const result = shellEscapeFn('test & whoami');
        expect(result.startsWith('"')).toBe(true);
        expect(result.endsWith('"')).toBe(true);
        expect(result).toContain('test & whoami');
      } finally {
        if (origPlatform) {
          Object.defineProperty(process, 'platform', origPlatform);
        }
      }
    });

    it('should handle pipe | on Windows by wrapping in quotes', () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const result = shellEscapeFn('test | dir');
        expect(result.startsWith('"')).toBe(true);
        expect(result).toContain('test | dir');
      } finally {
        if (origPlatform) {
          Object.defineProperty(process, 'platform', origPlatform);
        }
      }
    });

    it('should handle backticks', () => {
      const result = shellEscapeFn('test `whoami`');
      expect(result).toContain('test `whoami`');
    });

    it('should strip control characters on Windows', () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const result = shellEscapeFn('test\x00\x01\x02');
        expect(result).not.toContain('\x00');
        expect(result).not.toContain('\x01');
      } finally {
        if (origPlatform) {
          Object.defineProperty(process, 'platform', origPlatform);
        }
      }
    });

    it('should handle < > ^ ( ) on Windows', () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const result = shellEscapeFn('a<b>c^d(e)');
        expect(result.startsWith('"')).toBe(true);
        expect(result.endsWith('"')).toBe(true);
      } finally {
        if (origPlatform) {
          Object.defineProperty(process, 'platform', origPlatform);
        }
      }
    });

    it('should return string as-is on Unix (spawn uses shell: false)', () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'linux' });
      try {
        const result = shellEscapeFn("it's a test");
        expect(result).toBe("it's a test");
      } finally {
        if (origPlatform) {
          Object.defineProperty(process, 'platform', origPlatform);
        }
      }
    });
  });

  // ── sanitizeTestFilter ──────────────────────────────────────────────

  describe('sanitizeTestFilter', () => {
    let sanitizeTestFilterFn: typeof import('../services/BuildToolService').sanitizeTestFilter;

    beforeEach(async () => {
      const mod = await import('../services/BuildToolService');
      sanitizeTestFilterFn = mod.sanitizeTestFilter;
    });

    it('should pass through normal test names', () => {
      expect(sanitizeTestFilterFn('MySpec.my test')).toBe('MySpec.my test');
    });

    it('should strip null bytes', () => {
      expect(sanitizeTestFilterFn('test\x00name')).toBe('testname');
    });

    it('should strip ASCII control characters', () => {
      expect(sanitizeTestFilterFn('test\x01\x02\x03name')).toBe('testname');
    });

    it('should preserve spaces and tabs', () => {
      expect(sanitizeTestFilterFn('test name\there')).toBe('test name\there');
    });

    it('should strip newlines and carriage returns', () => {
      expect(sanitizeTestFilterFn('test\r\nname')).toBe('testname');
    });

    it('should log a warning when characters are stripped', () => {
      const logger = { appendLine: vi.fn() } as any;
      sanitizeTestFilterFn('test\x00name', logger);
      expect(logger.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('WARNING')
      );
    });
  });

  // ── validateExtraArgs ───────────────────────────────────────────────

  describe('validateExtraArgs', () => {
    let validateExtraArgsFn: typeof import('../services/BuildToolService').validateExtraArgs;

    beforeEach(async () => {
      const mod = await import('../services/BuildToolService');
      validateExtraArgsFn = mod.validateExtraArgs;
    });

    it('should pass through safe Gradle args', () => {
      const result = validateExtraArgsFn(['--no-daemon', '-Dkey=value'], 'gradle');
      expect(result).toEqual(['--no-daemon', '-Dkey=value']);
    });

    it('should block --init-script for Gradle', () => {
      const result = validateExtraArgsFn(['--init-script', '/tmp/evil.gradle'], 'gradle');
      expect(result).toEqual([]);
    });

    it('should block -I for Gradle', () => {
      const result = validateExtraArgsFn(['-I', '/tmp/evil.gradle'], 'gradle');
      expect(result).toEqual([]);
    });

    it('should block --file for Gradle', () => {
      const result = validateExtraArgsFn(['--file', 'evil.gradle'], 'gradle');
      expect(result).toEqual([]);
    });

    it('should block -f for Gradle', () => {
      const result = validateExtraArgsFn(['-f', 'evil.gradle'], 'gradle');
      expect(result).toEqual([]);
    });

    it('should block --project-dir for Gradle', () => {
      const result = validateExtraArgsFn(['--project-dir', '/tmp/evil'], 'gradle');
      expect(result).toEqual([]);
    });

    it('should block --init-script case-insensitively', () => {
      const result = validateExtraArgsFn(['--Init-Script', '/tmp/evil.gradle'], 'gradle');
      expect(result).toEqual([]);
    });

    it('should block -f for Maven', () => {
      const result = validateExtraArgsFn(['-f', 'evil-pom.xml'], 'maven');
      expect(result).toEqual([]);
    });

    it('should block --file for Maven', () => {
      const result = validateExtraArgsFn(['--file', 'evil-pom.xml'], 'maven');
      expect(result).toEqual([]);
    });

    it('should block --settings for Maven', () => {
      const result = validateExtraArgsFn(['--settings', '/tmp/evil-settings.xml'], 'maven');
      expect(result).toEqual([]);
    });

    it('should block --global-settings for Maven', () => {
      const result = validateExtraArgsFn(['--global-settings', '/tmp/evil.xml'], 'maven');
      expect(result).toEqual([]);
    });

    it('should pass through safe Maven args', () => {
      const result = validateExtraArgsFn(['-Dkey=value', '-o'], 'maven');
      expect(result).toEqual(['-Dkey=value', '-o']);
    });

    it('should reject args with control characters', () => {
      const result = validateExtraArgsFn(['-Dkey=val\x00ue'], 'gradle');
      expect(result).toEqual([]);
    });

    it('should reject args with newlines', () => {
      const result = validateExtraArgsFn(['-Dkey=val\nue'], 'gradle');
      expect(result).toEqual([]);
    });

    it('should log warnings for rejected args', () => {
      const logger = { appendLine: vi.fn() } as any;
      validateExtraArgsFn(['--init-script', '/tmp/evil.gradle'], 'gradle', logger);
      expect(logger.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('WARNING')
      );
    });

    it('should handle mixed safe and blocked args', () => {
      const result = validateExtraArgsFn(
        ['--no-daemon', '--init-script', '/tmp/evil.gradle', '-Dkey=value'],
        'gradle'
      );
      expect(result).toEqual(['--no-daemon', '-Dkey=value']);
    });
  });

  // ── coalesceGradleFilters ──────────────────────────────────────────

  describe('coalesceGradleFilters', () => {
    it('should return filters unchanged when no classTestCounts provided', () => {
      const filters = ['ClassA.test1', 'ClassA.test2', 'ClassB.test3'];
      expect(BuildToolService.coalesceGradleFilters(filters)).toEqual(filters);
    });

    it('should return filters unchanged when classTestCounts is empty', () => {
      const filters = ['ClassA.test1', 'ClassA.test2'];
      expect(BuildToolService.coalesceGradleFilters(filters, new Map())).toEqual(filters);
    });

    it('should coalesce to wildcard when all methods of a class are selected', () => {
      const filters = ['ClassA.test1', 'ClassA.test2', 'ClassA.test3'];
      const counts = new Map([['ClassA', 3]]);
      const result = BuildToolService.coalesceGradleFilters(filters, counts);
      expect(result).toEqual(['ClassA.*']);
    });

    it('should not coalesce when only some methods of a class are selected', () => {
      const filters = ['ClassA.test1', 'ClassA.test2'];
      const counts = new Map([['ClassA', 5]]);
      const result = BuildToolService.coalesceGradleFilters(filters, counts);
      expect(result).toEqual(['ClassA.test1', 'ClassA.test2']);
    });

    it('should coalesce some classes and keep others as individual filters', () => {
      const filters = [
        'ClassA.test1', 'ClassA.test2',
        'ClassB.testX', 'ClassB.testY', 'ClassB.testZ',
      ];
      const counts = new Map([['ClassA', 5], ['ClassB', 3]]);
      const result = BuildToolService.coalesceGradleFilters(filters, counts);
      // ClassA has 2/5 selected → keep individual; ClassB has 3/3 → wildcard
      expect(result).toEqual(['ClassA.test1', 'ClassA.test2', 'ClassB.*']);
    });

    it('should handle single-method classes', () => {
      const filters = ['Solo.onlyTest'];
      const counts = new Map([['Solo', 1]]);
      const result = BuildToolService.coalesceGradleFilters(filters, counts);
      expect(result).toEqual(['Solo.*']);
    });

    it('should log when coalescing occurs', () => {
      const filters = ['ClassA.test1', 'ClassA.test2'];
      const counts = new Map([['ClassA', 2]]);
      const logger = { appendLine: vi.fn() } as any;
      BuildToolService.coalesceGradleFilters(filters, counts, logger);
      expect(logger.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('Coalesced 1 class(es)')
      );
    });

    it('should coalesce fully qualified class names when descriptors are provided', () => {
      const filters = ['com.example.ClassA.test1', 'com.example.ClassA.test2'];
      const counts = new Map([['com.example.ClassA', 2]]);
      const result = BuildToolService.coalesceGradleFilters(filters, counts, undefined, [
        { className: 'com.example.ClassA', testName: 'test1' },
        { className: 'com.example.ClassA', testName: 'test2' },
      ]);
      expect(result).toEqual(['com.example.ClassA.*']);
    });
  });

  // ── splitGradleTestFilters ──────────────────────────────────────────

  describe('splitGradleTestFilters', () => {
    const baseArgs = ['gradlew.bat', 'test', '--rerun-tasks', '--init-script', '"path/to/init.gradle"'];

    it('should return single batch when everything fits', () => {
      const filters = ['ClassA.test1', 'ClassB.test2'];
      const result = BuildToolService.splitGradleTestFilters(filters, baseArgs, 10000);
      expect(result).toEqual([filters]);
    });

    it('should split into multiple batches when exceeding limit', () => {
      // Create many filters that exceed a small limit
      const filters = Array.from({ length: 50 }, (_, i) => `com.example.MyLongClassName.test method number ${i}`);
      const result = BuildToolService.splitGradleTestFilters(filters, baseArgs, 500);
      expect(result.length).toBeGreaterThan(1);
      // All filters should be present across batches
      const allFilters = result.flat();
      expect(allFilters).toEqual(filters);
    });

    it('should put at least one filter per batch even if it alone exceeds limit', () => {
      const filters = ['VeryLongClassName.very long test method name that is quite long'];
      const result = BuildToolService.splitGradleTestFilters(filters, baseArgs, 10);
      expect(result).toEqual([filters]);
    });

    it('should handle empty filter list', () => {
      const result = BuildToolService.splitGradleTestFilters([], baseArgs, 10000);
      expect(result).toEqual([[]]);
    });

    it('should respect platform-specific max length', () => {
      const maxLen = BuildToolService.getMaxCommandLineLength();
      // On any platform, should return a positive number
      expect(maxLen).toBeGreaterThan(0);
    });
  });

  // ── estimateGradleArgsLength ───────────────────────────────────────

  describe('estimateGradleArgsLength', () => {
    it('should estimate length including --tests args', () => {
      const baseArgs = ['gradlew.bat', 'test'];
      const filters = ['ClassA.test1'];
      const len = BuildToolService.estimateGradleArgsLength(baseArgs, filters);
      expect(len).toBeGreaterThan('gradlew.bat test'.length);
    });

    it('should grow linearly with filter count', () => {
      const baseArgs = ['gradlew.bat', 'test'];
      const len1 = BuildToolService.estimateGradleArgsLength(baseArgs, ['A.t1']);
      const len2 = BuildToolService.estimateGradleArgsLength(baseArgs, ['A.t1', 'B.t2']);
      expect(len2).toBeGreaterThan(len1);
    });
  });
});
