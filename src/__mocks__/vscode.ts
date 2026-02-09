/**
 * Comprehensive mock for the `vscode` module.
 * Provides stubs for all VS Code APIs used in the extension, so tests
 * can run outside the Extension Host.
 */

// --- Basic value types ---------------------------------------------------

export class Uri {
  static file(path: string): Uri {
    return new Uri('file', '', path, '', '');
  }
  static parse(value: string): Uri {
    return new Uri('file', '', value, '', '');
  }
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  get fsPath(): string {
    return this.path;
  }
  private constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export class Position {
  readonly line: number;
  readonly character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isAfter(other: Position): boolean {
    return !this.isEqual(other) && !this.isBefore(other);
  }
  translate(lineDelta?: number, characterDelta?: number): Position {
    return new Position(this.line + (lineDelta ?? 0), this.character + (characterDelta ?? 0));
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startLine: number, startChar: number, endLine: number, endChar: number);
  constructor(start: Position, end: Position);
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === 'number' && typeof b === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c!, d!);
    } else {
      this.start = a as Position;
      this.end = b as Position;
    }
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Position) {
      return !positionOrRange.isBefore(this.start) && !positionOrRange.isAfter(this.end);
    }
    return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
  }
}

export class Location {
  uri: Uri;
  range: Range;
  constructor(uri: Uri, rangeOrPosition: Range | Position) {
    this.uri = uri;
    if (rangeOrPosition instanceof Position) {
      this.range = new Range(rangeOrPosition, rangeOrPosition);
    } else {
      this.range = rangeOrPosition;
    }
  }
}

// --- Diagnostic / output -------------------------------------------------

export class Diagnostic {
  range: Range;
  message: string;
  severity: DiagnosticSeverity;
  constructor(range: Range, message: string, severity?: DiagnosticSeverity) {
    this.range = range;
    this.message = message;
    this.severity = severity ?? DiagnosticSeverity.Error;
  }
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

// --- Coverage types ------------------------------------------------------

export class TestCoverageCount {
  covered: number;
  total: number;
  constructor(covered: number, total: number) {
    this.covered = covered;
    this.total = total;
  }
}

export class FileCoverage {
  uri: Uri;
  statementCoverage: TestCoverageCount;
  branchCoverage?: TestCoverageCount;
  declarationCoverage?: TestCoverageCount;
  constructor(
    uri: Uri,
    statementCoverage: TestCoverageCount,
    branchCoverage?: TestCoverageCount,
    declarationCoverage?: TestCoverageCount,
  ) {
    this.uri = uri;
    this.statementCoverage = statementCoverage;
    this.branchCoverage = branchCoverage;
    this.declarationCoverage = declarationCoverage;
  }
}

export class StatementCoverage {
  executed: number;
  location: Position;
  branches?: BranchCoverage[];
  constructor(executed: number, location: Position, branches?: BranchCoverage[]) {
    this.executed = executed;
    this.location = location;
    this.branches = branches;
  }
}

export class BranchCoverage {
  executed: boolean;
  location?: Position;
  constructor(executed: boolean, location?: Position) {
    this.executed = executed;
    this.location = location;
  }
}

export class DeclarationCoverage {
  name: string;
  executed: number;
  location: Position;
  constructor(name: string, executed: number, location: Position) {
    this.name = name;
    this.executed = executed;
    this.location = location;
  }
}

// --- Test API stubs ------------------------------------------------------

export class TestTag {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export enum TestRunProfileKind {
  Run = 1,
  Debug = 2,
  Coverage = 3,
}

export class TestRunRequest {
  include: any[] | undefined;
  exclude: any[] | undefined;
  profile: any;
  continuous: boolean;
  constructor(include?: any[], exclude?: any[], profile?: any, continuous?: boolean) {
    this.include = include;
    this.exclude = exclude;
    this.profile = profile;
    this.continuous = continuous ?? false;
  }
}

// --- Events / disposables ------------------------------------------------

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(data: T): void {
    for (const l of this.listeners) { l(data); }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
  cancel(): void { this.token.isCancellationRequested = true; }
  dispose(): void {}
}

// --- Relative pattern ----------------------------------------------------

export class RelativePattern {
  baseUri: Uri;
  pattern: string;
  constructor(base: any, pattern: string) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : (base.uri ?? Uri.file(base));
    this.pattern = pattern;
  }
}

// --- Workspace -----------------------------------------------------------

const _configValues: Record<string, any> = {};

export const workspace = {
  isTrusted: true,
  onDidGrantWorkspaceTrust: (_listener: () => void) => ({ dispose: () => {} }),
  workspaceFolders: undefined as any[] | undefined,
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T => {
      const fullKey = section ? `${section}.${key}` : key;
      return fullKey in _configValues ? _configValues[fullKey] : (defaultValue as T);
    },
    update: async () => {},
    has: () => true,
    inspect: () => undefined,
  }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  fs: {
    readFile: async () => Buffer.from(''),
  },
  findFiles: async () => [] as Uri[],
  openTextDocument: async (uri: any) => ({ getText: () => '', uri }),
  getWorkspaceFolder: (uri: any) => {
    if (!workspace.workspaceFolders) { return undefined; }
    return workspace.workspaceFolders.find((f: any) => {
      const folderPath = f.uri?.fsPath || f.uri?.path || '';
      const filePath = uri?.fsPath || uri?.path || '';
      return filePath.startsWith(folderPath);
    });
  },
};

