package com.example.submodule

import spock.lang.Specification
import spock.lang.Stepwise

@Stepwise
class StepwiseSubModuleSpec extends Specification {

    static int counter = 0

    def "step 1 - initialize counter"() {
        when:
        counter = 1

        then:
        counter == 1
    }

    def "step 2 - increment counter"() {
        when:
        counter++

        then:
        counter == 2
    }

    def "step 3 - double the counter"() {
        when:
        counter *= 2

        then:
        counter == 4
    }

    def "step 4 - verify final value"() {
        expect:
        counter == 4
    }
}
