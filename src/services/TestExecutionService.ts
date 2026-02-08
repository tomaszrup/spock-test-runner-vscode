import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestExecutionOptions, TestResult } from '../types';
import { BuildToolService } from './BuildToolService';
import { ConfigurationService } from './ConfigurationService';
import { DebugService } from './DebugService';

export class TestExecutionService {
  private logger: vscode.LogOutputChannel;
  private debugService: DebugService;

  constructor(logger: vscode.LogOutputChannel) {
    this.logger = logger;
    this.debugService = new DebugService(logger);
  }

  async executeTest(options: TestExecutionOptions, run: vscode.TestRun, testItem?: vscode.TestItem, token?: vscode.CancellationToken): Promise<TestResult> {
    return new Promise(async (resolve) => {
      let timeoutId: NodeJS.Timeout | undefined;
      let processKilled = false;
      let cancellationListener: vscode.Disposable | undefined;
      const cfg = ConfigurationService.getConfig();
      const timeoutMs = cfg.testTimeout * 1000;
      
      const fullTestName = `${options.className}.${options.testName}`;
      
      const commandArgs = BuildToolService.buildCommandArgs(
        fullTestName, 
        options.debug, 
        options.workspacePath,
        this.logger
      );

      // Start debug session if debugging
      if (options.debug) {
        // Don't await — let it connect in the background while Gradle starts.
        // DebugService.waitForJvmDebugPort polls until the configured port is open.
        this.debugService.startDebugSession({
          workspacePath: options.workspacePath,
          className: options.className,
          testName: options.testName,
          debugPort: cfg.debugPort
        }).catch(error => {
          this.logger.appendLine(`TestExecutionService: Failed to start debug session: ${error}`);
        });
      }

      this.logger.appendLine(`TestExecutionService: Executing test: ${options.className}.${options.testName}`);
      this.logger.appendLine(`TestExecutionService: Command: ${commandArgs.join(' ')}`);
      this.logger.appendLine(`TestExecutionService: Working directory: ${options.workspacePath}`);

      const childProcess = spawn(commandArgs[0], commandArgs.slice(1), {
        cwd: options.workspacePath,
        stdio: 'pipe',
        env: { ...process.env },
        shell: process.platform === 'win32'
      });

      // Wire cancellation token to kill the child process
      if (token) {
        if (token.isCancellationRequested) {
          processKilled = true;
          childProcess.kill('SIGTERM');
          resolve({ success: false, errorInfo: { error: 'Test run was cancelled' }, output: 'Test run was cancelled' });
          return;
        }
        cancellationListener = token.onCancellationRequested(() => {
          if (!childProcess.killed && !processKilled) {
            this.logger.appendLine('TestExecutionService: Cancellation requested - killing process');
            processKilled = true;
            childProcess.kill('SIGTERM');
            setTimeout(() => {
              if (!childProcess.killed) {
                childProcess.kill('SIGKILL');
              }
            }, 5000);
          }
        });
      }

      // Set up timeout
      timeoutId = setTimeout(() => {
        if (!childProcess.killed && !processKilled) {
          this.logger.appendLine(`TestExecutionService: Test timeout - killing process after ${cfg.testTimeout} seconds`);
          processKilled = true;
          childProcess.kill('SIGTERM');
          
          setTimeout(() => {
            if (!childProcess.killed) {
              this.logger.appendLine(`TestExecutionService: Force killing process with SIGKILL`);
              childProcess.kill('SIGKILL');
            }
          }, 10000);
          
          resolve({ 
            success: false, 
            errorInfo: { error: `Test execution timed out after ${cfg.testTimeout} seconds` },
            output: `Test execution timed out after ${cfg.testTimeout} seconds`
          });
        }
      }, timeoutMs);

      let output = '';
      let errorOutput = '';

      childProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        const crlfText = text.replace(/\n/g, '\r\n');
        
        if (testItem) {
          run.appendOutput(crlfText, undefined, testItem);
        } else {
          run.appendOutput(crlfText);
        }
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        errorOutput += text;
        const crlfText = text.replace(/\n/g, '\r\n');
        
        if (testItem) {
          run.appendOutput(crlfText, undefined, testItem);
        } else {
          run.appendOutput(crlfText);
        }
      });

      childProcess.on('close', (code: number | null) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        cancellationListener?.dispose();
        
        if (processKilled && token?.isCancellationRequested) {
          this.logger.appendLine('TestExecutionService: Process closed after cancellation');
          resolve({ success: false, errorInfo: { error: 'Test run was cancelled' }, output: output + errorOutput });
          return;
        }
        
        this.logger.appendLine(`TestExecutionService: Process closed with code: ${code}`);
        const success = code === 0;
        const fullOutput = output + errorOutput;
        const errorInfo = success ? undefined : this.parseTestError(fullOutput);
        
        if (!childProcess.killed && !processKilled) {
          this.logger.appendLine(`TestExecutionService: Killing remaining process...`);
          processKilled = true;
          childProcess.kill('SIGTERM');
        }
        
        resolve({ success, errorInfo, output: fullOutput });
      });

