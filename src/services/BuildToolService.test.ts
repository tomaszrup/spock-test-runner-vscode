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
      logLevel: 'info',
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
});
