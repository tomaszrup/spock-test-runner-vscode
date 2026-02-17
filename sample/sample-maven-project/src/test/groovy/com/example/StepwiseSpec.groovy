package com.example

import spock.lang.Specification
import spock.lang.Stepwise

/**
 * A stepwise spec – test order matters and execution stops on first failure.
 * The tree should indicate the @Stepwise annotation on the class.
 */
@Stepwise
class StepwiseSpec extends Specification {

    def "step 1 - setup"() {
        expect:
        true
    }

    def "step 2 - action"() {
        expect:
        true
    }

    def "step 3 - verify"() {
        expect:
        true
    }
}
