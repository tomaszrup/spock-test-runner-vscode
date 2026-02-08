import { describe, it, expect } from 'vitest';
import { TestDiscoveryService } from '../services/TestDiscoveryService';

describe('TestDiscoveryService', () => {
  // ── scanClassDeclarations ──────────────────────────────────────────

  describe('scanClassDeclarations', () => {
    it('should extract a single class extending Specification', () => {
      const content = `
package com.example
import spock.lang.Specification

class MySpec extends Specification {
  def "test something"() {
    expect:
    true
  }
}
`;
      const result = TestDiscoveryService.scanClassDeclarations(content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('MySpec');
      expect(result[0].parent).toBe('Specification');
      expect(result[0].isAbstract).toBe(false);
    });

    it('should detect abstract classes', () => {
      const content = `abstract class BaseSpec extends Specification {}`;
      const result = TestDiscoveryService.scanClassDeclarations(content);
      expect(result).toHaveLength(1);
      expect(result[0].isAbstract).toBe(true);
    });

    it('should extract multiple classes from one file', () => {
      const content = `
class SpecA extends Specification {
}
class SpecB extends Specification {
}
`;
      const result = TestDiscoveryService.scanClassDeclarations(content);
      expect(result).toHaveLength(2);
      expect(result.map(r => r.name)).toEqual(['SpecA', 'SpecB']);
    });

    it('should extract parent class with FQN', () => {
      const content = `class MySpec extends spock.lang.Specification {}`;
      const result = TestDiscoveryService.scanClassDeclarations(content);
      expect(result).toHaveLength(1);
      expect(result[0].parent).toBe('spock.lang.Specification');
    });

    it('should return empty array for content without classes', () => {
      const result = TestDiscoveryService.scanClassDeclarations('// nothing here');
      expect(result).toEqual([]);
    });
  });

  // ── resolveAllSpecBaseClasses ──────────────────────────────────────

  describe('resolveAllSpecBaseClasses', () => {
    it('should include KNOWN_SPEC_BASES by default', () => {
      const result = TestDiscoveryService.resolveAllSpecBaseClasses([]);
      expect(result.has('Specification')).toBe(true);
      expect(result.has('spock.lang.Specification')).toBe(true);
    });

    it('should resolve single-level inheritance', () => {
      const declarations = [
        { name: 'BaseSpec', parent: 'Specification' },
        { name: 'MySpec', parent: 'BaseSpec' },
      ];
      const result = TestDiscoveryService.resolveAllSpecBaseClasses(declarations);
      expect(result.has('BaseSpec')).toBe(true);
      expect(result.has('MySpec')).toBe(true);
    });

    it('should resolve multi-level inheritance chains', () => {
      const declarations = [
        { name: 'LevelOne', parent: 'Specification' },
        { name: 'LevelTwo', parent: 'LevelOne' },
        { name: 'LevelThree', parent: 'LevelTwo' },
      ];
      const result = TestDiscoveryService.resolveAllSpecBaseClasses(declarations);
      expect(result.has('LevelThree')).toBe(true);
    });

    it('should handle FQN parent references', () => {
      const declarations = [
        { name: 'MySpec', parent: 'spock.lang.Specification' },
      ];
      const result = TestDiscoveryService.resolveAllSpecBaseClasses(declarations);
      expect(result.has('MySpec')).toBe(true);
    });

    it('should not include classes extending non-spec parents', () => {
      const declarations = [
        { name: 'Utility', parent: 'Object' },
      ];
      const result = TestDiscoveryService.resolveAllSpecBaseClasses(declarations);
      expect(result.has('Utility')).toBe(false);
    });
  });

  // ── parseTestsInFile ──────────────────────────────────────────────

  describe('parseTestsInFile', () => {
    it('should parse a simple spec with one test', () => {
      const content = `
class SimpleSpec extends Specification {
  def "should do something"() {
    expect:
    true
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('SimpleSpec');
      expect(classes[0].methods).toHaveLength(1);
      expect(classes[0].methods[0].name).toBe('should do something');
    });

    it('should parse multiple test methods', () => {
      const content = `
class MultiSpec extends Specification {
  def "first test"() {
    expect:
    true
  }

  def "second test"() {
    expect:
    true
  }

  def "third test"() {
    expect:
    true
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes).toHaveLength(1);
      expect(classes[0].methods).toHaveLength(3);
      expect(classes[0].methods.map(m => m.name)).toEqual([
        'first test',
        'second test',
        'third test',
      ]);
    });

    it('should detect data-driven tests with where block', () => {
      const content = `
class DataSpec extends Specification {
  def "maximum of two numbers"() {
    expect:
    Math.max(a, b) == c

    where:
    a | b | c
    1 | 3 | 3
    7 | 4 | 7
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes[0].methods[0].isDataDriven).toBe(true);
    });

    it('should mark non-data-driven tests correctly', () => {
      const content = `
class SimpleSpec extends Specification {
  def "simple test"() {
    expect:
    1 + 1 == 2
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes[0].methods[0].isDataDriven).toBe(false);
    });

    it('should skip lifecycle methods (setup, cleanup, etc.)', () => {
      const content = `
class LifecycleSpec extends Specification {
  def setup() {
    // setup
  }

  def setupSpec() {
    // setup spec
  }

  def cleanup() {
    // cleanup
  }

  def cleanupSpec() {
    // cleanup spec
  }

  def "real test"() {
    expect:
    true
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes[0].methods).toHaveLength(1);
      expect(classes[0].methods[0].name).toBe('real test');
    });

    it('should detect abstract classes', () => {
      const content = `
abstract class AbstractSpec extends Specification {
  def "base test"() {
    expect:
    true
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes).toHaveLength(1);
      expect(classes[0].isAbstract).toBe(true);
    });

    it('should handle spec extending custom base class with knownSpecBaseClasses', () => {
      const content = `
class ChildSpec extends MyBaseSpec {
  def "child test"() {
    expect:
    true
  }
}
`;
      const knownBases = new Set(['MyBaseSpec']);
      const classes = TestDiscoveryService.parseTestsInFile(content, knownBases);
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('ChildSpec');
    });

    it('should ignore classes extending known non-spec bases without methods', () => {
      const content = `
class Utility extends Object {
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes).toHaveLength(0);
    });

    it('should record parentClassName', () => {
      const content = `
class MySpec extends Specification {
  def "test"() {
    expect:
    true
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes[0].parentClassName).toBe('Specification');
    });

    it('should handle void return type on methods', () => {
      const content = `
class VoidSpec extends Specification {
  void "test with void"() {
    expect:
    true
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes[0].methods).toHaveLength(1);
      expect(classes[0].methods[0].name).toBe('test with void');
    });

    it('should handle nested classes', () => {
      const content = `
class OuterSpec extends Specification {
  def "outer test"() {
    expect:
    true
  }

  class InnerSpec extends Specification {
    def "inner test"() {
      expect:
      true
    }
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      // Should find both outer and inner
      expect(classes.length).toBeGreaterThanOrEqual(1);
    });

    it('should parse annotations on test methods', () => {
      const content = `
class AnnotatedSpec extends Specification {
  @Ignore
  def "ignored test"() {
    expect:
    false
  }

  @Timeout(5)
  def "timed test"() {
    expect:
    true
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      const methods = classes[0].methods;

      const ignoredMethod = methods.find(m => m.name === 'ignored test');
      expect(ignoredMethod?.annotations).toBeDefined();
      expect(ignoredMethod!.annotations!.some(a => a.name === 'Ignore')).toBe(true);

      const timedMethod = methods.find(m => m.name === 'timed test');
      expect(timedMethod?.annotations).toBeDefined();
      expect(timedMethod!.annotations!.some(a => a.name === 'Timeout')).toBe(true);
    });

    it('should parse annotations on classes', () => {
      const content = `
@Stepwise
class StepSpec extends Specification {
  def "step one"() {
    expect:
    true
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes[0].annotations).toBeDefined();
      expect(classes[0].annotations!.some(a => a.name === 'Stepwise')).toBe(true);
    });

    it('should handle @IgnoreRest annotation correctly', () => {
      const content = `
class IgnoreRestSpec extends Specification {
  @IgnoreRest
  def "only this test runs"() {
    expect:
    true
  }

  def "this should be implicitly ignored"() {
    expect:
    true
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      const methods = classes[0].methods;

      const implicitlyIgnored = methods.find(m => m.name === 'this should be implicitly ignored');
      expect(implicitlyIgnored?.annotations?.some(a => a.name === 'Ignore')).toBe(true);
    });

    it('should parse annotation arguments', () => {
      const content = `
class ArgAnnotationSpec extends Specification {
  @Ignore("reason here")
  def "test with reason"() {
    expect:
    false
  }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      const method = classes[0].methods[0];
      const ignoreAnno = method.annotations?.find(a => a.name === 'Ignore');
      expect(ignoreAnno?.argument).toContain('reason here');
    });

    it('should handle empty spec (no methods)', () => {
      const content = `
class EmptySpec extends Specification {
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes).toHaveLength(1);
      expect(classes[0].methods).toHaveLength(0);
    });
  });

  // ── hasAnnotation / getAnnotationArgument ─────────────────────────

  describe('hasAnnotation', () => {
    it('should return true when annotation exists', () => {
      const annotations = [{ name: 'Ignore', line: 0 }];
      expect(TestDiscoveryService.hasAnnotation(annotations, 'Ignore')).toBe(true);
    });

    it('should return false when annotation does not exist', () => {
      const annotations = [{ name: 'Timeout', line: 0 }];
      expect(TestDiscoveryService.hasAnnotation(annotations, 'Ignore')).toBe(false);
    });

    it('should return false for undefined annotations', () => {
      expect(TestDiscoveryService.hasAnnotation(undefined, 'Ignore')).toBe(false);
    });
  });

  describe('getAnnotationArgument', () => {
    it('should return argument when found', () => {
      const annotations = [{ name: 'Ignore', argument: 'not ready', line: 0 }];
      expect(TestDiscoveryService.getAnnotationArgument(annotations, 'Ignore')).toBe('not ready');
    });

    it('should return undefined when not found', () => {
      const annotations = [{ name: 'Timeout', line: 0 }];
      expect(TestDiscoveryService.getAnnotationArgument(annotations, 'Ignore')).toBeUndefined();
    });

    it('should return undefined for undefined annotations', () => {
      expect(TestDiscoveryService.getAnnotationArgument(undefined, 'Ignore')).toBeUndefined();
    });
  });

  // ── Real-world Groovy file parsing ────────────────────────────────

  describe('real-world parsing', () => {
    it('should parse BowlingGameSpec-like content', () => {
      const content = `
package com.example

import spock.lang.Specification
import spock.lang.Unroll

class BowlingGameSpec extends Specification {
    def "should calculate score for regular frames"(int roll1, int roll2, int expectedScore) {
        given:
        BowlingGame game = new BowlingGame()

        when:
        game.roll(roll1)
        game.roll(roll2)

        then:
        game.score() == expectedScore

        where:
        roll1 | roll2 | expectedScore
        3     | 4     | 7
        5     | 2     | 7
    }

    def "should handle simple game"() {
        given:
        BowlingGame game = new BowlingGame()

        when:
        game.roll(5)

        then:
        game.score() == 5
    }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('BowlingGameSpec');
      expect(classes[0].methods).toHaveLength(2);
      expect(classes[0].methods[0].isDataDriven).toBe(true);
      expect(classes[0].methods[1].isDataDriven).toBe(false);
    });

    it('should parse AnnotationSpec-like content', () => {
      const content = `
package com.example

import spock.lang.Ignore
import spock.lang.IgnoreRest
import spock.lang.PendingFeature
import spock.lang.Specification
import spock.lang.Timeout

class AnnotationSpec extends Specification {
    def "normal test runs as usual"() {
        expect:
        1 + 1 == 2
    }

    @Ignore
    def "this test is ignored"() {
        expect:
        false
    }

    @PendingFeature
    def "pending feature expected to fail"() {
        expect:
        false
    }

    @Timeout(5)
    def "test with timeout"() {
        expect:
        true
    }

    @IgnoreRest
    def "only this test runs in the class"() {
        expect:
        true
    }

    def "this test is skipped because of IgnoreRest"() {
        expect:
        true
    }
}
`;
      const classes = TestDiscoveryService.parseTestsInFile(content);
      expect(classes).toHaveLength(1);
      const methods = classes[0].methods;
      expect(methods.length).toBe(6);

      // Check IgnoreRest propagation — both before and after the annotated method
      const skipped = methods.find(m => m.name === 'this test is skipped because of IgnoreRest');
      expect(skipped?.annotations?.some(a => a.name === 'Ignore')).toBe(true);

      // Methods BEFORE @IgnoreRest should also get synthesized @Ignore
      const normal = methods.find(m => m.name === 'normal test runs as usual');
      expect(normal?.annotations?.some(a => a.name === 'Ignore')).toBe(true);

      const pending = methods.find(m => m.name === 'pending feature expected to fail');
      // Already has @PendingFeature but not @Ignore; should get synthesized @Ignore
      expect(pending?.annotations?.some(a => a.name === 'Ignore')).toBe(true);

      const timeout = methods.find(m => m.name === 'test with timeout');
      expect(timeout?.annotations?.some(a => a.name === 'Ignore')).toBe(true);

      // The @IgnoreRest method itself should NOT get synthesized @Ignore
      const onlyRuns = methods.find(m => m.name === 'only this test runs in the class');
      expect(onlyRuns?.annotations?.some(a => a.name === 'Ignore')).toBeFalsy();
      expect(onlyRuns?.annotations?.some(a => a.name === 'IgnoreRest')).toBe(true);

      // Already explicitly @Ignore — should keep its original @Ignore, not get a duplicate
      const ignored = methods.find(m => m.name === 'this test is ignored');
      expect(ignored?.annotations?.filter(a => a.name === 'Ignore')).toHaveLength(1);
    });
  });
});
