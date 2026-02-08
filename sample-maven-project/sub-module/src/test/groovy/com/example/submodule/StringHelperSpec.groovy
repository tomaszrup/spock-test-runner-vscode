package com.example.submodule

import com.example.submodule.StringHelper
import spock.lang.Specification

class StringHelperSpec extends Specification {

    StringHelper helper = new StringHelper()

    def "should reverse a string"() {
        expect:
        helper.reverse("hello") == "olleh"
    }

    def "should return null when reversing null"() {
        expect:
        helper.reverse(null) == null
    }

    def "should detect palindromes"() {
        expect:
        helper.isPalindrome(input) == expected

        where:
        input           || expected
        "racecar"       || true
        "hello"         || false
        "A man a plan a canal Panama" || true
        ""              || true
    }

    def "should capitalize first letter"() {
        expect:
        helper.capitalize(input) == expected

        where:
        input   || expected
        "hello" || "Hello"
        "World" || "World"
        ""      || ""
        null    || null
    }

    def "should count vowels correctly"() {
        expect:
        helper.countVowels(input) == expected

        where:
        input       || expected
        "hello"     || 2
        "AEIOU"     || 5
        "rhythm"    || 0
        null        || 0
        "beautiful" || 5
    }
}
