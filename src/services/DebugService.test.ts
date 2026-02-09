import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import { DebugService } from '../services/DebugService';
import { Socket } from 'net';
import { createMockLogger } from '../__test_helpers__';

// ── net mock ────────────────────────────────────────────────────────────
// We store the latest mock-socket instance so individual tests can
// simulate connect / error / timeout events.
let lastMockSocket: any;

vi.mock('fs');
vi.mock('net', () => {
  const MockSocket = vi.fn().mockImplementation(() => {
    const handlers: Record<string, Function> = {};
    const instance = {
      setTimeout: vi.fn(),
      connect: vi.fn((_port: number, _host: string, cb: () => void) => {
        // store the callback so tests can invoke it
        instance._connectCb = cb;
      }),
      on: vi.fn((event: string, cb: Function) => {
        handlers[event] = cb;
      }),
      destroy: vi.fn(),
      _connectCb: null as (() => void) | null,
      _handlers: handlers,
    };
    lastMockSocket = instance;
    return instance;
  });
  return { Socket: MockSocket };
});

// ── config mock (mutable) ───────────────────────────────────────────────
let mockConfig = {
  debugPort: 5005,
  testTimeout: 300,
  debugConnectionTimeout: 1,
  debugRetries: 1,
  additionalGradleArgs: [],
};
vi.mock('../services/ConfigurationService', () => ({
  ConfigurationService: {
    getConfig: () => mockConfig,
  },
}));
vi.mock('../services/BuildToolService', () => ({
  BuildToolService: {
    getProjectName: () => 'test-project',
  },
}));

// createMockLogger imported from __test_helpers__