/** Helper for tests to set configuration values */
export function __setConfigValue(key: string, value: any): void {
  _configValues[key] = value;
}

/** Helper to reset all configuration */
export function __resetConfig(): void {
  for (const key of Object.keys(_configValues)) {
    delete _configValues[key];
  }
}

// --- Window --------------------------------------------------------------

export const window = {
  createOutputChannel: (name: string, _options?: any) => ({
    name,
    appendLine: () => {},
    append: () => {},
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
    replace: () => {},
    // LogOutputChannel methods
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    logLevel: 2, // Info
    onDidChangeLogLevel: () => ({ dispose: () => {} }),
  }),
  withProgress: async (_options: any, task: (progress: any, token: any) => any) => {
    const progress = { report: () => {} };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    return task(progress, token);
  },
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  createTerminal: () => ({
    show: () => {},
    sendText: () => {},
    dispose: () => {},
  }),
};

// --- Languages -----------------------------------------------------------

export const languages = {
  createDiagnosticCollection: () => ({
    set: () => {},
    delete: () => {},
    clear: () => {},
    dispose: () => {},
  }),
};

// --- Commands ------------------------------------------------------------

export const commands = {
  registerCommand: (command: string, callback: (...args: any[]) => any) => ({
    dispose: () => {},
  }),
  executeCommand: async () => undefined,
};

// --- Debug ---------------------------------------------------------------

export const debug = {
  startDebugging: async () => true,
  onDidStartDebugSession: () => ({ dispose: () => {} }),
  onDidTerminateDebugSession: () => ({ dispose: () => {} }),
};

// --- Tests ---------------------------------------------------------------

export const tests = {
  _controllers: [] as any[],
  createTestController: (id: string, label: string) => {
    const items = createTestItemCollection();
    const controller = {
      id,
      label,
      items,
      createTestItem: (id: string, label: string, uri?: Uri) => {
        const children = createTestItemCollection();
        return { id, label, uri, children, tags: [], range: undefined, canResolveChildren: false, busy: false, error: undefined, parent: undefined, description: undefined };
      },
      createRunProfile: (_name: string, _kind?: any, _handler?: any, _isDefault?: boolean, _tag?: any) => ({
        supportsContinuousRun: false,
        loadDetailedCoverage: undefined as any,
        dispose: () => {},
      }),
      createTestRun: (_request: any) => ({
        appendOutput: () => {},
        passed: () => {},
        failed: () => {},
        skipped: () => {},
        started: () => {},
        end: () => {},
        addCoverage: () => {},
      }),
      resolveHandler: undefined as any,
      refreshHandler: undefined as any,
      dispose: () => {},
    };
    tests._controllers.push(controller);
    return controller;
  },
};

function createTestItemCollection() {
  const map = new Map<string, any>();
  return {
    get size() { return map.size; },
    add: (item: any) => map.set(item.id, item),
    delete: (id: string) => map.delete(id),
    get: (id: string) => map.get(id),
    replace: (items: any[]) => { map.clear(); for (const item of items) { map.set(item.id, item); } },
    forEach: (cb: (item: any) => void) => map.forEach(cb),
    [Symbol.iterator]: () => map.values(),
  };
}

// --- TestMessage ---------------------------------------------------------

export class TestMessage {
  message: string;
  expectedOutput?: string;
  actualOutput?: string;
  location?: Location;
  constructor(message: string) {
    this.message = message;
  }
  static diff(message: string, expected: string, actual: string): TestMessage {
    const msg = new TestMessage(message);
    msg.expectedOutput = expected;
    msg.actualOutput = actual;
    return msg;
  }
}

// --- MarkdownString (minimal) --------------------------------------------

export class MarkdownString {
  value: string;
  isTrusted?: boolean;
  constructor(value?: string) {
    this.value = value ?? '';
  }
  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }
}
