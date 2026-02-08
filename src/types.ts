import * as vscode from 'vscode';

/**
 * Recognised Spock annotation names that influence how tests appear and run.
 */
export type SpockAnnotationName =
  | 'Ignore'
  | 'PendingFeature'
  | 'Stepwise'
  | 'IgnoreIf'
  | 'IgnoreRest'
  | 'Requires'
  | 'Timeout'
  | 'Unroll'
  | 'Issue'
  | 'Title'
  | 'Narrative'
  | 'See';

/**
 * Represents a single Spock/JUnit annotation found on a class or method.
 */
export interface SpockAnnotation {
  /** Simple name of the annotation, e.g. "Ignore" */
  name: SpockAnnotationName | string;
  /** Raw argument text inside the parentheses (if any) */
  argument?: string;
  /** 0-based line number where the annotation appears */
  line: number;
}

export interface TestData {
  type: 'project' | 'subproject' | 'file' | 'class' | 'test';
  className?: string;
  testName?: string;
  isDataDriven?: boolean;
  iterationResults?: TestIterationResult[];
}

export interface DiffInfo {
  expected: string;
  actual: string;
}

export interface TestIterationResult {
  index: number;
  displayName: string;
  parameters: Record<string, any>;
  success: boolean;
  duration: number;
  errorInfo?: { error: string; location?: vscode.Location; diff?: DiffInfo };
  output?: string;
}

export interface TestResult {
  success: boolean;
  errorInfo?: { error: string; location?: vscode.Location; diff?: DiffInfo };
  output?: string;
  testOutput?: string;
  iterationResults?: TestIterationResult[];
}

export type BuildTool = 'gradle' | 'maven';

export interface TestExecutionOptions {
  className: string;
  testName: string;
  workspacePath: string;
  buildTool: BuildTool;
  debug: boolean;
}

export interface DebugSessionOptions {
  workspacePath: string;
  className: string;
  testName: string;
  debugPort: number;
}

export interface SpockTestMethod {
  name: string;
  line: number;
  range: vscode.Range;
  isDataDriven?: boolean;
  dataIterations?: SpockDataIteration[];
  whereBlockRange?: vscode.Range;
  /** Annotations found directly above this method */
  annotations?: SpockAnnotation[];
}

export interface SpockDataIteration {
  index: number;
  dataValues: Record<string, any>;
  displayName: string;
  range: vscode.Range;
  originalMethodName: string;
}

export interface SpockTestClass {
  name: string;
  line: number;
  range: vscode.Range;
  methods: SpockTestMethod[];
  isAbstract?: boolean;
  parentClassName?: string;
  /** Annotations found directly above this class declaration */
  annotations?: SpockAnnotation[];
}
