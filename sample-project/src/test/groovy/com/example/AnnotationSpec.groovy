package com.example

import spock.lang.Ignore
import spock.lang.IgnoreIf
import spock.lang.IgnoreRest
import spock.lang.PendingFeature
import spock.lang.Requires
import spock.lang.Specification
import spock.lang.Stepwise
import spock.lang.Timeout

/**
 * Demonstrates Spock annotations that the test runner understands.
 * The Test Explorer tree should reflect @Ignore, @PendingFeature, etc.
 */
class AnnotationSpec extends Specification {

    def "normal test runs as usual"() {
        expect:
        1 + 1 == 2
    }

    @Ignore
    def "this test is ignored"() {
        expect:
        false // would fail if actually run
    }

    @Ignore("not implemented yet")
    def "this test is ignored with reason"() {
        expect:
        false
    }

    @PendingFeature
    def "pending feature expected to fail"() {
        expect:
        false // expected to fail; passes when feature is implemented
    }

    @Timeout(5)
    def "test with timeout"() {
        expect:
        true
    }

    @IgnoreIf({ System.getProperty('os.name').contains('Windows') })
    def "only on non-Windows"() {
        expect:
        true
    }

    @Requires({ jvm.java8Compatible })
    def "requires Java 8+"() {
        expect:
        true
    }

    @IgnoreRest
    def "only this test runs in the class"() {
        expect:
        true
    }

    def "this is ignored because of @IgnoreRest above"() {
        expect:
        true
    }

    def "this is also ignored because of @IgnoreRest"() {
        expect:
        true
    }
}
