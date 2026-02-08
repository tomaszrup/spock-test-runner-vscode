package com.example

import spock.lang.Ignore
import spock.lang.PendingFeature
import spock.lang.Specification
import spock.lang.Unroll

/**
 * A comprehensive test suite that deliberately fails in various ways.
 * Use this to verify the extension correctly reports:
 *   - Simple assertion failures
 *   - Data-driven (parameterized) failures
 *   - Exception / thrown() failures
 *   - Timeout failures
 *   - Mixed pass/fail within one class
 *   - Interaction (mock) verification failures
 *   - Comparison failures with detailed diffs
 */
class DeliberateFailureSpec extends Specification {

    // ---------------------------------------------------------------
    // 1. Simple assertion failure
    // ---------------------------------------------------------------
    def "simple equality fails"() {
        expect:
        1 + 1 == 3
    }

    // ---------------------------------------------------------------
    // 2. Boolean assertion failure
    // ---------------------------------------------------------------
    def "boolean condition fails"() {
        given:
        String text = "hello world"

        expect:
        text.startsWith("goodbye")
    }

    // ---------------------------------------------------------------
    // 3. Comparison failure – strings (nice diff in output)
    // ---------------------------------------------------------------
    def "string comparison fails with diff"() {
        given:
        String actual   = "The quick brown fox jumps over the lazy dog"
        String expected = "The quick brown cat jumps over the lazy dog"

        expect:
        actual == expected
    }

    // ---------------------------------------------------------------
    // 4. Collection / list comparison failure
    // ---------------------------------------------------------------
    def "list comparison fails"() {
        given:
        def actual   = [1, 2, 3, 4, 5]
        def expected = [1, 2, 99, 4, 5]

        expect:
        actual == expected
    }

    // ---------------------------------------------------------------
    // 5. Map comparison failure
    // ---------------------------------------------------------------
    def "map comparison fails"() {
        given:
        def actual   = [name: "Alice", age: 30, city: "Paris"]
        def expected = [name: "Alice", age: 31, city: "London"]

        expect:
        actual == expected
    }

    // ---------------------------------------------------------------
    // 6. Exception expected but not thrown
    // ---------------------------------------------------------------
    def "expected exception is not thrown"() {
        when:
        int result = 2 + 2

        then:
        thrown(IllegalArgumentException)
    }

    // ---------------------------------------------------------------
    // 7. Wrong exception type thrown
    // ---------------------------------------------------------------
    def "wrong exception type is thrown"() {
        when:
        throw new UnsupportedOperationException("not supported")

        then:
        thrown(IllegalArgumentException)
    }

    // ---------------------------------------------------------------
    // 8. Exception message mismatch
    // ---------------------------------------------------------------
    def "exception message does not match"() {
        when:
        throw new IllegalArgumentException("bad input value")

        then:
        IllegalArgumentException e = thrown()
        e.message == "invalid argument"
    }

    // ---------------------------------------------------------------
    // 9. Null comparison failure
    // ---------------------------------------------------------------
    def "null value fails assertion"() {
        given:
        String value = null

        expect:
        value == "expected non-null"
    }

    // ---------------------------------------------------------------
    // 10. Groovy truth failure
    // ---------------------------------------------------------------
    def "empty collection is not truthy"() {
        given:
        def items = []

        expect:
        items   // empty list is falsy in Groovy
    }

    // ---------------------------------------------------------------
    // 11. Multiple conditions – first fails
    // ---------------------------------------------------------------
    def "multiple conditions with first failing"() {
        given:
        int a = 10
        int b = 20

        expect:
        a > b           // fails
        a + b == 30     // would pass
        b - a == 10     // would pass
    }

    // ---------------------------------------------------------------
    // 12. Data-driven test – some iterations fail
    // ---------------------------------------------------------------
    @Unroll
    def "data-driven: #a + #b should equal #expected"() {
        expect:
        a + b == expected

        where:
        a  | b  || expected
        1  | 1  || 2        // pass
        2  | 3  || 5        // pass
        5  | 5  || 11       // FAIL – actual is 10
        10 | 20 || 30       // pass
        7  | 8  || 20       // FAIL – actual is 15
    }

