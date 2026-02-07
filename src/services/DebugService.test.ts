import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DebugService } from '../services/DebugService';

vi.mock('fs');
vi.mock('net', () => {
  const MockSocket = vi.fn().mockImplementation(() => ({
    setTimeout: vi.fn(),
    connect: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
  }));
  return { Socket: MockSocket };
});
vi.mock('../services/ConfigurationService', () => ({
  ConfigurationService: {
    getConfig: () => ({
      debugPort: 5005,
      testTimeout: 300,
      debugConnectionTimeout: 1, // short timeout for tests
      debugRetries: 1,
      additionalGradleArgs: [],
      logLevel: 'info',
    }),
  },
}));
vi.mock('../services/BuildToolService', () => ({
  BuildToolService: {
    getProjectName: () => 'test-project',
  },
}));

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

describe('DebugService', () => {
  let service: DebugService;
  let mockLogger: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    service = new DebugService(mockLogger);
  });

  describe('constructor', () => {
    it('should create a DebugService instance', () => {
      expect(service).toBeDefined();
    });
  });

  describe('startDebugSession', () => {
    it('should throw when JVM port is not available', async () => {
      // With a 1-second timeout and no port, it should timeout
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
