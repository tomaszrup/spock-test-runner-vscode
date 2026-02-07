import * as path from 'path';
import * as vscode from 'vscode';
import { BuildToolService } from './services/BuildToolService';
import { ConfigurationService } from './services/ConfigurationService';
import { DebugService } from './services/DebugService';
import { TestExecutionService } from './services/TestExecutionService';
import { SpockTestController } from './testController';
import { BuildTool } from './types';

export function activate(context: vscode.ExtensionContext) {
  const logger = vscode.window.createOutputChannel('Spock Test Runner');
  const diagnostic = vscode.languages.createDiagnosticCollection('spock-test-runner');
  const testExecutionService = new TestExecutionService(logger);

  // Initialize the Test Controller with shared logger
  // Note: testController is never explicitly used after creation because it's self-contained
  // and automatically registers with VS Code's Test API. VS Code will call its methods
  // when users interact with the Test Explorer UI.
  new SpockTestController(context, logger);

  // Command to run all tests in a file
  context.subscriptions.push(
    vscode.commands.registerCommand('spock-test-runner-vscode.runTest', async (uri: vscode.Uri) => {
      const filePath = uri.fsPath;
      if (!filePath.endsWith('.groovy')) {
        vscode.window.showErrorMessage('Please select a .groovy file.');
        return;
      }
      
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      const projectRoot = workspaceFolder ? BuildToolService.findGradleProjectRoot(uri.fsPath, workspaceFolder.uri.fsPath) : null;
      const testClassName = extractTestName(filePath);

      if (!workspaceFolder || !projectRoot || !testClassName) {
        vscode.window.showErrorMessage('Invalid setup: Check workspace, Gradle build tool, or file name.');
        logger.appendLine(`[ERROR] ${filePath}: Invalid setup - Workspace: ${!!workspaceFolder}, ProjectRoot: ${projectRoot}, Class: ${testClassName}`);
        return;
      }

      await runSpockTest(testClassName, null, projectRoot, logger, false);
    })
  );

  // Command to run a specific test
  context.subscriptions.push(
    vscode.commands.registerCommand('spock-test-runner-vscode.runSpecificTest', async (testClassName: string, testMethod: string, workspacePath: string, buildTool: BuildTool) => {
      logger.appendLine(`[INFO] Running test ${testClassName}.${testMethod}`);
      await runSpockTest(testClassName, testMethod, workspacePath, logger, false);
    })
  );

  // Command to debug a specific test
  context.subscriptions.push(
    vscode.commands.registerCommand('spock-test-runner-vscode.debugSpecificTest', async (testClassName: string, testMethod: string, workspacePath: string, buildTool: BuildTool) => {
      logger.appendLine(`[INFO] Debugging test ${testClassName}.${testMethod}`);
      await runSpockTest(testClassName, testMethod, workspacePath, logger, true);
    })
  );

  context.subscriptions.push(logger, diagnostic);
}

// Utility functions
function extractTestName(filePath: string): string | null {
  const fileName = path.basename(filePath, '.groovy');
  return fileName.endsWith('Spec') || fileName.endsWith('Test') ? fileName : null;
}

async function runSpockTest(
  testClassName: string, 
  testMethod: string | null, 
  workspacePath: string, 
  logger: vscode.OutputChannel,
  debug: boolean = false
) {
  const terminal = vscode.window.createTerminal('Spock Test Runner');
  terminal.show();

  // Use the service to get proper command args
  const escapedTestName = testMethod 
    ? `${testClassName}.${testMethod}` 
    : `${testClassName}`;
  
  const commandArgs = BuildToolService.buildCommandArgs(escapedTestName, debug, workspacePath, logger);

  try {
    terminal.sendText(`cd ${workspacePath}`);
    const fullCommand = commandArgs.join(' ');
    terminal.sendText(fullCommand);

    if (debug) {
      // Auto-attach the debugger after Gradle starts the JVM with --debug-jvm
      const debugService = new DebugService(logger);
      const debugPort = ConfigurationService.getConfig().debugPort;
      debugService.startDebugSession({
        workspacePath,
        className: testClassName,
        testName: testMethod || '',
        debugPort
      }).then(() => {
        logger.appendLine('[INFO] Debug session attached successfully');
      }).catch(error => {
        logger.appendLine(`[ERROR] Failed to attach debugger: ${error}`);
        vscode.window.showErrorMessage(`Failed to attach debugger: ${error instanceof Error ? error.message : error}`);
      });
    }

  } catch (error: unknown) {
    const errorMessage = `Failed to run ${testClassName}.${testMethod || ''}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    terminal.sendText(errorMessage);
    vscode.window.showErrorMessage(errorMessage);
  }
}

export function deactivate() {}
