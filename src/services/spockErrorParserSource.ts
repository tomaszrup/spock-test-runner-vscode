interface ParsedStackFrame {
  symbol: string;
  filePath: string;
  lineNumber: number;
  text: string;
}

export function prependSourceHint(errorText: string): string {
  if (!errorText.trim()) {
    return errorText;
  }

  const sourceFrame = extractRelevantSourceFrame(errorText);
  if (!sourceFrame?.shouldPrepend) {
    return errorText;
  }

  const sourceHint = `Source: ${sourceFrame.text}`;
  if (errorText.includes(sourceHint)) {
    return errorText;
  }

  return `${sourceHint}\n\n${errorText}`;
}

export function isGradleInternalStackLine(line: string): boolean {
  return /\borg\.gradle\.|\bworker\.org\.gradle\./.test(line);
}

export function isGradleTaskNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!/^>\s*Task\s+/i.test(trimmed)) {
    return false;
  }
  return !/\bFAILED\s*$/i.test(trimmed);
}

function extractRelevantSourceFrame(text: string): { text: string; shouldPrepend: boolean } | undefined {
  const frames = text
    .split('\n')
    .map(parseStackFrame)
    .filter((frame): frame is ParsedStackFrame => frame !== undefined);

  if (frames.length === 0) {
    return undefined;
  }

  const preferred = frames.find(frame => !isFrameworkStackFrame(frame.symbol));
  const selected = preferred ?? frames[0];
  return {
    text: selected.text,
    shouldPrepend: selected.text !== frames[0].text,
  };
}

function parseStackFrame(line: string): ParsedStackFrame | undefined {
  const match = /^\s*at\s+(.+?)\((.+\.(?:groovy|java|kt|kts)):(\d+)\)\s*$/.exec(line);
  if (!match) {
    return undefined;
  }

  return {
    symbol: match[1],
    filePath: match[2],
    lineNumber: Number.parseInt(match[3], 10),
    text: `at ${match[1]}(${match[2]}:${match[3]})`,
  };
}

function isFrameworkStackFrame(symbol: string): boolean {
  return /^(?:java\.|javax\.|jdk\.|sun\.|org\.gradle\.|worker\.org\.gradle\.|org\.junit\.|org\.spockframework\.|org\.codehaus\.groovy\.|groovy\.|com\.intellij\.)/.test(symbol);
}