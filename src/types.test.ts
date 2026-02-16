import { describe, it, expect } from 'vitest';
import { Range, Position } from './__mocks__/vscode';
import type {
  SpockAnnotation,
  TestData,
  DiffInfo,
  TestIterationResult,
  TestResult,
  BuildTool,
  TestExecutionOptions,
  DebugSessionOptions,
  SpockTestMethod,
  SpockDataIteration,
  SpockTestClass,
} from './types';

/**
 * These tests validate the TypeScript interfaces and type aliases exported
 * from types.ts.  Since they are purely structural, we verify them through
 * compile-time compatibility and runtime shape checks.
 */

describe('types', () => {
  // ── SpockAnnotation ────────────────────────────────────────────────

  describe('SpockAnnotation', () => {
    it('should accept a minimal annotation', () => {
      const anno: SpockAnnotation = { name: 'Ignore', line: 5 };
      expect(anno.name).toBe('Ignore');
      expect(anno.line).toBe(5);
      expect(anno.argument).toBeUndefined();
    });

    it('should accept an annotation with argument', () => {
      const anno: SpockAnnotation = { name: 'Timeout', argument: '10', line: 3 };
      expect(anno.argument).toBe('10');
    });
  });

  // ── TestData ───────────────────────────────────────────────────────

  describe('TestData', () => {
    it('should accept a project-level test data', () => {
      const data: TestData = { type: 'project' };
      expect(data.type).toBe('project');
    });

    it('should accept a test-level data with all fields', () => {
      const data: TestData = {
        type: 'test',
        className: 'MySpec',
        classFqn: 'com.example.MySpec',
        testName: 'my test',
        isDataDriven: true,
        iterationResults: [],
      };
      expect(data.isDataDriven).toBe(true);
      expect(data.classFqn).toBe('com.example.MySpec');
    });

    it('should accept a file-level test data', () => {
      const data: TestData = { type: 'file' };
      expect(data.type).toBe('file');
    });

    it('should accept a class-level test data', () => {
      const data: TestData = { type: 'class', className: 'CalculatorSpec' };
      expect(data.className).toBe('CalculatorSpec');
    });
  });

  // ── DiffInfo ──────────────────────────────────────────────────────

  describe('DiffInfo', () => {
    it('should hold expected and actual strings', () => {
      const diff: DiffInfo = { expected: '42', actual: '41' };
      expect(diff.expected).toBe('42');
      expect(diff.actual).toBe('41');
    });
  });

  // ── TestIterationResult ───────────────────────────────────────────

  describe('TestIterationResult', () => {
    it('should represent a passing iteration', () => {
      const result: TestIterationResult = {
        index: 0,
        displayName: 'test [a: 1, #0]',
        parameters: { a: 1 },
        success: true,
        duration: 0.05,
      };
      expect(result.success).toBe(true);
      expect(result.parameters.a).toBe(1);
    });

    it('should represent a failing iteration with error info', () => {
      const result: TestIterationResult = {
        index: 1,
        displayName: 'test [a: 2, #1]',
        parameters: { a: 2 },
        success: false,
        duration: 0.1,
        errorInfo: { error: 'expected 3 but got 2' },
      };
      expect(result.success).toBe(false);
      expect(result.errorInfo?.error).toContain('expected');
    });
  });

  // ── TestResult ────────────────────────────────────────────────────

  describe('TestResult', () => {
    it('should represent a successful result', () => {
      const r: TestResult = { success: true };
      expect(r.success).toBe(true);
    });

    it('should represent a failed result with output', () => {
      const r: TestResult = {
        success: false,
        errorInfo: { error: 'assertion failed' },
        output: 'BUILD FAILED',
        testOutput: 'some out',
      };
      expect(r.errorInfo?.error).toBe('assertion failed');
    });
  });

  // ── BuildTool ─────────────────────────────────────────────────────

  describe('BuildTool', () => {
    it('should accept gradle', () => {
      const bt: BuildTool = 'gradle';
      expect(bt).toBe('gradle');
    });

    it('should accept maven', () => {
      const bt: BuildTool = 'maven';
      expect(bt).toBe('maven');
    });
  });

  // ── TestExecutionOptions ──────────────────────────────────────────

  describe('TestExecutionOptions', () => {
    it('should accept valid execution options', () => {
      const opts: TestExecutionOptions = {
        className: 'MySpec',
        testName: 'my test',
        workspacePath: '/project',
        buildTool: 'gradle',
        debug: false,
      };
      expect(opts.buildTool).toBe('gradle');
    });
  });

  // ── DebugSessionOptions ───────────────────────────────────────────

  describe('DebugSessionOptions', () => {
    it('should accept valid debug options', () => {
      const opts: DebugSessionOptions = {
        workspacePath: '/project',
        className: 'MySpec',
        testName: 'my test',
        debugPort: 5005,
      };
      expect(opts.debugPort).toBe(5005);
    });
  });

  // ── SpockTestMethod ───────────────────────────────────────────────

  describe('SpockTestMethod', () => {
    it('should accept a minimal test method', () => {
      const method: SpockTestMethod = {
        name: 'should work',
        line: 10,
        range: new Range(10, 0, 10, 20),
      };
      expect(method.name).toBe('should work');
      expect(method.isDataDriven).toBeUndefined();
    });

    it('should accept a data-driven test method', () => {
      const method: SpockTestMethod = {
        name: 'parameterised test',
        line: 5,
        range: new Range(5, 0, 5, 30),
        isDataDriven: true,
        dataIterations: [],
        annotations: [{ name: 'Unroll', line: 4 }],
      };
      expect(method.isDataDriven).toBe(true);
    });
  });

  // ── SpockTestClass ────────────────────────────────────────────────

  describe('SpockTestClass', () => {
    it('should accept a minimal test class', () => {
      const cls: SpockTestClass = {
        name: 'MySpec',
        line: 3,
        range: new Range(3, 0, 3, 40),
        methods: [],
      };
      expect(cls.name).toBe('MySpec');
      expect(cls.isAbstract).toBeUndefined();
    });

    it('should accept an abstract class with annotations', () => {
      const cls: SpockTestClass = {
        name: 'BaseSpec',
        line: 1,
        range: new Range(1, 0, 1, 30),
        methods: [],
        isAbstract: true,
        parentClassName: 'Specification',
        annotations: [{ name: 'Stepwise', line: 0 }],
      };
      expect(cls.isAbstract).toBe(true);
      expect(cls.parentClassName).toBe('Specification');
    });
  });
});
