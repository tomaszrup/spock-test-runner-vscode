import * as vscode from 'vscode';
import { SpockAnnotation, SpockTestClass, SpockTestMethod } from '../types';

/**
 * Interface for test discovery — enables mocking in tests without
 * requiring static method mocking.
 */
export interface ITestDiscoveryService {
  scanClassDeclarations(content: string): Array<{ name: string; parent: string; isAbstract: boolean }>;
  resolveAllSpecBaseClasses(declarations: Array<{ name: string; parent: string }>): Set<string>;
  parseTestsInFile(content: string, knownSpecBaseClasses?: Set<string>): SpockTestClass[];
  hasAnnotation(annotations: SpockAnnotation[] | undefined, name: string): boolean;
  getAnnotationArgument(annotations: SpockAnnotation[] | undefined, name: string): string | undefined;
}

export class TestDiscoveryService implements ITestDiscoveryService {
  private static readonly LIFECYCLE_METHODS = new Set(['setup', 'setupSpec', 'cleanup', 'cleanupSpec']);

  // Broadened: matches any class that extends something (not just Specification)
  private static readonly CLASS_REGEX = /^(?:abstract\s+)?class\s+(\w+)\s+extends\s+([\w.]+)/;

  // Well-known Spock specification root classes
  private static readonly KNOWN_SPEC_BASES = new Set([
    'Specification', 'spock.lang.Specification'
  ]);

  // Known non-spec base classes that should never be treated as specs
  private static readonly KNOWN_NON_SPEC_BASES = new Set([
    'Object', 'java.lang.Object',
    'GroovyTestCase', 'TestCase', 'junit.framework.TestCase',
    'GroovyObjectSupport', 'Script', 'Binding'
  ]);

