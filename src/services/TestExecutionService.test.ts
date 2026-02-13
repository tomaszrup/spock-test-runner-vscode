import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { TestExecutionService } from './TestExecutionService';
import { createMockLogger } from '../__test_helpers__';

// --- Mocks ---------------------------------------------------------------

vi.mock('fs');
vi.mock('./ConfigurationService', () => ({
  ConfigurationService: {
    getConfig: () => ({
      debugPort: 5005,
      testTimeout: 2,       // 2 seconds — short for tests
      debugConnectionTimeout: 1,
      debugRetries: 1,
      additionalGradleArgs: [],
      additionalMavenArgs: [],
      showDiffView: false,
    }),
  },
}));
vi.mock('./BuildToolService', () => ({
  BuildToolService: {
    buildCommandArgs: (_test: string, _debug: boolean, _ws: string, _logger: any) => ['gradle', 'test', '--tests', 'MySpec.my test'],
    buildBatchCommandArgs: () => ['gradle', 'test'],
    detectBuildTool: () => 'gradle',
    findProjectRoot: () => '/project',
    getProjectName: () => 'test-project',
  },
}));
const mockStartDebugSession = vi.fn().mockResolvedValue(undefined);
vi.mock('./DebugService', () => {
  return {
    DebugService: class MockDebugService {
      findFreePort = vi.fn(async (preferredPort: number) => preferredPort);
      startDebugSession = mockStartDebugSession;
    },
  };
});

// Build a controllable fake ChildProcess
function createFakeChildProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn((signal?: string) => { proc.killed = true; });
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeChildProcess>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => fakeProc),
}));

// --- Helpers -------------------------------------------------------------

// createMockLogger imported from __test_helpers__

function createMockRun() {
  return {
    appendOutput: vi.fn(),
    passed: vi.fn(),
    failed: vi.fn(),
    skipped: vi.fn(),
    started: vi.fn(),
    end: vi.fn(),
  } as any;
}

function defaultOptions() {
  return {
    className: 'MySpec',
    testName: 'my test',
    workspacePath: '/project',
    buildTool: 'gradle' as const,
    debug: false,
  };
}

// --- Tests ---------------------------------------------------------------

describe('TestExecutionService', () => {
  let service: TestExecutionService;
  let logger: any;
  let run: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fakeProc = createFakeChildProcess();
    logger = createMockLogger();
    run = createMockRun();
    service = new TestExecutionService(logger);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── executeBatch ────────────────────────────────────────────────────

  describe('executeBatch', () => {
    it('should resolve with success when process exits 0', async () => {
      const promise = service.executeBatch({
        commandArgs: ['gradle', 'test'],
        workspacePath: '/project',
        run,
        testItems: [],
        debug: false,
      });
      fakeProc.stdout.emit('data', Buffer.from('BUILD SUCCESSFUL\n'));
      fakeProc.emit('close', 0);
      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.output).toContain('BUILD SUCCESSFUL');
    });

    it('should resolve with failure when process exits non-zero', async () => {
      const promise = service.executeBatch({
        commandArgs: ['gradle', 'test'],
        workspacePath: '/project',
        run,
        testItems: [],
        debug: false,
      });
      fakeProc.emit('close', 1);
      const result = await promise;
      expect(result.success).toBe(false);
    });

    it('should call onOutputLine for each line of stdout', async () => {
      const lines: string[] = [];
      const promise = service.executeBatch({
        commandArgs: ['gradle', 'test'],
        workspacePath: '/project',
        run,
        testItems: [],
        debug: false,
        onOutputLine: (line) => lines.push(line),
      });
      fakeProc.stdout.emit('data', Buffer.from('line1\nline2\nline3\n'));
      fakeProc.emit('close', 0);
      await promise;
      expect(lines).toEqual(['line1', 'line2', 'line3']);
    });

    it('should handle partial lines and flush on close', async () => {
      const lines: string[] = [];
      const promise = service.executeBatch({
        commandArgs: ['gradle', 'test'],
        workspacePath: '/project',
        run,
        testItems: [],
        debug: false,
        onOutputLine: (line) => lines.push(line),
      });
      fakeProc.stdout.emit('data', Buffer.from('partial'));
      fakeProc.stdout.emit('data', Buffer.from(' complete\n'));
      fakeProc.stdout.emit('data', Buffer.from('trailing'));
      fakeProc.emit('close', 0);
      await promise;
      expect(lines).toContain('partial complete');
      expect(lines).toContain('trailing');
    });

    it('should resolve cancelled when token is already cancelled', async () => {
      const token = {
        isCancellationRequested: true,
        onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
      } as any;
      const result = await service.executeBatch({
        commandArgs: ['gradle', 'test'],
        workspacePath: '/project',
        run,
        testItems: [],
        debug: false,
        token,
      });
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/cancelled/i);
    });

    it('should kill process when token fires cancellation', async () => {
      let cancelCb: (() => void) | undefined;
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn((cb: () => void) => {
          cancelCb = cb;
          return { dispose: vi.fn() };
        }),
      } as any;

      const promise = service.executeBatch({
        commandArgs: ['gradle', 'test'],
        workspacePath: '/project',
        run,
        testItems: [],
        debug: false,
        token,
      });
      token.isCancellationRequested = true;
      cancelCb!();
      fakeProc.emit('close', null);
      const result = await promise;
      expect(result.success).toBe(false);
      expect(fakeProc.kill).toHaveBeenCalled();
    });

    it('should resolve with timeout error when process exceeds timeout', async () => {
      const promise = service.executeBatch({
        commandArgs: ['gradle', 'test'],
        workspacePath: '/project',
        run,
        testItems: [],
        debug: false,
      });
      vi.advanceTimersByTime(3000);
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/timed out/i);
    });

    it('should resolve with error on process error event', async () => {
      const promise = service.executeBatch({
        commandArgs: ['gradle', 'test'],
        workspacePath: '/project',
        run,
        testItems: [],
        debug: false,
      });
      fakeProc.emit('error', new Error('spawn ENOENT'));
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.output).toContain('spawn ENOENT');
    });

    it('should append stderr to run output', async () => {
      const promise = service.executeBatch({
        commandArgs: ['gradle', 'test'],
        workspacePath: '/project',
        run,
        testItems: [],
        debug: false,
      });
      fakeProc.stderr.emit('data', Buffer.from('error text'));
      fakeProc.emit('close', 1);
      await promise;
      expect(run.appendOutput).toHaveBeenCalledWith(expect.stringContaining('error text'));
    });

    it('should start a debug session when debug=true', async () => {
      const promise = service.executeBatch({
        commandArgs: ['gradle', 'test'],
        workspacePath: '/project',
        run,
        testItems: [],
        debug: true,
      });
      await Promise.resolve();
      fakeProc.emit('close', 0);
      await promise;
      expect(mockStartDebugSession).toHaveBeenCalled();
    });
  });
});
