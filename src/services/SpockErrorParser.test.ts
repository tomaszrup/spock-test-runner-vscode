import { describe, it, expect } from 'vitest';
import { parseTestError, extractErrorForTest, hasErrorForClass } from './SpockErrorParser';

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

    it('should capture condition block for a specific class', () => {
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

    it('should capture groovy stack trace lines', () => {
      const output = [
        'MySpec > test FAILED',
        '  at MySpec.test(MySpec.groovy:10)',
      ].join('\n');
      const result = extractErrorForTest(output, 'MySpec', 'test');
      expect(result).toContain('MySpec.groovy:10');
    });

    it('should report generic failure when only FAILED line is found', () => {
      const output = 'MySpec > test FAILED\nBUILD FAILED';
      const result = extractErrorForTest(output, 'MySpec', 'test');
      expect(result).toContain('FAILED');
    });

    it('should return "Test failed" for unrelated output', () => {
      const output = 'OtherSpec > other test PASSED\nBUILD SUCCESSFUL';
      const result = extractErrorForTest(output, 'MySpec', 'test');
      expect(result).toBe('Test failed');
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
});
