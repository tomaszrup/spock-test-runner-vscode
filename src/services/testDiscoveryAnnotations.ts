import { SpockAnnotation } from '../types';

const ANNOTATION_REGEX = /^@(\w+)(?:\((.*))?$/;

export function collectAnnotationsAbove(lines: string[], lineIndex: number): SpockAnnotation[] { // NOSONAR
  const annotations: SpockAnnotation[] = [];
  let index = lineIndex - 1;

  while (index >= 0) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('*/')) {
      index--;
      continue;
    }

    const annotationMatch = ANNOTATION_REGEX.exec(trimmed);
    if (!annotationMatch) {
      break;
    }

    const name = annotationMatch[1];
    let argument: string | undefined;
    if (annotationMatch[2] !== undefined) {
      let argumentText = annotationMatch[2];
      if (!isParensClosed(argumentText)) {
        let continuationIndex = index + 1;
        while (continuationIndex < lineIndex && !isParensClosed(argumentText)) {
          argumentText += ` ${lines[continuationIndex].trim()}`;
          continuationIndex++;
        }
      }
      argument = argumentText.replace(/\)\s*$/, '').trim() || undefined;
    }

    annotations.push({ name, argument, line: index });
    index--;
  }

  return annotations;
}

function isParensClosed(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') {
      depth++;
    }
    if (ch === ')') {
      depth--;
    }
    if (depth < 0) {
      return true;
    }
  }
  return depth <= 0;
}

export function hasAnnotation(annotations: SpockAnnotation[] | undefined, name: string): boolean {
  return annotations?.some(annotation => annotation.name === name) ?? false;
}

export function getAnnotationArgument(annotations: SpockAnnotation[] | undefined, name: string): string | undefined {
  return annotations?.find(annotation => annotation.name === name)?.argument;
}