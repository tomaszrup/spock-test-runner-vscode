import { WhereBlockData } from '../types';
import { BLOCK_LABEL_REGEX } from './testDiscoveryShared';

export function hasOpeningBraceOnOrNextLine(lines: string[], startIndex: number): boolean {
  for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 5); index++) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('//')) {
      continue;
    }
    return trimmed.startsWith('{');
  }
  return false;
}

export function lineHasSpockBlockLabelNearby(lines: string[], startIndex: number): boolean {
  for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 50); index++) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      continue;
    }
    if (BLOCK_LABEL_REGEX.test(trimmed)) {
      return true;
    }
    if (trimmed === '}') {
      return false;
    }
  }
  return false;
}

export function countBraceDelta(text: string): number {
  const open = (text.match(/\{/g) || []).length;
  const close = (text.match(/\}/g) || []).length;
  return open - close;
}

export function hasWhereBlock(lines: string[], startIndex: number): boolean {
  let braceBalance = 0;
  let foundOpeningBrace = false;

  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    const delta = countBraceDelta(line);
    braceBalance += delta;

    if (delta > 0) {
      foundOpeningBrace = true;
    }
    if (foundOpeningBrace && braceBalance <= 0) {
      break;
    }
    if (BLOCK_LABEL_REGEX.test(trimmed) && trimmed.includes('where')) {
      return true;
    }
  }

  return false;
}

export function parseWhereBlock(lines: string[], methodStartIndex: number): WhereBlockData | undefined {
  const { whereLineIndex, methodEndIndex } = findWhereBlockBounds(lines, methodStartIndex);
  if (whereLineIndex < 0) {
    return undefined;
  }

  const contentLines = collectWhereContentLines(lines, whereLineIndex + 1, methodEndIndex);
  if (contentLines.length === 0) {
    return undefined;
  }
  if (contentLines[0].includes('|') && !contentLines[0].includes('<<')) {
    return parseDataTable(contentLines);
  }
  if (contentLines[0].includes('<<')) {
    return parseDataPipes(contentLines);
  }
  return undefined;
}

function findWhereBlockBounds(lines: string[], methodStartIndex: number): { whereLineIndex: number; methodEndIndex: number } {
  let braceBalance = 0;
  let foundOpeningBrace = false;
  let whereLineIndex = -1;
  let methodEndIndex = lines.length;

  for (let index = methodStartIndex; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    const delta = countBraceDelta(line);
    braceBalance += delta;
    if (delta > 0) {
      foundOpeningBrace = true;
    }
    if (foundOpeningBrace && braceBalance <= 0) {
      methodEndIndex = index;
      break;
    }
    if (BLOCK_LABEL_REGEX.test(trimmed) && trimmed.includes('where')) {
      whereLineIndex = index;
    }
  }

  return { whereLineIndex, methodEndIndex };
}

function collectWhereContentLines(lines: string[], startIndex: number, endIndex: number): string[] {
  const contentLines: string[] = [];
  for (let index = startIndex; index < endIndex; index++) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed === '*/') {
      continue;
    }
    if (BLOCK_LABEL_REGEX.test(trimmed)) {
      break;
    }
    contentLines.push(trimmed);
  }
  return contentLines;
}

function parseDataTable(lines: string[]): WhereBlockData | undefined {
  if (lines.length < 2) {
    return undefined;
  }

  const splitRow = (line: string): string[] =>
    line.split('|').map(cell => cell.trim()).filter(cell => cell.length > 0);

  const headerLine = lines[0].replaceAll(/^\|+|\|+$/g, '');
  const parameterNames = splitRow(headerLine);
  if (parameterNames.length === 0 || parameterNames.some(name => !/^[a-zA-Z_]\w*$/.test(name))) {
    return undefined;
  }

  const dataRows: string[][] = [];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^[-|_]+$/.test(line.replaceAll(/\s/g, ''))) {
      continue;
    }
    const cells = splitRow(line.replaceAll(/^\|+|\|+$/g, ''));
    if (cells.length === parameterNames.length) {
      dataRows.push(cells);
    }
  }

  if (dataRows.length === 0) {
    return undefined;
  }

  return {
    parameterNames,
    iterationCount: dataRows.length,
    dataRows,
  };
}

function parseDataPipes(lines: string[]): WhereBlockData | undefined {
  const pipes: Array<{ name: string; values: string[] }> = [];

  for (const line of lines) {
    const match = /^(\w+)\s*<<\s*\[(.*)\]\s*$/.exec(line);
    if (!match) {
      return undefined;
    }

    pipes.push({
      name: match[1],
      values: match[2].split(',').map(value => value.trim()),
    });
  }

  if (pipes.length === 0) {
    return undefined;
  }

  const iterationCount = pipes[0].values.length;
  if (iterationCount === 0 || pipes.some(pipe => pipe.values.length !== iterationCount)) {
    return undefined;
  }

  return {
    parameterNames: pipes.map(pipe => pipe.name),
    iterationCount,
    dataRows: Array.from({ length: iterationCount }, (_, rowIndex) => pipes.map(pipe => pipe.values[rowIndex])),
  };
}