    // ---------------------------------------------------------------
    // 13. Data-driven test – ALL iterations fail
    // ---------------------------------------------------------------
    @Unroll
    def "data-driven all-fail: #input squared is #expected"() {
        expect:
        input * input == expected

        where:
        input || expected
        2     || 5       // FAIL – actual 4
        3     || 10      // FAIL – actual 9
        4     || 20      // FAIL – actual 16
    }

    // ---------------------------------------------------------------
    // 14. Given-when-then with setup failure
    // ---------------------------------------------------------------
    def "given-when-then block with then failing"() {
        given:
        Calculator calculator = new Calculator()

        when:
        int result = calculator.add(10, 20)

        then:
        result == 99
    }

    // ---------------------------------------------------------------
    // 15. Interaction verification failure (mock)
    // ---------------------------------------------------------------
    def "mock interaction verification fails"() {
        given:
        def list = Mock(List)

        when:
        list.add("hello")

        then:
        1 * list.add("world")   // fails – was called with "hello"
    }

    // ---------------------------------------------------------------
    // 16. Too few invocations
    // ---------------------------------------------------------------
    def "mock expected more invocations than occurred"() {
        given:
        def list = Mock(List)

        when:
        list.add("item")

        then:
        3 * list.add("item")   // fails – called 1 time, expected 3
    }

    // ---------------------------------------------------------------
    // 17. Test that passes (sanity check – should be green)
    // ---------------------------------------------------------------
    def "this test deliberately passes"() {
        expect:
        2 + 2 == 4
    }

    // ---------------------------------------------------------------
    // 18. Another passing test (to show mixed results)
    // ---------------------------------------------------------------
    def "another passing test for contrast"() {
        given:
        Calculator calculator = new Calculator()

        when:
        int result = calculator.multiply(3, 7)

        then:
        result == 21
    }

    // ---------------------------------------------------------------
    // 19. Type coercion / class cast failure
    // ---------------------------------------------------------------
    def "type coercion fails at runtime"() {
        given:
        Object value = "not a number"

        when:
        Integer number = (Integer) value

        then:
        noExceptionThrown()
    }

    // ---------------------------------------------------------------
    // 21. @Ignore – should show as skipped
    // ---------------------------------------------------------------
    @Ignore("Deliberately skipped to test skip display")
    def "this test is skipped"() {
        expect:
        false
    }

    // ---------------------------------------------------------------
    // 22. @PendingFeature – expected to fail, reported specially
    // ---------------------------------------------------------------
    @PendingFeature
    def "pending feature that still fails"() {
        expect:
        false
    }

    // ---------------------------------------------------------------
    // 23. with() block failure
    // ---------------------------------------------------------------
    def "with block assertion fails"() {
        given:
        def person = new Person("Alice", 30)

        expect:
        with(person) {
            name == "Bob"
            age  == 25
        }
    }

    // ---------------------------------------------------------------
    // 24. verifyAll – reports ALL failures (soft assertions)
    // ---------------------------------------------------------------
    def "verifyAll reports multiple failures at once"() {
        given:
        def person = new Person("Charlie", 40)

        expect:
        verifyAll(person) {
            name == "Dave"
            age  == 50
        }
    }

    // ---------------------------------------------------------------
    // 25. Data-driven with string scenarios
    // ---------------------------------------------------------------
    @Unroll
    def "scenario '#scenario' fails"() {
        expect:
        result == expected

        where:
        scenario              | result | expected
        "off by one"          | 9      | 10
        "negative mismatch"   | -1     | 1
        "zero is not one"     | 0      | 1
    }

    // ---------------------------------------------------------------
    // 26. Old / new value comparison in then block
    // ---------------------------------------------------------------
    def "old-value expression fails"() {
        given:
        def items = [1, 2, 3]

        when:
        items.add(4)

        then:
        items.size() == old(items.size())   // fails: 4 != 3
    }
}
