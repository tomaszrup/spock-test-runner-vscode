import { describe, it, expect } from 'vitest';
import { parseTestError, extractErrorForTest, hasErrorForClass, hasErrorForTest } from './SpockErrorParser';

describe('SpockErrorParser', () => {
  // ── parseTestError ─────────────────────────────────────────────────

  describe('parseTestError', () => {
    it('should extract Spock condition-not-satisfied errors', () => {
      const output = [
        'MySpec > my test FAILED',
        '',
        'Condition not satisfied:',
        '  result == expected',
        '  |      |  |',
        '  4      |  5',
        '         false',
        '',
        '  at MySpec.my test(MySpec.groovy:10)',
      ].join('\n');
      const result = parseTestError(output);
      expect(result).toBeDefined();
      expect(result!.error).toContain('Condition not satisfied');
    });

    it('should extract location from groovy stack traces', () => {
      const output = [
        'MySpec > my test FAILED',
        '  at MySpec.my test(MySpec.groovy:42)',
      ].join('\n');
      const result = parseTestError(output);
      expect(result).toBeDefined();
      expect(result!.location).toBeDefined();
    });

    it('should return a generic error when no details found', () => {
      const output = 'some random output\n';
      const result = parseTestError(output);
      expect(result).toBeDefined();
      expect(result!.error).toBeTruthy();
    });

    it('should capture stack trace lines', () => {
      const output = [
        'MySpec > test FAILED',
        'at com.example.MySpec.test(MySpec.groovy:10)',
        'at org.spockframework.Spec.run(Spec.java:1)',
      ].join('\n');
      const result = parseTestError(output);
      expect(result).toBeDefined();
      expect(result!.error).toContain('Stack trace');
    });

    it('should extract exception messages', () => {
      const output = [
        'groovy.lang.MissingMethodException: No signature of method',
      ].join('\n');
      const result = parseTestError(output);
      expect(result).toBeDefined();
      expect(result!.error).toContain('MissingMethodException');
    });
  });

  // ── extractErrorForTest ────────────────────────────────────────────

  describe('extractErrorForTest', () => {
    it('should return "Test failed" for empty output', () => {
      expect(extractErrorForTest('', 'MySpec', 'test')).toBe('Test failed');
    });

    it('should capture condition block for a specific class and test', () => {
      const output = [
        'MySpec > should add FAILED',
        '',
        'Condition not satisfied:',
        '  result == 5',
        '  |      |',
        '  4      false',
        '',
        '  at MySpec.should add(MySpec.groovy:10)',
      ].join('\n');
      const result = extractErrorForTest(output, 'MySpec', 'should add');
      expect(result).toContain('Condition not satisfied');
    });

    it('should keep power assertion lines when a blank line follows the condition header', () => {
      const output = [
        'MySpec > should add FAILED',
        'Condition not satisfied:',
        '',
        '  result == expected',
        '  |      |  |',
        '  4      |  5',
        '         false',
        '',
        '  at MySpec.should add(MySpec.groovy:10)',
      ].join('\n');

      const result = extractErrorForTest(output, 'MySpec', 'should add');
      expect(result).toContain('Condition not satisfied:');
      expect(result).toContain('result == expected');
      expect(result).toContain('4      |  5');
      expect(result).toContain('MySpec.groovy:10');
    });

    it('should use strict class+test scoping when multiple failures exist', () => {
      const output = [
        'MySpec > should add FAILED',
        'Condition not satisfied:',
        '  sum == 5',
        '  |   |',
        '  4   false',
        '',
        'MySpec > should subtract FAILED',
        'Condition not satisfied:',
        '  diff == 1',
        '  |    |',
        '  2    false',
      ].join('\n');

      const result = extractErrorForTest(output, 'MySpec', 'should subtract');
      expect(result).toContain('diff == 1');
      expect(result).not.toContain('sum == 5');
    });

    it('should capture groovy stack trace lines', () => {
      const output = [
        'MySpec > test FAILED',
        '  at MySpec.test(MySpec.groovy:10)',
      ].join('\n');
      const result = extractErrorForTest(output, 'MySpec', 'test');
      expect(result).toContain('MySpec.groovy:10');
    });

    it('should capture test-specific STANDARD_ERROR block with stack trace', () => {
      const output = [
        'MySpec > should add FAILED',
        'MySpec > should add STANDARD_ERROR',
        '    org.opentest4j.AssertionFailedError: expected: <5> but was: <4>',
        '        at com.example.MySpec.should add(MySpec.groovy:22)',
        '        at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)',
        '',
        'MySpec > should subtract PASSED',
      ].join('\n');

      const result = extractErrorForTest(output, 'com.example.MySpec', 'should add');
      expect(result).toContain('AssertionFailedError');
      expect(result).toContain('MySpec.groovy:22');
      expect(result).not.toContain('should subtract PASSED');
    });

    it('should include causes and filter gradle internal stack frames', () => {
      const output = [
        'CalculatorSpec > should divide FAILED',
        'Caused by: java.lang.ArithmeticException: / by zero',
        '    at com.example.Calculator.divide(Calculator.java:15)',
        '    at worker.org.gradle.process.internal.worker.GradleWorkerMain.run(GradleWorkerMain.java:69)',
      ].join('\n');

      const result = extractErrorForTest(output, 'CalculatorSpec', 'should divide');
      expect(result).toContain('Caused by: java.lang.ArithmeticException: / by zero');
      expect(result).toContain('Calculator.java:15');
      expect(result).not.toContain('worker.org.gradle');
    });

    it('should prepend the first user-code stack frame for exception failures', () => {
      const output = [
        'BowlingGameSpec > should validate game state transitions FAILED',
        'java.lang.NullPointerException',
        '    at java.base/java.util.Objects.requireNonNull(Objects.java:233)',
        '    at java.base/java.util.List.copyOf(List.java:1193)',
        '    at com.example.BowlingGame.<init>(BowlingGame.java:27)',
        '    at com.example.BowlingGameSpec.should validate game state transitions(BowlingGameSpec.groovy:292)',
      ].join('\n');

      const result = extractErrorForTest(output, 'com.example.BowlingGameSpec', 'should validate game state transitions');

      expect(result).toContain('Source: at com.example.BowlingGame.<init>(BowlingGame.java:27)');
      expect(result).not.toContain('Source: at java.base/java.util.Objects.requireNonNull(Objects.java:233)');
    });

    it('should not prepend a source hint when the first stack frame is already user code', () => {
      const output = [
        'MySpec > should add FAILED',
        'Condition not satisfied:',
        '  result == 5',
        '  |      |',
        '  4      false',
        '    at com.example.MySpec.should add(MySpec.groovy:10)',
      ].join('\n');

      const result = extractErrorForTest(output, 'com.example.MySpec', 'should add');

      expect(result).not.toContain('Source:');
      expect(result).toContain('at com.example.MySpec.should add(MySpec.groovy:10)');
    });

    it('should return concrete FAILED line when no detailed block is found', () => {
      const output = 'MySpec > test FAILED\nBUILD FAILED';
      const result = extractErrorForTest(output, 'MySpec', 'test');
      expect(result).toBe('MySpec > test FAILED');
    });

    it('should return "Test failed" for unrelated output', () => {
      const output = 'OtherSpec > other test PASSED\nBUILD SUCCESSFUL';
      const result = extractErrorForTest(output, 'MySpec', 'test');
      expect(result).toBe('Test failed');
    });

    it('should filter out Gradle "Failed to map supported failure" diagnostic lines', () => {
      const output = [
        'MySpec > should add FAILED',
        "Failed to map supported failure 'Condition not satisfied:'",
        " with mapper 'org.gradle.api.internal.tasks.testing.failure.mappers.OpenTestAssertionFailureMapper'",
        'Condition not satisfied:',
        '  1 + 1 == 3',
        '  |   |',
        '  2   false',
        'at com.example.MySpec.should add(MySpec.groovy:12)',
      ].join('\n');
      const result = extractErrorForTest(output, 'MySpec', 'should add');
      expect(result).toContain('Condition not satisfied');
      expect(result).not.toContain('Failed to map supported failure');
      expect(result).not.toContain('OpenTestAssertionFailureMapper');
    });

    it('should filter Gradle > Task noise inside STANDARD_OUT blocks', () => {
      const output = [
        'com.example.CalculatorSpec > should add FAILED',
        'com.example.CalculatorSpec > should add STANDARD_OUT',
        '    > Task :sub1:compileJava UP-TO-DATE',
        '    > Task :sub2:processResources NO-SOURCE',
        '    Condition not satisfied:',
        '      result == 3',
        '      |      |',
        '      0      false',
        'com.example.CalculatorSpec > should subtract PASSED',
      ].join('\n');

      const result = extractErrorForTest(output, 'com.example.CalculatorSpec', 'should add');
      expect(result).toContain('Condition not satisfied');
      expect(result).not.toContain('> Task :sub1:compileJava UP-TO-DATE');
      expect(result).not.toContain('> Task :sub2:processResources NO-SOURCE');
    });

    it('should keep Gradle > Task FAILED lines as meaningful diagnostics', () => {
      const output = [
        'com.example.CalculatorSpec > should add FAILED',
        'com.example.CalculatorSpec > should add STANDARD_ERROR',
        '    > Task :compileTestGroovy FAILED',
        '    Compilation failed; see the compiler error output for details.',
      ].join('\n');

      const result = extractErrorForTest(output, 'com.example.CalculatorSpec', 'should add');
      expect(result).toContain('> Task :compileTestGroovy FAILED');
    });
  });

  // ── hasErrorForClass ───────────────────────────────────────────────

  describe('hasErrorForClass', () => {
    it('should return false for empty output', () => {
      expect(hasErrorForClass('', 'MySpec')).toBe(false);
    });

    it('should detect FAILED lines for the class', () => {
      expect(hasErrorForClass('MySpec > test FAILED', 'MySpec')).toBe(true);
    });

    it('should detect FAILURE lines for the class', () => {
      expect(hasErrorForClass('MySpec FAILURE', 'MySpec')).toBe(true);
    });

    it('should detect [ERROR] lines for the class', () => {
      expect(hasErrorForClass('[ERROR] MySpec compilation error', 'MySpec')).toBe(true);
    });

    it('should not detect errors for unrelated classes', () => {
      expect(hasErrorForClass('OtherSpec > test FAILED', 'MySpec')).toBe(false);
    });

    it('should not match lines without error keywords', () => {
      expect(hasErrorForClass('MySpec > test PASSED', 'MySpec')).toBe(false);
    });
  });

  // ── hasErrorForTest ────────────────────────────────────────────────

  describe('hasErrorForTest', () => {
    it('should return false for empty output', () => {
      expect(hasErrorForTest('', 'MySpec', 'test')).toBe(false);
    });

    it('should return false for empty test name', () => {
      expect(hasErrorForTest('MySpec > test FAILED', 'MySpec', '')).toBe(false);
    });

    it('should detect FAILED line for a specific test with simple class name', () => {
      const output = 'MySpec > should add two numbers FAILED\nMySpec > should subtract PASSED';
      expect(hasErrorForTest(output, 'MySpec', 'should add two numbers')).toBe(true);
    });

    it('should detect FAILED line for a specific test with FQN class name', () => {
      const output = 'com.example.MySpec > should add FAILED\ncom.example.MySpec > should subtract PASSED';
      expect(hasErrorForTest(output, 'MySpec', 'should add')).toBe(true);
    });

    it('should NOT detect failure for a passing test in the same class', () => {
      const output = 'MySpec > should add FAILED\nMySpec > should subtract PASSED';
      expect(hasErrorForTest(output, 'MySpec', 'should subtract')).toBe(false);
    });

    it('should NOT detect failure for a test in a different class', () => {
      const output = 'OtherSpec > test FAILED';
      expect(hasErrorForTest(output, 'MySpec', 'test')).toBe(false);
    });

    it('should handle FQN class name matching against simple name in test data', () => {
      const output = 'com.example.CalculatorSpec > should divide FAILED';
      expect(hasErrorForTest(output, 'CalculatorSpec', 'should divide')).toBe(true);
    });

    it('should detect Maven-style [ERROR] lines for a test', () => {
      const output = '[ERROR] MySpec > test one FAILURE';
      expect(hasErrorForTest(output, 'MySpec', 'test one')).toBe(true);
    });

    it('should ignore generic [ERROR] log lines without FAILED/FAILURE', () => {
      const output = '[ERROR] com.example.MySpec - Application context startup warning for should add';
      expect(hasErrorForTest(output, 'com.example.MySpec', 'should add')).toBe(false);
    });
  });
});
