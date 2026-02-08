package com.example.submodule

import spock.lang.Ignore
import spock.lang.Specification

@Ignore("Ignored to test ignored-class handling in sub-module")
class IgnoredSubModuleSpec extends Specification {

    def "this test should be ignored"() {
        expect:
        1 == 1
    }

    def "this test should also be ignored"() {
        expect:
        2 + 2 == 4
    }
}
