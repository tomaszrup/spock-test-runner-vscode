package com.example

/**
 * This spec extends AbstractSpec (which extends Specification).
 * It verifies that test discovery handles base class inheritance
 * so specs that don't directly extend Specification are still found.
 */
class InheritedSpec extends AbstractSpec {

    def "should discover inherited spec"() {
        expect:
        1 + 1 == 2
    }

    def "should run test from inherited base"() {
        given:
        def value = 42

        when:
        def result = value * 2

        then:
        result == 84
    }
}
