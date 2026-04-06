import { DiffInfo } from '../types';
import { prependSourceHint } from './SpockErrorParser';

export function parseExpectedActual(errorMessage: string): DiffInfo | undefined {
  if (!errorMessage) {
    return undefined;
  }
  if (isExceptionError(errorMessage)) {
    return undefined;
  }

  const expectedActualBlock = /Expected\s*:\s*(.*)\nActual\s*:\s*(.*)/i.exec(errorMessage);
  if (expectedActualBlock && expectedActualBlock[1] !== expectedActualBlock[2]) {
    return { expected: expectedActualBlock[1].trim(), actual: expectedActualBlock[2].trim() };
  }

  const junitAngle = /expected:\s*<(.+?)>\s*but was:\s*<(.+?)>/i.exec(errorMessage);
  if (junitAngle && junitAngle[1] !== junitAngle[2]) {
    return { expected: junitAngle[1], actual: junitAngle[2] };
  }

  const junitPlain = /expected:\s*(.+?)\s+but was:\s*(.+?)(?:\s*$|\n)/im.exec(errorMessage);
  if (junitPlain) {
    const expected = junitPlain[1].trim();
    const actual = junitPlain[2].trim();
    if (expected !== actual) {
      return { expected, actual };
    }
  }

  const conditionBlock = /Condition not satisfied:\s*\n(\s*)(.+==.+)\n((?:[ \t|]*\S.*\n?)+)/.exec(errorMessage);
  if (!conditionBlock) {
    return undefined;
  }

  return parseSpockPowerAssertion(conditionBlock[2], conditionBlock[3], conditionBlock[1].length);
}

function isExceptionError(errorMessage: string): boolean {
  if (/\bthrown\(\)/.test(errorMessage) || /\bnoExceptionThrown\(\)/.test(errorMessage)) {
    return true;
  }
  if (/Expected exception of type/.test(errorMessage) || /Expected no exception/.test(errorMessage)) {
    return true;
  }

  const lines = errorMessage.split('\n');
  const stackLines = lines.filter(line => /^\s*at\s+/.test(line));
  if (stackLines.length > lines.length * 0.4 && stackLines.length > 3) {
    return true;
  }

  if (/^\s*(java\.\w+\.|groovy\.\w+\.|org\.[\w.]+)(Exception|Error|Throwable)/m.test(errorMessage)
    && !/Condition not satisfied:/.test(errorMessage)) {
    return true;
  }

  return false;
}

function parseSpockPowerAssertion(expressionLine: string, valueBlock: string, indent: number = 0): DiffInfo | undefined { // NOSONAR
  const eqIndex = expressionLine.indexOf('==');
  if (eqIndex === -1) {
    return undefined;
  }

  const eqCol = eqIndex + indent;
  const values = collectAssertionValues(valueBlock, eqCol);
  if (values.length === 0) {
    return undefined;
  }

  const lhsCandidates = values.filter(value => value.col < eqCol);
  const rhsCandidates = values.filter(value => value.col > eqCol + 2);
  const lhsValue = pickNearestLeftValue(lhsCandidates, eqCol);
  const rhsValue = pickNearestRightValue(rhsCandidates, eqCol);

  if (lhsValue === undefined || rhsValue === undefined || lhsValue === rhsValue) {
    return undefined;
  }
  if (looksLikeClassName(lhsValue) || looksLikeClassName(rhsValue)) {
    return undefined;
  }

  return { expected: rhsValue, actual: lhsValue };
}

function collectAssertionValues(valueBlock: string, eqCol: number): Array<{ col: number; value: string }> {
  return valueBlock.split('\n').reduce(
    (state, valueLine) => collectAssertionValuesFromLine(state, valueLine, eqCol),
    { values: [] as Array<{ col: number; value: string }>, inSimilarityBlock: false },
  ).values;
}

function readAssertionToken(line: string, start: number): { start: number; end: number; value: string } {
  const end = resolveAssertionTokenEnd(line, start);
  return { start, end, value: line.substring(start, end).trim() };
}

function resolveAssertionTokenEnd(line: string, start: number): number {
  if (line[start] === '[') {
    return readBracketToken(line, start);
  }
  if (line[start] === '"' || line[start] === "'") {
    return readQuotedToken(line, start);
  }
  return readPlainToken(line, start);
}

function collectAssertionValuesFromLine(
  state: { values: Array<{ col: number; value: string }>; inSimilarityBlock: boolean },
  valueLine: string,
  eqCol: number,
): { values: Array<{ col: number; value: string }>; inSimilarityBlock: boolean } {
  const lineState = getValueLineState(valueLine, state.inSimilarityBlock);
  if (lineState.skip) {
    return { values: state.values, inSimilarityBlock: lineState.inSimilarityBlock };
  }

  return {
    values: [...state.values, ...collectLineValues(valueLine, eqCol)],
    inSimilarityBlock: lineState.inSimilarityBlock,
  };
}

