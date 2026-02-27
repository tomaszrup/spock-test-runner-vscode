import * as vscode from 'vscode';
import { SpockTestController } from './testController';

let spockController: SpockTestController | undefined;

export function activate(context: vscode.ExtensionContext) {
  const logger = vscode.window.createOutputChannel('Spock Test Runner', { log: true });
  context.subscriptions.push(logger);

  // Workspace Trust gate — the extension runs build tools, which is inherently
  // dangerous in untrusted workspaces.  The package.json `capabilities` section
  // tells VS Code ≥ 1.72 to disable us outright; the runtime check below is
  // defence-in-depth for older hosts.
  if (vscode.workspace.isTrusted) {
    spockController = new SpockTestController(context, logger);
  } else {
    logger.appendLine('Workspace is not trusted — deferring controller creation.');
    void vscode.window.showWarningMessage(
      'Spock Test Runner is inactive in untrusted workspaces. Trust this workspace to enable test discovery and execution.',
    );
    const trustDisposable = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      logger.appendLine('Workspace trust granted — creating test controller.');
      spockController = new SpockTestController(context, logger);
      trustDisposable.dispose();
    });
    context.subscriptions.push(trustDisposable);
  }
}

export function deactivate() {
  spockController = undefined;
}
