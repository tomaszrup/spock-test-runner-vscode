import * as vscode from 'vscode';

function logArgRejection(logger: vscode.OutputChannel | undefined, message: string, value: string): void {
  if (logger) {
    logger.appendLine(`BuildToolService: WARNING — ${message}: ${JSON.stringify(value)}`);
  }
}

function hasUnsafeControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9) {
      return true;
    }
  }
  return false;
}

function stripControlChars(value: string, preserveTab: boolean): string {
  let result = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code < 32;
    if (!isControl || (preserveTab && code === 9)) {
      result += ch;
    }
  }
  return result;
}

const BLOCKED_GRADLE_ARG_PATTERNS = [
  /^--init-script$/i,
  /^-I$/,
  /^--file$/i,
  /^-f$/,
  /^--project-dir$/i,
  /^-p$/,
  /^--settings-file$/i,
  /^-c$/,
];

const BLOCKED_MAVEN_ARG_PATTERNS = [
  /^-f$/,
  /^--file$/i,
  /^-s$/,
  /^--settings$/i,
  /^--global-settings$/i,
  /^-gs$/,
];

export function shellEscape(value: string): string {
  if (process.platform === 'win32') {
    let safe = stripControlChars(value, true).replaceAll('\r', '').replaceAll('\n', '');
    safe = safe.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`);
    safe = safe.replaceAll('%', '%%');
    safe = safe.replaceAll('!', '^^!');
    return `"${safe}"`;
  }
  return value;
}

export function sanitizeTestFilter(name: string, logger?: vscode.OutputChannel): string {
  const cleaned = stripControlChars(name, true);
  if (cleaned !== name && logger) {
    logger.appendLine(`BuildToolService: WARNING — control characters stripped from test filter: ${JSON.stringify(name)}`);
  }
  return cleaned;
}

export function validateExtraArgs(
  args: string[],
  tool: 'gradle' | 'maven',
  logger?: vscode.OutputChannel,
): string[] {
  const blocked = tool === 'gradle' ? BLOCKED_GRADLE_ARG_PATTERNS : BLOCKED_MAVEN_ARG_PATTERNS;
  const safe: string[] = [];
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      logArgRejection(logger, 'rejected additional arg (value of blocked flag)', arg);
      skipNext = false;
      continue;
    }

    if (hasUnsafeControlChars(arg)) {
      logArgRejection(logger, 'rejected additional arg containing control characters', arg);
      continue;
    }

    if (blocked.some(pattern => pattern.test(arg))) {
      logArgRejection(logger, 'rejected blocked additional arg', arg);
      skipNext = true;
      continue;
    }

    safe.push(arg);
  }

  return safe;
}