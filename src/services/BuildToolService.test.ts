import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BuildToolService } from '../services/BuildToolService';

// Mock fs and ConfigurationService
vi.mock('fs');
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

const mockedFs = vi.mocked(fs);

describe('BuildToolService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── detectBuildTool ────────────────────────────────────────────────

  describe('detectBuildTool', () => {
    it('should detect Gradle project with build.gradle', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p).endsWith('build.gradle');
      });
      expect(BuildToolService.detectBuildTool('/project')).toBe('gradle');
    });

    it('should detect Gradle project with build.gradle.kts', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p).endsWith('build.gradle.kts');
      });
      expect(BuildToolService.detectBuildTool('/project')).toBe('gradle');
    });

    it('should detect Maven project with pom.xml', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p).endsWith('pom.xml');
      });
      expect(BuildToolService.detectBuildTool('/project')).toBe('maven');
    });

    it('should prefer Gradle over Maven when both exist', () => {
      mockedFs.existsSync.mockReturnValue(true);
      expect(BuildToolService.detectBuildTool('/project')).toBe('gradle');
    });

    it('should return null if no build file found', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(BuildToolService.detectBuildTool('/project')).toBeNull();
    });
  });

  // ── isGradleProject ───────────────────────────────────────────────

  describe('isGradleProject', () => {
    it('should return true when build.gradle exists', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('build.gradle')
      );
      expect(BuildToolService.isGradleProject('/my-project')).toBe(true);
    });

    it('should return true when build.gradle.kts exists', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('build.gradle.kts')
      );
      expect(BuildToolService.isGradleProject('/my-project')).toBe(true);
    });

    it('should return false when neither exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(BuildToolService.isGradleProject('/my-project')).toBe(false);
    });
  });

  // ── findGradleProjectRoot ─────────────────────────────────────────

  describe('findGradleProjectRoot', () => {
    it('should find project root at file directory level', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p) === path.join('/workspace/project', 'build.gradle')
      );
      mockedFs.statSync.mockImplementation(() => {
        throw new Error('Not a directory');
      });

      const result = BuildToolService.findGradleProjectRoot(
        '/workspace/project/src/test/Spec.groovy',
        '/workspace'
      );
      // Should walk up and find the build.gradle
      expect(result).not.toBeNull();
    });

    it('should return null when no gradle files exist in hierarchy', () => {
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.statSync.mockImplementation(() => {
        throw new Error('nope');
      });

      const result = BuildToolService.findGradleProjectRoot(
        '/workspace/src/test/Spec.groovy',
        '/workspace'
      );
      expect(result).toBeNull();
    });
  });

  // ── findGradleRootProject ─────────────────────────────────────────

  describe('findGradleRootProject', () => {
    it('should find root project with settings.gradle', () => {
      const wsRoot = path.resolve('/workspace');
      const subDir = path.join(wsRoot, 'subproject');
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p) === path.join(wsRoot, 'settings.gradle')
      );

      const result = BuildToolService.findGradleRootProject(subDir, wsRoot);
      expect(result).toBe(wsRoot);
    });

    it('should find root project with settings.gradle.kts', () => {
      const wsRoot = path.resolve('/workspace');
      const subDir = path.join(wsRoot, 'subproject');
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p) === path.join(wsRoot, 'settings.gradle.kts')
      );

      const result = BuildToolService.findGradleRootProject(subDir, wsRoot);
      expect(result).toBe(wsRoot);
    });

    it('should return original project path when no settings file found', () => {
      mockedFs.existsSync.mockReturnValue(false);

      const result = BuildToolService.findGradleRootProject(
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

  // ── getProjectName ────────────────────────────────────────────────

  describe('getProjectName', () => {
    it('should extract rootProject.name from build.gradle', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue("rootProject.name = 'my-app'");
      expect(BuildToolService.getProjectName('/project')).toBe('my-app');
    });

    it('should extract name = from build.gradle', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('name = "my-lib"');
      expect(BuildToolService.getProjectName('/project')).toBe('my-lib');
    });

    it('should fallback to directory name', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const result = BuildToolService.getProjectName('/workspace/my-project');
      expect(result).toBe('my-project');
    });
  });

  // ── buildCommandArgs ──────────────────────────────────────────────

  describe('buildCommandArgs', () => {
    beforeEach(() => {
      // hasGradleWrapper will check for gradlew
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.endsWith('gradlew') || s.endsWith('gradlew.bat')) {return true;}
        if (s.endsWith('force-tests.init.gradle')) {return true;}
        return false;
      });
    });

    it('should build basic test command', () => {
      const args = BuildToolService.buildCommandArgs('MySpec', false, '/project');
      expect(args[0]).toMatch(/gradlew/);
      expect(args).toContain('test');
      expect(args).toContain('--tests');
      expect(args).toContain('MySpec');
      expect(args).toContain('--stacktrace');
    });

    it('should include --debug-jvm when debug is true', () => {
      const args = BuildToolService.buildCommandArgs('MySpec', true, '/project');
      expect(args).toContain('--debug-jvm');
    });

    it('should not include --debug-jvm when debug is false', () => {
      const args = BuildToolService.buildCommandArgs('MySpec', false, '/project');
      expect(args).not.toContain('--debug-jvm');
    });

    it('should include --init-script argument', () => {
      const args = BuildToolService.buildCommandArgs('MySpec', false, '/project');
      expect(args).toContain('--init-script');
    });

    it('should use subproject prefix when provided', () => {
      const args = BuildToolService.buildCommandArgs('MySpec', false, '/project', undefined, ':submodule');
      expect(args).toContain(':submodule:test');
    });
  });

  // ── buildBatchCommandArgs ─────────────────────────────────────────

  describe('buildBatchCommandArgs', () => {
    beforeEach(() => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.endsWith('gradlew') || s.endsWith('gradlew.bat')) {return true;}
        if (s.endsWith('force-tests.init.gradle')) {return true;}
        if (s.endsWith('coverage.init.gradle')) {return true;}
        return false;
      });
    });

    it('should build batch command with multiple test filters', () => {
      const args = BuildToolService.buildBatchCommandArgs(
        ['TestA', 'TestB'],
        false,
        '/project'
      );
      // Should contain --tests for each filter
      const testsFlags = args.filter(a => a === '--tests');
      expect(testsFlags.length).toBe(2);
    });

    it('should include coverage init script when coverage=true', () => {
      const args = BuildToolService.buildBatchCommandArgs(
        ['TestA'],
        false,
        '/project',
        undefined,
        undefined,
        true
      );
      expect(args).toContain('--init-script');
      // The init script path should be the coverage one
      const initIdx = args.indexOf('--init-script');
      expect(args[initIdx + 1]).toContain('coverage');
    });
  });

  // ── hasGradleWrapper ──────────────────────────────────────────────

  describe('hasGradleWrapper', () => {
    it('should return true when gradlew exists at project root', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('gradlew')
      );
      expect(BuildToolService.hasGradleWrapper('/project')).toBe(true);
    });

    it('should return false when no gradlew in hierarchy', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(BuildToolService.hasGradleWrapper('/project')).toBe(false);
    });
  });

  // ── isMavenProject ────────────────────────────────────────────────

  describe('isMavenProject', () => {
    it('should return true when pom.xml exists', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('pom.xml')
      );
      expect(BuildToolService.isMavenProject('/my-project')).toBe(true);
    });

    it('should return false when pom.xml does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(BuildToolService.isMavenProject('/my-project')).toBe(false);
    });
  });

  // ── findMavenProjectRoot ──────────────────────────────────────────

  describe('findMavenProjectRoot', () => {
    it('should find project root at file directory level', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p) === path.join('/workspace/project', 'pom.xml')
      );
      mockedFs.statSync.mockImplementation(() => {
        throw new Error('Not a directory');
      });

      const result = BuildToolService.findMavenProjectRoot(
        '/workspace/project/src/test/Spec.groovy',
        '/workspace'
      );
      expect(result).not.toBeNull();
    });

    it('should return null when no pom.xml in hierarchy', () => {
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.statSync.mockImplementation(() => {
        throw new Error('nope');
      });

      const result = BuildToolService.findMavenProjectRoot(
        '/workspace/src/test/Spec.groovy',
        '/workspace'
      );
      expect(result).toBeNull();
    });
  });

  // ── findMavenRootProject ──────────────────────────────────────────

  describe('findMavenRootProject', () => {
    it('should find root project with <modules> in pom.xml', () => {
      const wsRoot = path.resolve('/workspace');
      const subDir = path.join(wsRoot, 'sub-module');

      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p) === path.join(wsRoot, 'pom.xml') ||
        String(p) === path.join(subDir, 'pom.xml')
      );
      mockedFs.readFileSync.mockImplementation(((p: string) => {
        if (p === path.join(wsRoot, 'pom.xml')) {
          return '<project><modules><module>sub-module</module></modules></project>';
        }
        return '<project></project>';
      }) as any);

      const result = BuildToolService.findMavenRootProject(subDir, wsRoot);
      expect(result).toBe(wsRoot);
    });

    it('should return original path when no parent with modules found', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const result = BuildToolService.findMavenRootProject('/workspace/sub', '/workspace');
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
    it('should return true when mvnw exists at project root', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('mvnw')
      );
      expect(BuildToolService.hasMavenWrapper('/project')).toBe(true);
    });

    it('should return true when mvnw.cmd exists at project root', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('mvnw.cmd')
      );
      expect(BuildToolService.hasMavenWrapper('/project')).toBe(true);
    });

    it('should return false when no mvnw in hierarchy', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(BuildToolService.hasMavenWrapper('/project')).toBe(false);
    });
  });

  // ── findProjectRoot (generic) ─────────────────────────────────────

  describe('findProjectRoot', () => {
    it('should prefer Gradle project root when both exist', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockImplementation(() => {
        throw new Error('nope');
      });

      const result = BuildToolService.findProjectRoot(
        '/workspace/project/src/test/Spec.groovy',
        '/workspace'
      );
      expect(result).not.toBeNull();
    });

    it('should find Maven project root when no Gradle project', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p).endsWith('pom.xml');
      });
      mockedFs.statSync.mockImplementation(() => {
        throw new Error('nope');
      });

      const result = BuildToolService.findProjectRoot(
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
        .toBe('test \\(with parens\\)');
    });

    it('should handle combination of + and regex chars', () => {
      expect(BuildToolService.escapeMethodForSurefire('calc(#a + #b) == #c'))
        .toBe('calc\\(#a . #b\\) == #c');
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
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.endsWith('pom.xml')) { return true; }
        if (s.endsWith('mvnw') || s.endsWith('mvnw.cmd')) { return true; }
        return false;
      });
    });

    it('should build Maven test command', () => {
      const args = BuildToolService.buildCommandArgs('MySpec.myTest', false, '/project', undefined, undefined, 'maven');
      expect(args[0]).toMatch(/mvnw/);
      expect(args).toContain('test');
      expect(args.some(a => a.includes('-Dtest='))).toBe(true);
    });

    it('should include debug args when debug is true', () => {
      const args = BuildToolService.buildCommandArgs('MySpec.myTest', true, '/project', undefined, undefined, 'maven');
      expect(args.some(a => a.includes('maven.surefire.debug'))).toBe(true);
    });
  });

  describe('buildBatchCommandArgs with Maven', () => {
    beforeEach(() => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.endsWith('pom.xml')) { return true; }
        if (s.endsWith('mvnw') || s.endsWith('mvnw.cmd')) { return true; }
        return false;
      });
    });

    it('should build Maven batch command with grouped filters', () => {
      const args = BuildToolService.buildBatchCommandArgs(
        ['TestA.m1', 'TestA.m2', 'TestB.m3'],
        false,
        '/project',
        undefined,
        undefined,
        false,
        'maven'
      );
      expect(args[0]).toMatch(/mvnw/);
      expect(args).toContain('test');
      expect(args.some(a => a.includes('-Dtest='))).toBe(true);
    });

    it('should include JaCoCo goals when coverage=true', () => {
      const args = BuildToolService.buildBatchCommandArgs(
        ['TestA.m1'],
        false,
        '/project',
        undefined,
        undefined,
        true,
        'maven'
      );
      expect(args.some(a => a.includes('jacoco'))).toBe(true);
    });

    it('should include -pl when module name is provided', () => {
      const args = BuildToolService.buildBatchCommandArgs(
        ['TestA.m1'],
        false,
        '/project',
        undefined,
        'sub-module',
        false,
        'maven'
      );
      expect(args).toContain('-pl');
      expect(args).toContain('sub-module');
    });
  });
});