  private static readonly METHOD_HEADER_REGEX = /^(?:def|void)\s+(['"]([^'"]+)['"]|([a-zA-Z_][a-zA-Z0-9_]*))\s*(?:\([^)]*\))?\s*(\{)?\s*$/;
  private static readonly BLOCK_LABEL_REGEX = /^(given|when|then|expect|where)\s*:\s*$/;

  /**
   * Regex that matches a Groovy/Java annotation.
   * Captures: group 1 = annotation simple name, group 2 = optional argument text (without parens).
   * Handles multi-line arguments by starting capture – caller must handle continuation lines.
   */
  private static readonly ANNOTATION_REGEX = /^@(\w+)(?:\((.*))?$/;

  /** Annotations we recognise and surface in the test tree. */
  private static readonly KNOWN_ANNOTATIONS = new Set([
    'Ignore', 'PendingFeature', 'Stepwise', 'IgnoreIf', 'IgnoreRest',
    'Requires', 'Timeout', 'Unroll', 'Issue', 'Title', 'Narrative', 'See'
  ]);

  /**
   * Lightweight scan to extract class declarations (name + parent) without full method parsing.
   * Used for cross-file inheritance resolution.
   */
  static scanClassDeclarations(content: string): Array<{ name: string; parent: string; isAbstract: boolean }> {
    const lines = content.split('\n');
    const result: Array<{ name: string; parent: string; isAbstract: boolean }> = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(this.CLASS_REGEX);
      if (match && match[1] && match[2]) {
        result.push({
          name: match[1],
          parent: match[2],
          isAbstract: trimmed.startsWith('abstract')
        });
      }
    }
    return result;
  }

  /**
   * Resolve which class names are Spock spec classes from a set of class declarations.
   * Uses iterative fixed-point resolution to handle multi-level inheritance chains.
   *
   * @param declarations All class declarations across the workspace
   * @returns Set of class names that are (or extend) Spock Specification
   */
  static resolveAllSpecBaseClasses(
    declarations: Array<{ name: string; parent: string }>
  ): Set<string> {
    const specClasses = new Set(this.KNOWN_SPEC_BASES);

    let changed = true;
    while (changed) {
      changed = false;
      for (const { name, parent } of declarations) {
        if (specClasses.has(name)) {
          continue;
        }
        // Check fully-qualified and simple parent name
        if (specClasses.has(parent)) {
          specClasses.add(name);
          changed = true;
        } else if (parent.includes('.')) {
          const simpleName = parent.split('.').pop()!;
          if (specClasses.has(simpleName)) {
            specClasses.add(name);
            changed = true;
          }
        }
      }
    }

    return specClasses;
  }

  /**
   * Parse test classes in a single file.
   *
   * @param content The file content
   * @param knownSpecBaseClasses Optional set of additional known spec base class names
   *                              from cross-file inheritance resolution
   */
  static parseTestsInFile(content: string, knownSpecBaseClasses?: Set<string>): SpockTestClass[] {
    const lines = content.split('\n');
    const allClasses: SpockTestClass[] = [];
    let currentClass: SpockTestClass | null = null;
    let inClass = false;
    let classBraceBalance = 0;
    let seenClassOpeningBrace = false;
    let ignoreRestActive = false; // Tracks @IgnoreRest within a class

    // Parse all classes that extend something, collecting their methods
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Look for class definition (any class extending something)
      if (this.CLASS_REGEX.test(trimmedLine)) {
        const match = trimmedLine.match(this.CLASS_REGEX);
        const className = match?.[1];
        const parentClassName = match?.[2];
        const isAbstract = trimmedLine.startsWith('abstract');
        if (className && parentClassName) {
          const classAnnotations = this.collectAnnotationsAbove(lines, i);
          currentClass = {
            name: className,
            line: i,
            range: new vscode.Range(i, 0, i, line.length),
            methods: [],
            isAbstract: isAbstract,
            parentClassName: parentClassName,
            annotations: classAnnotations.length > 0 ? classAnnotations : undefined
          };
          allClasses.push(currentClass);
          inClass = true;
          ignoreRestActive = false; // Reset for new class
          const delta = this.countBraceDelta(line);
          if (delta > 0) {
            seenClassOpeningBrace = true;
          }
          classBraceBalance += delta;
        }
      }
      // Look for test methods
      else if (inClass && currentClass && this.METHOD_HEADER_REGEX.test(trimmedLine)) {
        const match = trimmedLine.match(this.METHOD_HEADER_REGEX);
        const rawName = (match?.[2] || match?.[3] || '').trim();
        const hasBraceSameLine = !!match?.[4];

        if (rawName && !this.LIFECYCLE_METHODS.has(rawName)) {
          const isQuoted = !!match?.[2];
          const shouldAccept = isQuoted || this.lineHasSpockBlockLabelNearby(lines, i);
          const braceOk = hasBraceSameLine || this.hasOpeningBraceOnOrNextLine(lines, i);

          if (shouldAccept && braceOk) {
            // Check if this is a data-driven test by looking for 'where' block
            const isDataDriven = this.hasWhereBlock(lines, i);

            // Collect annotations above this method
            let methodAnnotations = this.collectAnnotationsAbove(lines, i);

            // If @IgnoreRest was seen on a previous method, synthesise @Ignore
            if (ignoreRestActive) {
              const hasExplicitIgnore = methodAnnotations.some(a => a.name === 'Ignore');
              if (!hasExplicitIgnore) {
                methodAnnotations = [{ name: 'Ignore', line: i, argument: 'via @IgnoreRest' }, ...methodAnnotations];
              }
            }

            // Check if THIS method carries @IgnoreRest – future methods will be ignored
            if (methodAnnotations.some(a => a.name === 'IgnoreRest')) {
              ignoreRestActive = true;
            }

            const testMethod: SpockTestMethod = {
              name: rawName,
              line: i,
              range: new vscode.Range(i, 0, i, line.length),
              isDataDriven: isDataDriven,
              annotations: methodAnnotations.length > 0 ? methodAnnotations : undefined
            };
            currentClass.methods.push(testMethod);
          }
        }
      }

      // Update class brace balance
      if (inClass) {
        const delta = this.countBraceDelta(line);
        if (delta > 0) {
          seenClassOpeningBrace = true;
        }
        classBraceBalance += delta;
        if (seenClassOpeningBrace && classBraceBalance <= 0) {
          inClass = false;
          currentClass = null;
          seenClassOpeningBrace = false;
          classBraceBalance = 0;
        }
      }
    }

    // Second pass for @IgnoreRest: Spock's @IgnoreRest means "run ONLY this
    // method, skip ALL others". The first pass only marks methods AFTER the
    // annotated one; this pass marks methods BEFORE it as well.
    for (const cls of allClasses) {
      const hasIgnoreRest = cls.methods.some(m => m.annotations?.some(a => a.name === 'IgnoreRest'));
      if (hasIgnoreRest) {
        for (const method of cls.methods) {
          if (method.annotations?.some(a => a.name === 'IgnoreRest')) {
            continue; // Don't ignore the @IgnoreRest method itself
          }
          const hasExplicitIgnore = method.annotations?.some(a => a.name === 'Ignore');
          if (!hasExplicitIgnore) {
            const ignoreAnnotation: SpockAnnotation = { name: 'Ignore', line: method.line, argument: 'via @IgnoreRest' };
            method.annotations = method.annotations
              ? [ignoreAnnotation, ...method.annotations]
              : [ignoreAnnotation];
          }
        }
      }
    }

    // Resolve which classes are actually Spock specs
    return this.filterSpecClasses(allClasses, knownSpecBaseClasses);
  }

  /**
   * Filter parsed classes to only those that are Spock specification classes.
   *
   * A class is considered a spec if:
   * 1. It directly extends Specification (or a known alias)
   * 2. It extends another class in the same file that is a spec (within-file inheritance)
   * 3. It extends a class from the knownSpecBaseClasses set (cross-file inheritance)
   * 4. (Heuristic) It extends an unknown class but contains Spock-style test methods
   */
  private static filterSpecClasses(
    allClasses: SpockTestClass[],
    knownSpecBaseClasses?: Set<string>
  ): SpockTestClass[] {
    // Build the combined set of known spec base class names
    const specNames = new Set(this.KNOWN_SPEC_BASES);
    if (knownSpecBaseClasses) {
      for (const name of knownSpecBaseClasses) {
        specNames.add(name);
      }
    }

    // Iteratively resolve within-file inheritance chains
    let changed = true;
    while (changed) {
      changed = false;
      for (const cls of allClasses) {
        if (specNames.has(cls.name)) {
          continue;
        }
        const parent = cls.parentClassName;
        if (parent && (specNames.has(parent) || (parent.includes('.') && specNames.has(parent.split('.').pop()!)))) {
          specNames.add(cls.name);
          changed = true;
        }
      }
    }

    // Filter: include confirmed specs and apply heuristic for unknown parents
    const result: SpockTestClass[] = [];
    for (const cls of allClasses) {
      if (specNames.has(cls.name)) {
        result.push(cls);
      } else if (cls.parentClassName && !this.KNOWN_NON_SPEC_BASES.has(cls.parentClassName)) {
        // Heuristic: unknown parent + has Spock-style test methods → treat as spec
        if (cls.methods.length > 0) {
          result.push(cls);
          specNames.add(cls.name); // so subclasses can resolve
        }
      }
    }

    return result;
  }

  // ── Annotation helpers ─────────────────────────────────────────────

  /**
   * Walk backwards from `lineIndex` and collect all annotations directly above.
   * Stops at the first non-annotation, non-blank, non-comment line.
   * Handles multi-line annotation arguments (parenthesised across lines).
   */
  private static collectAnnotationsAbove(lines: string[], lineIndex: number): SpockAnnotation[] {
    const annotations: SpockAnnotation[] = [];
    let j = lineIndex - 1;
    while (j >= 0) {
      const trimmed = lines[j].trim();

      // Skip blank lines and single-line comments
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('*/')) {
        j--;
        continue;
      }

      const annoMatch = trimmed.match(this.ANNOTATION_REGEX);
      if (annoMatch) {
        const name = annoMatch[1];
        let argument: string | undefined;

        if (annoMatch[2] !== undefined) {
          // Annotation has parenthesised argument(s)
          let argText = annoMatch[2];
          // Check if the closing paren is on the same line
          if (!this.isParensClosed(argText)) {
            // Gather continuation lines until we close the parentheses
            let k = j + 1;
            while (k < lineIndex && !this.isParensClosed(argText)) {
              argText += ' ' + lines[k].trim();
              k++;
            }
          }
          // Strip trailing ')' and whitespace
          argument = argText.replace(/\)\s*$/, '').trim() || undefined;
        }

        if (this.KNOWN_ANNOTATIONS.has(name)) {
          annotations.push({ name, argument, line: j });
        } else {
          // Still record unknown annotations with a generic name so callers can inspect
          annotations.push({ name, argument, line: j });
        }
        j--;
      } else {
        // Not an annotation line – stop scanning
        break;
      }
    }
    return annotations;
  }

  /** Quick check: does the accumulated text have balanced / closed parentheses? */
  private static isParensClosed(text: string): boolean {
    let depth = 0;
    for (const ch of text) {
      if (ch === '(') { depth++; }
      if (ch === ')') { depth--; }
      if (depth < 0) { return true; } // closing paren found for the opening from the annotation line
    }
    return depth <= 0;
  }

  /**
   * Convenience: check whether a list of annotations contains a specific one.
   */
  static hasAnnotation(annotations: SpockAnnotation[] | undefined, name: string): boolean {
    return annotations?.some(a => a.name === name) ?? false;
  }

  /**
   * Get the argument value for a specific annotation. Returns undefined if not found.
   */
  static getAnnotationArgument(annotations: SpockAnnotation[] | undefined, name: string): string | undefined {
    return annotations?.find(a => a.name === name)?.argument;
  }

  // ── Structural helpers ─────────────────────────────────────────────

  private static hasOpeningBraceOnOrNextLine(lines: string[], startIndex: number): boolean {
    for (let j = startIndex + 1; j < Math.min(lines.length, startIndex + 5); j++) {
      const t = lines[j].trim();
      if (!t) {
        continue;
      }
      if (t.startsWith('//')) {
        continue;
      }
      return t.startsWith('{');
    }
    return false;
  }

  private static lineHasSpockBlockLabelNearby(lines: string[], startIndex: number): boolean {
    for (let j = startIndex + 1; j < Math.min(lines.length, startIndex + 50); j++) {
      const t = lines[j].trim();
      if (!t) {
        continue;
      }
      if (this.BLOCK_LABEL_REGEX.test(t)) {
        return true;
      }
      if (t === '}') {
        return false;
      }
    }
    return false;
  }

  private static countBraceDelta(text: string): number {
    const open = (text.match(/\{/g) || []).length;
    const close = (text.match(/\}/g) || []).length;
    return open - close;
  }

  private static hasWhereBlock(lines: string[], startIndex: number): boolean {
    let braceBalance = 0;
    let foundOpeningBrace = false;
    
    for (let j = startIndex; j < lines.length; j++) {
      const line = lines[j];
      const trimmedLine = line.trim();
      
      // Count braces to track method boundaries
      const delta = this.countBraceDelta(line);
      braceBalance += delta;
      
      if (delta > 0) {
        foundOpeningBrace = true;
      }
      
      // If we've found the opening brace and now we're back to 0, we've reached the end of the method
      if (foundOpeningBrace && braceBalance <= 0) {
        break;
      }
      
      // Look for 'where:' block
      if (this.BLOCK_LABEL_REGEX.test(trimmedLine) && trimmedLine.includes('where')) {
        return true;
      }
    }
    
    return false;
  }

  // ── Instance methods (delegate to static — for DI / mocking) ───────

  scanClassDeclarations(content: string): Array<{ name: string; parent: string; isAbstract: boolean }> {
    return TestDiscoveryService.scanClassDeclarations(content);
  }
  resolveAllSpecBaseClasses(declarations: Array<{ name: string; parent: string }>): Set<string> {
    return TestDiscoveryService.resolveAllSpecBaseClasses(declarations);
  }
  parseTestsInFile(content: string, knownSpecBaseClasses?: Set<string>): SpockTestClass[] {
    return TestDiscoveryService.parseTestsInFile(content, knownSpecBaseClasses);
  }
  hasAnnotation(annotations: SpockAnnotation[] | undefined, name: string): boolean {
    return TestDiscoveryService.hasAnnotation(annotations, name);
  }
  getAnnotationArgument(annotations: SpockAnnotation[] | undefined, name: string): string | undefined {
    return TestDiscoveryService.getAnnotationArgument(annotations, name);
  }
}