function getValueLineState(valueLine: string, inSimilarityBlock: boolean): { skip: boolean; inSimilarityBlock: boolean } {
  const startsSimilarityBlock = /^\s*\d+\s+difference/.test(valueLine);
  const skip = inSimilarityBlock
    || startsSimilarityBlock
    || /^\s*at\s+/.test(valueLine)
    || /^\s*<?[a-zA-Z_][\w.]*@[0-9a-fA-F]+/.test(valueLine);

  return {
    skip,
    inSimilarityBlock: inSimilarityBlock || startsSimilarityBlock,
  };
}

function collectLineValues(valueLine: string, eqCol: number): Array<{ col: number; value: string }> {
  const values: Array<{ col: number; value: string }> = [];
  let index = 0;

  while (index < valueLine.length) {
    index = skipValueSeparators(valueLine, index);
    if (index >= valueLine.length) {
      break;
    }

    const token = readAssertionToken(valueLine, index);
    index = token.end + 1;
    appendAssertionValue(values, token, eqCol);
  }

  return values;
}

function skipValueSeparators(valueLine: string, index: number): number {
  let nextIndex = index;
  while (nextIndex < valueLine.length && (valueLine[nextIndex] === '|' || valueLine[nextIndex] === ' ')) {
    nextIndex++;
  }
  return nextIndex;
}

function appendAssertionValue(
  values: Array<{ col: number; value: string }>,
  token: { start: number; value: string },
  eqCol: number,
): void {
  if (token.value && !isComparisonResultToken(token, eqCol)) {
    values.push({ col: token.start, value: token.value });
  }
}

function isComparisonResultToken(token: { start: number; value: string }, eqCol: number): boolean {
  return (token.value === 'false' || token.value === 'true') && Math.abs(token.start - eqCol) <= 2;
}

function readBracketToken(line: string, start: number): number {
  let end = start;
  let depth = 0;

  while (end < line.length && line[end] !== '|') {
    if (line[end] === '[') {
      depth++;
    } else if (line[end] === ']') {
      depth--;
      if (depth === 0) {
        return end + 1;
      }
    }
    end++;
  }

  return end;
}

function readQuotedToken(line: string, start: number): number {
  const quote = line[start];
  let end = start + 1;

  while (end < line.length && line[end] !== quote) {
    end++;
  }

  return end < line.length ? end + 1 : end;
}

function readPlainToken(line: string, start: number): number {
  let end = start;
  while (end < line.length && line[end] !== '|' && line[end] !== ' ') {
    end++;
  }
  return end;
}

function pickNearestLeftValue(values: Array<{ col: number; value: string }>, eqCol: number): string | undefined {
  let selected: string | undefined;
  let bestDistance = Infinity;
  for (const value of values) {
    const distance = eqCol - value.col;
    if (distance < bestDistance) {
      bestDistance = distance;
      selected = value.value;
    }
  }
  return selected;
}

function pickNearestRightValue(values: Array<{ col: number; value: string }>, eqCol: number): string | undefined {
  const simplifiedValues = values.filter(value => !looksLikeMapValue(value.value));
  const candidates = simplifiedValues.length > 0 ? simplifiedValues : values;
  let selected: string | undefined;
  let bestDistance = Infinity;
  for (const value of candidates) {
    const distance = value.col - eqCol;
    if (distance < bestDistance) {
      bestDistance = distance;
      selected = value.value;
    }
  }
  return selected;
}

function looksLikeClassName(value: string): boolean {
  return /^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*){2,}/.test(value)
    || /^[a-zA-Z_]\w*@[0-9a-fA-F]+$/.test(value)
    || /^\s*at\s+/.test(value);
}

function looksLikeMapValue(value: string): boolean {
  return value.startsWith('[') && /\w+:\s*[^\s]/.test(value);
}

export function captureFailureBlock(lines: string[], startIndex: number): string | undefined {
  const captured: string[] = [];
  let foundContent = false;

  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/\s*(PASSED|FAILED|SKIPPED)\s*$/.exec(trimmed) || trimmed.startsWith('> Task ') || /^\d+ tests? completed/.exec(trimmed)) {
      break;
    }
    if (trimmed.length > 0) {
      captured.push(line.trimEnd());
      foundContent = true;
      continue;
    }
    if (foundContent && captured.length > 0) {
      if (captured.at(-1)?.trim() === '') {
        break;
      }
      captured.push('');
    }
  }

  while (captured.length > 0 && captured.at(-1)?.trim() === '') {
    captured.pop();
  }

  return captured.length > 0 ? prependSourceHint(captured.join('\n')) : undefined;
}