import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { ConfigurationService } from './ConfigurationService';
import { DebugService } from './DebugService';

export class TestExecutionService {
  private logger: vscode.LogOutputChannel;
  private debugService: DebugService;

  constructor(logger: vscode.LogOutputChannel) {
    this.logger = logger;
    this.debugService = new DebugService(logger);
  }

  async executeBatch(options: {
    commandArgs: string[];
    workspacePath: string;
    run: vscode.TestRun;
    testItems: vscode.TestItem[];
    debug: boolean;
    debugPort?: number;
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
        let batchDebugPort = options.debugPort;
        if (batchDebugPort === undefined) {
          batchDebugPort = batchCfg.debugPort;
          try {
            batchDebugPort = await this.debugService.findFreePort(batchCfg.debugPort);
          } catch (err) {
            this.logger.appendLine(`TestExecutionService: Could not find free debug port for batch: ${err}`);
          }
        }
        this.logger.appendLine(`TestExecutionService: Batch using debug port ${batchDebugPort}`);
        // Don't await — let it connect in the background while Gradle starts.
        // DebugService.waitForJvmDebugPort polls until the configured port is open.
        this.debugService.startDebugSession({
          workspacePath: options.workspacePath,
          className: '',
          testName: '',
          debugPort: batchDebugPort
        }).catch(error => {
          this.logger.appendLine(`TestExecutionService: Failed to start debug session: ${error}`);
        });
      }

      const childProcess = spawn(options.commandArgs[0], options.commandArgs.slice(1), {
        cwd: options.workspacePath,
        stdio: 'pipe',
        env: { ...process.env },
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
      });

      const killProcessTree = (force: boolean): void => {
        if (childProcess.killed) {
          return;
        }

        if (process.platform === 'win32') {
          if (childProcess.pid) {
            try {
              const taskkillArgs = ['/PID', String(childProcess.pid), '/T'];
              if (force) {
                taskkillArgs.push('/F');
              }
              spawn('taskkill', taskkillArgs, {
                stdio: 'ignore',
                shell: true,
                windowsHide: true,
              }).on('error', (error: Error) => {
                this.logger.appendLine(`TestExecutionService: taskkill failed: ${error.message}`);
              });
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              this.logger.appendLine(`TestExecutionService: taskkill spawn failed: ${msg}`);
            }
          }

          try {
            childProcess.kill(force ? 'SIGKILL' : 'SIGTERM');
          } catch {
            // ignored
          }
          return;
        }

        if (childProcess.pid) {
          try {
            process.kill(-childProcess.pid, force ? 'SIGKILL' : 'SIGTERM');
            return;
          } catch {
            // fallback below
          }
        }

        try {
          childProcess.kill(force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          // ignored
        }
      };

      // Wire cancellation token to kill the child process
      if (options.token) {
        if (options.token.isCancellationRequested) {
          processKilled = true;
          killProcessTree(false);
          resolve({ success: false, output: 'Test run was cancelled' });
          return;
        }
        cancellationListener = options.token.onCancellationRequested(() => {
          if (!childProcess.killed && !processKilled) {
            this.logger.appendLine('TestExecutionService: Cancellation requested - killing batch process tree');
            processKilled = true;
            killProcessTree(false);
            setTimeout(() => {
              if (!childProcess.killed) {
                killProcessTree(true);
              }
            }, 5000);
          }
        });
      }

      const batchTimeoutCfg = ConfigurationService.getConfig();
      const batchTimeoutMs = batchTimeoutCfg.testTimeout * 1000;
      timeoutId = setTimeout(() => {
        if (!childProcess.killed && !processKilled) {
          this.logger.appendLine(`TestExecutionService: Batch timeout - killing process tree after ${batchTimeoutCfg.testTimeout} seconds`);
          processKilled = true;
          killProcessTree(false);
          setTimeout(() => {
            if (!childProcess.killed) {
              killProcessTree(true);
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

}
