import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { DebugSessionOptions } from '../types';
import { BuildToolService } from './BuildToolService';
import { ConfigurationService } from './ConfigurationService';

export class DebugService {
  private readonly logger: vscode.LogOutputChannel;

  constructor(logger: vscode.LogOutputChannel) {
    this.logger = logger;
  }

  /**
   * Find a free TCP port starting from the preferred port.
   * Tries the preferred port first, then increments up to 100 times.
   */
  async findFreePort(preferredPort: number): Promise<number> {
    for (let offset = 0; offset < 100; offset++) {
      const port = preferredPort + offset;
      if (port > 65535) { break; }
      const free = await this.isPortFree(port);
      if (free) {
        if (offset > 0) {
          this.logger.appendLine(`DebugService: Preferred port ${preferredPort} in use, using ${port} instead`);
        }
        return port;
      }
    }
    throw new Error(`No free debug port found starting from ${preferredPort}`);
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  async startDebugSession(options: DebugSessionOptions): Promise<void> {
    const cfg = ConfigurationService.getConfig(vscode.Uri.file(options.workspacePath));
    const connectionTimeoutMs = cfg.debugConnectionTimeout * 1000;
    const maxRetries = cfg.debugRetries;

    this.logger.appendLine(`DebugService: Starting debug session for ${options.className}.${options.testName} on port ${options.debugPort}`);

    // Wait for JVM to be ready
    const jvmReady = await this.waitForJvmDebugPort(options.debugPort, connectionTimeoutMs);
    if (!jvmReady) {
      throw new Error(`JVM not ready on port ${options.debugPort} after ${cfg.debugConnectionTimeout} seconds`);
    }

    this.logger.appendLine(`DebugService: JVM is ready on port ${options.debugPort}, starting debug session...`);

    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        await this.attemptDebugConnection(options);
        this.logger.appendLine(`DebugService: Debug session started successfully on port ${options.debugPort}`);
        return;
      } catch (error) {
        retryCount++;
        this.logger.appendLine(`DebugService: Debug connection attempt ${retryCount} failed: ${error}`);
        
        if (retryCount < maxRetries) {
          this.logger.appendLine(`DebugService: Retrying debug connection in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    throw new Error(`Failed to start debug session after ${maxRetries} attempts`);
  }

  private async waitForJvmDebugPort(debugPort: number, maxWaitTime: number = 30000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 1000;
    let consecutiveSuccesses = 0;
    const requiredSuccesses = 2;
    
    this.logger.appendLine(`DebugService: Waiting for JVM debug port ${debugPort} to be ready...`);
    
    while (Date.now() - startTime < maxWaitTime) {
      try {
        const isReady = await this.checkJvmDebugPort(debugPort);
        if (isReady) {
          consecutiveSuccesses++;
          this.logger.appendLine(`DebugService: JVM debug port ${debugPort} connection successful (${consecutiveSuccesses}/${requiredSuccesses})`);
          
          if (consecutiveSuccesses >= requiredSuccesses) {
            this.logger.appendLine(`DebugService: JVM debug port ${debugPort} is fully ready`);
            return true;
          }
        } else {
          consecutiveSuccesses = 0;
        }
      } catch (error) {
        consecutiveSuccesses = 0;
        this.logger.appendLine(`DebugService: JVM debug port ${debugPort} not ready yet: ${error}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    this.logger.appendLine(`DebugService: JVM debug port ${debugPort} not ready after ${maxWaitTime}ms`);
    return false;
  }

  private async checkJvmDebugPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(5000);
      
      socket.connect(port, 'localhost', () => {
        this.logger.appendLine(`DebugService: Successfully connected to debug port ${port}`);
        socket.destroy();
        resolve(true);
      });
      
      socket.on('error', (error) => {
        this.logger.appendLine(`DebugService: Connection failed to port ${port}: ${error.message}`);
        socket.destroy();
        resolve(false);
      });
      
      socket.on('timeout', () => {
        this.logger.appendLine(`DebugService: Connection timeout to port ${port}`);
        socket.destroy();
        resolve(false);
      });
    });
  }

  private async attemptDebugConnection(options: DebugSessionOptions): Promise<void> {
    const sourcePaths = this.getSourcePaths(options.workspacePath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(options.workspacePath));

    this.logger.appendLine(`DebugService: Debug source paths:`);
    sourcePaths.forEach((sourcePath, index) => {
      const exists = fs.existsSync(sourcePath);
      this.logger.appendLine(`DebugService:   ${index + 1}. ${sourcePath} (exists: ${exists})`);
    });

    const debugConfig: vscode.DebugConfiguration = {
      type: 'java',
      name: `Debug Spock Test: ${options.className}.${options.testName}`,
      request: 'attach',
      hostName: 'localhost',
      port: options.debugPort,
      projectName: await BuildToolService.getProjectName(options.workspacePath),
      sourcePaths: sourcePaths,
      stepFilters: {
        skipClasses: false,
        skipSynthetics: false,
        skipStaticInitializers: false,
        skipConstructors: false
      },
      includeMain: true,
      includeTest: true
    };

    const success = await vscode.debug.startDebugging(workspaceFolder, debugConfig);
    if (!success) {
      throw new Error('Failed to start debug session');
    }
  }

  private getSourcePaths(workspacePath: string): string[] {
    return [
      workspacePath,
      path.join(workspacePath, 'src', 'test', 'groovy'),
      path.join(workspacePath, 'src', 'main', 'groovy'),
      path.join(workspacePath, 'src', 'test', 'java'),
      path.join(workspacePath, 'src', 'main', 'java'),
      path.join(workspacePath, 'src', 'test', 'kotlin'),
      path.join(workspacePath, 'src', 'main', 'kotlin'),
      // Gradle generated sources
      path.join(workspacePath, 'build', 'generated', 'sources'),
      path.join(workspacePath, 'build', 'generated', 'test-sources'),
      // Maven generated sources
      path.join(workspacePath, 'target', 'generated-sources'),
      path.join(workspacePath, 'target', 'generated-test-sources'),
    ];
  }

}
