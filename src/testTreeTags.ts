import * as vscode from 'vscode';
import { SpockAnnotation, SpockAnnotationName } from './types';

const ANNOTATION_TAG_NAMES: SpockAnnotationName[] = [
  'Ignore', 'PendingFeature', 'Stepwise', 'Timeout', 'Requires', 'IgnoreIf',
];

const ANNOTATION_TAGS = new Map<string, vscode.TestTag>(
  ANNOTATION_TAG_NAMES.map(name => [name, new vscode.TestTag(`spock:${name}`)]),
);

export const RUNNABLE_TAG = new vscode.TestTag('runnable');

export function buildAnnotationTags(
  annotations: SpockAnnotation[] | undefined,
  classAnnotations?: SpockAnnotation[] | undefined,
): vscode.TestTag[] {
  const tags: vscode.TestTag[] = [RUNNABLE_TAG];
  const seen = new Set<string>();
  for (const list of [classAnnotations, annotations]) {
    if (!list) {
      continue;
    }
    for (const annotation of list) {
      const tag = ANNOTATION_TAGS.get(annotation.name);
      if (tag && !seen.has(annotation.name)) {
        seen.add(annotation.name);
        tags.push(tag);
      }
    }
  }
  return tags;
}

export function buildIgnoredTags(
  annotations: SpockAnnotation[] | undefined,
  classAnnotations?: SpockAnnotation[] | undefined,
): vscode.TestTag[] {
  const tags: vscode.TestTag[] = [];
  const seen = new Set<string>();
  for (const list of [classAnnotations, annotations]) {
    if (!list) {
      continue;
    }
    for (const annotation of list) {
      const tag = ANNOTATION_TAGS.get(annotation.name);
      if (tag && !seen.has(annotation.name)) {
        seen.add(annotation.name);
        tags.push(tag);
      }
    }
  }
  return tags;
}

export function formatAnnotationDescription(annotations: SpockAnnotation[] | undefined): string {
  if (!annotations || annotations.length === 0) {
    return '';
  }

  const displayAnnotations = new Set([
    'Ignore', 'PendingFeature', 'Stepwise', 'IgnoreIf', 'IgnoreRest',
    'Requires', 'Timeout', 'Issue',
  ]);

  const parts: string[] = [];
  for (const annotation of annotations) {
    if (!displayAnnotations.has(annotation.name)) {
      continue;
    }
    parts.push(annotation.argument ? `@${annotation.name}(${annotation.argument})` : `@${annotation.name}`);
  }
  return parts.join(' ');
}