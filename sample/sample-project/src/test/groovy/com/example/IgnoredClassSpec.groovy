package com.example

import spock.lang.Ignore
import spock.lang.Specification

/**
 * An entirely ignored specification – should appear in the tree
 * but not be runnable.
 */
@Ignore("whole class disabled")
class IgnoredClassSpec extends Specification {

    def "test one in ignored class"() {
        expect:
        true
    }

    def "test two in ignored class"() {
        expect:
        true
    }
}
