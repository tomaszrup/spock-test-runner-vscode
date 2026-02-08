import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Uri, TestCoverageCount, StatementCoverage, Position } from '../__mocks__/vscode';
import { CoverageService, SpockFileCoverage } from '../services/CoverageService';

vi.mock('fs/promises');
const mockedFsp = vi.mocked(fsp);

function createMockLogger() {
  return {
    name: 'test',
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    replace: vi.fn(),
  } as any;
}

describe('CoverageService', () => {
  let service: CoverageService;
  let mockLogger: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    service = new CoverageService(mockLogger);
  });

  // ── findJacocoXmlReport ────────────────────────────────────────────

  describe('findJacocoXmlReport', () => {
    it('should find report at standard path', async () => {
      const expectedPath = path.join('/project', 'build', 'reports', 'jacoco', 'test', 'jacocoTestReport.xml');
      mockedFsp.access.mockImplementation(async (p: any) => {
        if (String(p) === expectedPath) { return; }
        throw new Error('ENOENT');
      });

      const result = await service.findJacocoXmlReport('/project');
      expect(result).toBe(expectedPath);
    });

    it('should find report at alternative path', async () => {
      const altPath = path.join('/project', 'build', 'reports', 'jacoco', 'jacocoTestReport.xml');
      mockedFsp.access.mockImplementation(async (p: any) => {
        if (String(p) === altPath) { return; }
        throw new Error('ENOENT');
      });

      const result = await service.findJacocoXmlReport('/project');
      expect(result).toBe(altPath);
    });

    it('should return null when no report exists', async () => {
      mockedFsp.access.mockRejectedValue(new Error('ENOENT'));
      mockedFsp.readdir.mockResolvedValue([] as any);
      const result = await service.findJacocoXmlReport('/project');
      expect(result).toBeNull();
    });

    it('should find report via recursive search as fallback', async () => {
      const jacocoDir = path.join('/project', 'build', 'reports', 'jacoco');
      const deepXml = path.join(jacocoDir, 'deep', 'report.xml');

      mockedFsp.access.mockImplementation(async (p: any) => {
        if (String(p) === jacocoDir) { return; }
        throw new Error('ENOENT');
      });

      mockedFsp.readdir.mockImplementation((async (dir: string) => {
        if (dir === jacocoDir) {
          return [{ name: 'deep', isDirectory: () => true, isFile: () => false }] as any;
        }
        if (dir === path.join(jacocoDir, 'deep')) {
          return [{ name: 'report.xml', isDirectory: () => false, isFile: () => true }] as any;
        }
        return [];
      }) as any);

      const result = await service.findJacocoXmlReport('/project');
      expect(result).toBe(deepXml);
    });

    it('should find Maven JaCoCo report at standard path', async () => {
      const expectedPath = path.join('/project', 'target', 'site', 'jacoco', 'jacoco.xml');
      mockedFsp.access.mockImplementation(async (p: any) => {
        if (String(p) === expectedPath) { return; }
        throw new Error('ENOENT');
      });

      const result = await service.findJacocoXmlReport('/project');
      expect(result).toBe(expectedPath);
    });
  });

  // ── parseJacocoReport ─────────────────────────────────────────────

  describe('parseJacocoReport', () => {
    it('should parse a valid JaCoCo XML report', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<report name="test">
  <package name="com/example">
    <sourcefile name="BowlingGame.java">
      <line nr="10" mi="0" ci="3" mb="0" cb="0"/>
      <line nr="11" mi="2" ci="0" mb="0" cb="0"/>
      <line nr="12" mi="0" ci="1" mb="1" cb="1"/>
    </sourcefile>
  </package>
</report>`;

      mockedFsp.readFile.mockResolvedValue(xml as any);

      // Mock file resolution - the source file must exist
      const sourcePath = path.join('/project', 'src', 'main', 'java', 'com', 'example', 'BowlingGame.java');
      mockedFsp.access.mockImplementation(async (p: any) => {
        if (String(p) === sourcePath) { return; }
        throw new Error('ENOENT');
      });

      const results = await service.parseJacocoReport('/report.xml', '/project');
      expect(results).toHaveLength(1);
      expect(results[0]).toBeInstanceOf(SpockFileCoverage);
      expect(results[0].details).toHaveLength(3);
    });

    it('should return empty array for report with no matching source files', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<report name="test">
  <package name="com/unknown">
    <sourcefile name="Unknown.java">
      <line nr="1" mi="0" ci="1" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;

      mockedFsp.readFile.mockResolvedValue(xml as any);
      mockedFsp.access.mockRejectedValue(new Error('ENOENT'));

      const results = await service.parseJacocoReport('/report.xml', '/project');
      expect(results).toHaveLength(0);
    });

    it('should handle branch coverage in lines', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<report name="test">
  <package name="com/example">
    <sourcefile name="Game.java">
      <line nr="5" mi="0" ci="2" mb="2" cb="3"/>
    </sourcefile>
  </package>
</report>`;

      mockedFsp.readFile.mockResolvedValue(xml as any);
      const sourcePath = path.join('/project', 'src', 'main', 'java', 'com', 'example', 'Game.java');
      mockedFsp.access.mockImplementation(async (p: any) => {
        if (String(p) === sourcePath) { return; }
        throw new Error('ENOENT');
      });

      const results = await service.parseJacocoReport('/report.xml', '/project');
      expect(results).toHaveLength(1);
      const detail = results[0].details[0] as any;
      // Should have branch coverage
      expect(detail.branches).toBeDefined();
      expect(detail.branches.length).toBe(5); // 3 covered + 2 missed
    });
  });

  // ── SpockFileCoverage ─────────────────────────────────────────────

  describe('SpockFileCoverage', () => {
    it('should store details for loadDetailedCoverage', () => {
      const uri = Uri.file('/test.java');
      const stmtCount = new TestCoverageCount(5, 10);
      const details = [new StatementCoverage(1, new Position(0, 0))];

      const cov = new SpockFileCoverage(uri, stmtCount, undefined, undefined, details);
      expect(cov.details).toBe(details);
      expect(cov.details).toHaveLength(1);
    });
  });
});