describe('DebugService', () => {
  let service: DebugService;
  let mockLogger: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockConfig = {
      debugPort: 5005,
      testTimeout: 300,
      debugConnectionTimeout: 1,
      debugRetries: 1,
      additionalGradleArgs: [],
    };
    mockLogger = createMockLogger();
    service = new DebugService(mockLogger);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create a DebugService instance', () => {
      expect(service).toBeDefined();
    });
  });

  // ── Port polling (waitForJvmDebugPort) ──────────────────────────────

  describe('port polling', () => {
    it('should return true after required consecutive successes', async () => {
      // Mock checkJvmDebugPort to always succeed — verifies the polling loop
      // exits after the required 2 consecutive successes.
      vi.spyOn(service as any, 'checkJvmDebugPort').mockResolvedValue(true);

      const promise = (service as any).waitForJvmDebugPort(5005, 10000);

      // Advance through enough polling intervals for 2 checks + inter-poll delays
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(1100);
      }

      const result = await promise;
      expect(result).toBe(true);
    });

    it('should return false when port never becomes available', async () => {
      // Fire 'error' on every socket creation instead of the connect callback
      const promise = (service as any).waitForJvmDebugPort(5005, 3000);

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        // Fire error on the latest socket
        if (lastMockSocket?._handlers?.error) {
          lastMockSocket._handlers.error(new Error('Connection refused'));
        }
      }

      const result = await promise;
      expect(result).toBe(false);
    });

    it('should reset consecutive count on intermittent failure', async () => {
      // success, error, success, success — count resets on error,
      // so 4 polls are needed to reach 2 consecutive successes.
      let callCount = 0;
      vi.spyOn(service as any, 'checkJvmDebugPort').mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('intermittent');
        }
        return true;
      });

      const promise = (service as any).waitForJvmDebugPort(5005, 10000);

      // Advance through enough intervals for 4 polls + inter-poll delays
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1100);
      }

      const result = await promise;
      expect(result).toBe(true);
    });

    it('should handle socket timeout as a failure', async () => {
      const promise = (service as any).waitForJvmDebugPort(5005, 3000);

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        if (lastMockSocket?._handlers?.timeout) {
          lastMockSocket._handlers.timeout();
        }
      }

      const result = await promise;
      expect(result).toBe(false);
    });
  });

  // ── Retry logic (startDebugSession) ─────────────────────────────────

  describe('retry logic', () => {
    it('should retry debug connection on failure up to maxRetries', async () => {
      mockConfig.debugRetries = 3;
      mockConfig.debugConnectionTimeout = 0; // skip port polling for this test

      // Make port polling succeed immediately
      vi.spyOn(service as any, 'waitForJvmDebugPort').mockResolvedValue(true);

      // Make attemptDebugConnection always fail
      const attemptSpy = vi.spyOn(service as any, 'attemptDebugConnection')
        .mockRejectedValue(new Error('attach failed'));

      const promise = service.startDebugSession({
        workspacePath: '/project',
        className: 'MySpec',
        testName: 'my test',
        debugPort: 5005,
      });

      // Catch immediately to prevent unhandled rejection warning
      // (the rejection fires async during timer advancement)
      const caught = promise.catch(() => {});

      // Advance through the 2-second delays between retries
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }

      await expect(promise).rejects.toThrow(/Failed to start debug session after 3 attempts/);
      await caught;
      expect(attemptSpy).toHaveBeenCalledTimes(3);
    });

    it('should succeed on second retry attempt', async () => {
      mockConfig.debugRetries = 3;

      vi.spyOn(service as any, 'waitForJvmDebugPort').mockResolvedValue(true);

      let callCount = 0;
      vi.spyOn(service as any, 'attemptDebugConnection').mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error('not yet');
        }
        // success
      });

      const promise = service.startDebugSession({
        workspacePath: '/project',
        className: 'MySpec',
        testName: 'test',
        debugPort: 5005,
      });

      // Advance through the retry delay
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }

      await expect(promise).resolves.toBeUndefined();
      expect(callCount).toBe(2);
    });
  });

  // ── Successful attach path ─────────────────────────────────────────

  describe('successful attach', () => {
    it('should start debugging with correct configuration', async () => {
      vi.spyOn(service as any, 'waitForJvmDebugPort').mockResolvedValue(true);

      // Mock vscode.debug.startDebugging to succeed
      const startDebuggingSpy = vi.spyOn(vscode.debug, 'startDebugging')
        .mockResolvedValue(true);

      const promise = service.startDebugSession({
        workspacePath: '/project',
        className: 'MySpec',
        testName: 'my test',
        debugPort: 5005,
      });

      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(startDebuggingSpy).toHaveBeenCalled();
      const debugConfig = startDebuggingSpy.mock.calls[0][1] as any;
      expect(debugConfig.type).toBe('java');
      expect(debugConfig.request).toBe('attach');
      expect(debugConfig.port).toBe(5005);
      expect(debugConfig.hostName).toBe('localhost');
      expect(debugConfig.projectName).toBe('test-project');
      expect(debugConfig.name).toContain('MySpec');
    });

    it('should include all expected source paths', async () => {
      vi.spyOn(service as any, 'waitForJvmDebugPort').mockResolvedValue(true);
      const startDebuggingSpy = vi.spyOn(vscode.debug, 'startDebugging')
        .mockResolvedValue(true);

      await service.startDebugSession({
        workspacePath: '/project',
        className: 'X',
        testName: 'y',
        debugPort: 5005,
      });

      const debugConfig = startDebuggingSpy.mock.calls[0][1] as any;
      expect(debugConfig.sourcePaths).toContain('/project');
      expect(debugConfig.sourcePaths.some((p: string) => p.includes(path.join('src', 'test', 'groovy')))).toBe(true);
      expect(debugConfig.sourcePaths.some((p: string) => p.includes(path.join('src', 'main', 'java')))).toBe(true);
      expect(debugConfig.sourcePaths.some((p: string) => p.includes(path.join('src', 'test', 'kotlin')))).toBe(true);
    });

    it('should throw when vscode.debug.startDebugging returns false', async () => {
      mockConfig.debugRetries = 1;
      vi.spyOn(service as any, 'waitForJvmDebugPort').mockResolvedValue(true);
      vi.spyOn(vscode.debug, 'startDebugging').mockResolvedValue(false);

      const promise = service.startDebugSession({
        workspacePath: '/project',
        className: 'MySpec',
        testName: 'test',
        debugPort: 5005,
      });

      // Catch immediately to prevent unhandled rejection warning
      const caught = promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(5000);

      await expect(promise).rejects.toThrow(/Failed to start debug session/);
      await caught;
    });
  });

  describe('startDebugSession', () => {
    it('should throw when JVM port is not available', async () => {
      vi.useRealTimers();
      mockConfig.debugConnectionTimeout = 0; // effectively 0ms
      // checkJvmDebugPort will try to actually connect and fail
      await expect(
        service.startDebugSession({
          workspacePath: '/project',
          className: 'MySpec',
          testName: 'my test',
          debugPort: 59999,
        })
      ).rejects.toThrow(/JVM not ready/);
    });
  });
});
