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

    // Default: trusted workspace
    (vscode.workspace as any).isTrusted = true;

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

    it('should instantiate SpockTestController in trusted workspace', async () => {
      const mod = await vi.importMock('./testController');
      activate(mockContext);
      expect(mod.SpockTestController).toHaveBeenCalledWith(mockContext, expect.anything());
    });

    it('should NOT instantiate SpockTestController in untrusted workspace', async () => {
      (vscode.workspace as any).isTrusted = false;
      const mod = await vi.importMock('./testController');
      activate(mockContext);
      expect(mod.SpockTestController).not.toHaveBeenCalled();
    });

    it('should register onDidGrantWorkspaceTrust listener in untrusted workspace', () => {
      (vscode.workspace as any).isTrusted = false;
      const spy = vi.spyOn(vscode.workspace, 'onDidGrantWorkspaceTrust' as any);
      activate(mockContext);
      expect(spy).toHaveBeenCalled();
    });

    it('should create controller when workspace trust is later granted', async () => {
      (vscode.workspace as any).isTrusted = false;
      let trustCallback: (() => void) | undefined;
      (vscode.workspace as any).onDidGrantWorkspaceTrust = (cb: () => void) => {
        trustCallback = cb;
        return { dispose: vi.fn() };
      };

      const mod = await vi.importMock('./testController');
      activate(mockContext);
      expect(mod.SpockTestController).not.toHaveBeenCalled();

      // Simulate trust being granted
      trustCallback!();
      expect(mod.SpockTestController).toHaveBeenCalledWith(mockContext, expect.anything());
    });
  });
});
