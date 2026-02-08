package com.example.submodule

import com.example.submodule.MathHelper
import spock.lang.Specification
import spock.lang.Unroll

class MathHelperSpec extends Specification {

    MathHelper helper = new MathHelper()

    def "should calculate factorial"() {
        expect:
        helper.factorial(n) == expected

        where:
        n  || expected
        0  || 1
        1  || 1
        5  || 120
        10 || 3628800
    }

    def "should throw exception for negative factorial"() {
        when:
        helper.factorial(-1)

        then:
        thrown(IllegalArgumentException)
    }

    @Unroll
    def "should detect that #n is prime=#expected"() {
        expect:
        helper.isPrime(n) == expected

        where:
        n  || expected
        2  || true
        3  || true
        4  || false
        17 || true
        25 || false
        1  || false
        0  || false
    }

    def "should compute fibonacci numbers"() {
        expect:
        helper.fibonacci(n) == expected

        where:
        n  || expected
        0  || 0
        1  || 1
        2  || 1
        5  || 5
        10 || 55
    }

    def "should throw exception for negative fibonacci index"() {
        when:
        helper.fibonacci(-1)

        then:
        thrown(IllegalArgumentException)
    }
}
