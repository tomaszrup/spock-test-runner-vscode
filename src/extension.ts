import * as vscode from 'vscode';
import { SpockTestController } from './testController';

export function activate(context: vscode.ExtensionContext) {
  const logger = vscode.window.createOutputChannel('Spock Test Runner', { log: true });

  // Initialize the Test Controller with shared logger.
  // The controller is self-contained — it registers run/debug/coverage profiles
  // and handles all interaction through VS Code's Test API.
  new SpockTestController(context, logger);

  context.subscriptions.push(logger);
}

export function deactivate() {}
