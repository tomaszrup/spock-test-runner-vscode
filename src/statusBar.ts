import * as vscode from 'vscode';

const INFO_TIMEOUT_MS = 5000;
const WARNING_TIMEOUT_MS = 10000;

function showStatusMessage(icon: string, message: string, timeoutMs: number): void {
  vscode.window.setStatusBarMessage(`${icon} Spock Test Runner: ${message}`, timeoutMs);
}

export function showInfoStatus(message: string, timeoutMs: number = INFO_TIMEOUT_MS): void {
  showStatusMessage('$(info)', message, timeoutMs);
}

export function showWarningStatus(message: string, timeoutMs: number = WARNING_TIMEOUT_MS): void {
  showStatusMessage('$(warning)', message, timeoutMs);
}