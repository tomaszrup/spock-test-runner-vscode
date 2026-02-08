import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

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
    it('should register subscriptions', () => {
      activate(mockContext);

      // Should have pushed the logger to subscriptions
      expect(mockContext.subscriptions.length).toBeGreaterThanOrEqual(1);
    });

    it('should create log output channel', () => {
      const spy = vi.spyOn(vscode.window, 'createOutputChannel');
      activate(mockContext);
      expect(spy).toHaveBeenCalledWith('Spock Test Runner', { log: true });
    });

    it('should instantiate SpockTestController', async () => {
      const mod = await vi.importMock('./testController');
      activate(mockContext);
      expect(mod.SpockTestController).toHaveBeenCalledWith(mockContext, expect.anything());
    });
  });
});
