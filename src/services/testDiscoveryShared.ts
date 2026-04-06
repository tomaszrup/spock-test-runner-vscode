export interface ClassDeclaration {
  name: string;
  parent: string;
  isAbstract: boolean;
}

export const LIFECYCLE_METHODS = new Set(['setup', 'setupSpec', 'cleanup', 'cleanupSpec']);

export const CLASS_REGEX = /^(?:abstract\s+)?class\s+(\w+)\s+extends\s+([\w.]+)/;

export const KNOWN_SPEC_BASES = new Set([
  'Specification', 'spock.lang.Specification'
]);

export const KNOWN_NON_SPEC_BASES = new Set([
  'Object', 'java.lang.Object',
  'GroovyTestCase', 'TestCase', 'junit.framework.TestCase',
  'GroovyObjectSupport', 'Script', 'Binding'
]);

export const METHOD_HEADER_REGEX = /^(?:def|void)\s+(['"]([^'"]+)['"]|([a-zA-Z_]\w*))\s*(?:\([^)]*\))?\s*(\{)?\s*$/;

export const BLOCK_LABEL_REGEX = /^(given|when|then|expect|where)\s*:\s*$/;