      childProcess.on('error', (error: Error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        cancellationListener?.dispose();
        
        this.logger.appendLine(`TestExecutionService: Process error: ${error.message}`);
        const errorMessage = `Process error: ${error.message}`;
        
        if (testItem) {
          run.appendOutput(errorMessage, undefined, testItem);
        } else {
          run.appendOutput(errorMessage);
        }
        
        if (!childProcess.killed && !processKilled) {
          this.logger.appendLine(`TestExecutionService: Killing process due to error...`);
          processKilled = true;
          childProcess.kill('SIGTERM');
        }
        
        resolve({ 
          success: false, 
          errorInfo: { error: error.message },
          output: errorMessage
        });
      });
    });
  }



  async executeBatch(options: {
    commandArgs: string[];
    workspacePath: string;
    run: vscode.TestRun;
    testItems: vscode.TestItem[];
    debug: boolean;
    onOutputLine?: (line: string) => void;
    token?: vscode.CancellationToken;
  }): Promise<{success: boolean; output: string}> {
    return new Promise(async (resolve) => {
      let timeoutId: NodeJS.Timeout | undefined;
      let processKilled = false;
      let cancellationListener: vscode.Disposable | undefined;

      this.logger.appendLine(`TestExecutionService: Executing batch: ${options.commandArgs.join(' ')}`);
      this.logger.appendLine(`TestExecutionService: Working directory: ${options.workspacePath}`);

      if (options.debug) {
        const batchCfg = ConfigurationService.getConfig();
        // Don't await — let it connect in the background while Gradle starts.
        // DebugService.waitForJvmDebugPort polls until the configured port is open.
        this.debugService.startDebugSession({
          workspacePath: options.workspacePath,
          className: '',
          testName: '',
          debugPort: batchCfg.debugPort
        }).catch(error => {
          this.logger.appendLine(`TestExecutionService: Failed to start debug session: ${error}`);
        });
      }

      const childProcess = spawn(options.commandArgs[0], options.commandArgs.slice(1), {
        cwd: options.workspacePath,
        stdio: 'pipe',
        env: { ...process.env },
        shell: process.platform === 'win32'
      });

      // Wire cancellation token to kill the child process
      if (options.token) {
        if (options.token.isCancellationRequested) {
          processKilled = true;
          childProcess.kill('SIGTERM');
          resolve({ success: false, output: 'Test run was cancelled' });
          return;
        }
        cancellationListener = options.token.onCancellationRequested(() => {
          if (!childProcess.killed && !processKilled) {
            this.logger.appendLine('TestExecutionService: Cancellation requested - killing batch process');
            processKilled = true;
            childProcess.kill('SIGTERM');
            setTimeout(() => {
              if (!childProcess.killed) {
                childProcess.kill('SIGKILL');
              }
            }, 5000);
          }
        });
      }

      const batchTimeoutCfg = ConfigurationService.getConfig();
      const batchTimeoutMs = batchTimeoutCfg.testTimeout * 1000;
      timeoutId = setTimeout(() => {
        if (!childProcess.killed && !processKilled) {
          this.logger.appendLine(`TestExecutionService: Batch timeout - killing process after ${batchTimeoutCfg.testTimeout} seconds`);
          processKilled = true;
          childProcess.kill('SIGTERM');
          setTimeout(() => {
            if (!childProcess.killed) {
              childProcess.kill('SIGKILL');
            }
          }, 10000);
          resolve({ success: false, output: `Test execution timed out after ${batchTimeoutCfg.testTimeout} seconds` });
        }
      }, batchTimeoutMs);

      let output = '';
      let lineBuffer = '';

      childProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        const crlfText = text.replace(/\n/g, '\r\n');
        options.run.appendOutput(crlfText);

        if (options.onOutputLine) {
          lineBuffer += text;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';
          for (const line of lines) {
            options.onOutputLine(line);
          }
        }
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        const crlfText = text.replace(/\n/g, '\r\n');
        options.run.appendOutput(crlfText);
      });

      childProcess.on('close', (code: number | null) => {
        if (timeoutId) { clearTimeout(timeoutId); }
        cancellationListener?.dispose();
        if (options.onOutputLine && lineBuffer.trim()) {
          options.onOutputLine(lineBuffer);
        }
        if (processKilled && options.token?.isCancellationRequested) {
          this.logger.appendLine('TestExecutionService: Batch process closed after cancellation');
          resolve({ success: false, output });
          return;
        }
        this.logger.appendLine(`TestExecutionService: Batch process closed with code: ${code}`);
        resolve({ success: code === 0, output });
      });

      childProcess.on('error', (error: Error) => {
        if (timeoutId) { clearTimeout(timeoutId); }
        cancellationListener?.dispose();
        this.logger.appendLine(`TestExecutionService: Batch process error: ${error.message}`);
        options.run.appendOutput(`Process error: ${error.message}`);
        resolve({ success: false, output: `Process error: ${error.message}` });
      });
    });
  }

  private parseTestError(output: string): { error: string; location?: vscode.Location } | undefined {
    const lines = output.split('\n');
    let errorMessage = 'Test execution failed';
    let location: vscode.Location | undefined;
    const stackTraceLines: string[] = [];
    let capturingStackTrace = false;
    let conditionBlock: string[] = [];
    let capturingCondition = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.includes('FAILED') && (line.includes('Test') || line.includes('Spec'))) {
        errorMessage = line.trim();
      }

      // Capture Spock condition-not-satisfied blocks (the power assert output)
      if (line.includes('Condition not satisfied:') || line.includes('Assertion failed:')) {
        capturingCondition = true;
        conditionBlock = [line.trim()];
        continue;
      }
      if (capturingCondition) {
        // Condition blocks are indented; stop at a blank or non-indented line
        if (line.match(/^\s+/) && !line.trim().startsWith('at ')) {
          conditionBlock.push(line.trimEnd());
          continue;
        } else {
          capturingCondition = false;
        }
      }

      // Capture stack trace lines
      if (line.trim().startsWith('at ')) {
        capturingStackTrace = true;
        stackTraceLines.push(line.trim());
      } else if (capturingStackTrace && (line.trim().startsWith('Caused by:') || line.trim().startsWith('...'))) {
        stackTraceLines.push(line.trim());
      } else if (capturingStackTrace && line.trim() === '') {
        // Allow blank lines within stack traces
      } else {
        capturingStackTrace = false;
      }

      // Capture exception lines
      if (line.includes('spock.lang.Specification') || line.includes('groovy.lang.MissingMethodException')) {
        errorMessage = line.trim();
      }
      if (line.includes('Exception') || line.includes('Error:')) {
        if (!line.includes('BUILD') && !line.includes('> Task')) {
          stackTraceLines.push(line.trim());
        }
      }
      
      // Extract location from stack trace
      if (line.includes('.groovy:') && line.includes('at ') && !location) {
        const match = line.match(/at\s+.*\((.+\.groovy):(\d+)\)/);
        if (match) {
          const filePath = match[1];
          const lineNumber = parseInt(match[2]) - 1;
          
          try {
            const uri = vscode.Uri.file(path.resolve(filePath));
            location = new vscode.Location(uri, new vscode.Position(lineNumber, 0));
          } catch (e) {
            // Ignore if file path is invalid
          }
        }
      }
    }

    if (errorMessage === 'Test execution failed') {
      for (const line of lines) {
        if (line.includes('Exception') || line.includes('Error') || line.includes('failed')) {
          errorMessage = line.trim();
          break;
        }
      }
    }

    // Build a comprehensive error message with condition block and stack trace
    const parts: string[] = [];
    if (conditionBlock.length > 0) {
      parts.push(conditionBlock.join('\n'));
    } else {
      parts.push(errorMessage);
    }
    if (stackTraceLines.length > 0) {
      parts.push('');
      parts.push('Stack trace:');
      parts.push(stackTraceLines.join('\n'));
    }

    const fullError = parts.join('\n');

    return { error: fullError, location };
  }
}
