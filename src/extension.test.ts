import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

// Mock modules before importing the module under test
vi.mock('./services/BuildToolService', () => ({
  BuildToolService: {
    findGradleProjectRoot: vi.fn().mockReturnValue('/project'),
    buildCommandArgs: vi.fn().mockReturnValue(['gradle', 'test', '--tests', 'MySpec']),
    detectBuildTool: vi.fn().mockReturnValue('gradle'),
  },
}));

vi.mock('./services/ConfigurationService', () => ({
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

vi.mock('./services/TestExecutionService', () => {
  const cls = class {
    executeTest = vi.fn().mockResolvedValue({ success: true, output: '' });
    executeBatch = vi.fn().mockResolvedValue({ success: true, output: '' });
  };
  return { TestExecutionService: cls };
});

vi.mock('./services/DebugService', () => ({
  DebugService: vi.fn().mockImplementation(() => ({
    startDebugSession: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./testController', () => ({
  SpockTestController: vi.fn(),
}));

// The extension module
import { activate } from './extension';

describe('extension', () => {
  let mockContext: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockContext = {
      subscriptions: [],
      extensionPath: '/ext',
      extensionUri: vscode.Uri.file('/ext'),
      globalState: { get: vi.fn(), update: vi.fn() },
      workspaceState: { get: vi.fn(), update: vi.fn() },
    };
  });

  describe('activate', () => {
    it('should register commands and subscriptions', () => {
      activate(mockContext);

      // Should have registered at least the 3 commands + logger + diagnostic
      expect(mockContext.subscriptions.length).toBeGreaterThanOrEqual(3);
    });

    it('should create output channel', () => {
      const spy = vi.spyOn(vscode.window, 'createOutputChannel');
      activate(mockContext);
      expect(spy).toHaveBeenCalledWith('Spock Test Runner');
    });

    it('should create diagnostic collection', () => {
      const spy = vi.spyOn(vscode.languages, 'createDiagnosticCollection');
      activate(mockContext);
      expect(spy).toHaveBeenCalledWith('spock-test-runner');
    });

    it('should register runTest command', () => {
      const spy = vi.spyOn(vscode.commands, 'registerCommand');
      activate(mockContext);
      const registeredCommands = spy.mock.calls.map(c => c[0]);
      expect(registeredCommands).toContain('spock-test-runner-vscode.runTest');
    });

    it('should register runSpecificTest command', () => {
      const spy = vi.spyOn(vscode.commands, 'registerCommand');
      activate(mockContext);
      const registeredCommands = spy.mock.calls.map(c => c[0]);
      expect(registeredCommands).toContain('spock-test-runner-vscode.runSpecificTest');
    });

    it('should register debugSpecificTest command', () => {
      const spy = vi.spyOn(vscode.commands, 'registerCommand');
      activate(mockContext);
      const registeredCommands = spy.mock.calls.map(c => c[0]);
      expect(registeredCommands).toContain('spock-test-runner-vscode.debugSpecificTest');
    });

    it('should instantiate SpockTestController', async () => {
      const mod = await vi.importMock('./testController');
      activate(mockContext);
      expect(mod.SpockTestController).toHaveBeenCalledWith(mockContext, expect.anything());
    });
  });
});
