package com.example

import spock.lang.Specification
import spock.lang.Unroll

class Groovy5FeatureSpec extends Specification {

    private final OrderPricingService service = new OrderPricingService()

    @Unroll
    def "logical implication operator keeps discount rules valid for subtotal=#subtotal discount=#discount"() {
        expect:
        (subtotal > 0) ==> (discount in 0..50)
        service.totalWithShipping(subtotal, discount, false, 2) == expected

        where:
        subtotal | discount || expected
        2000     | 10       || 2149
        1500     | 0        || 1849
    }

    def "supports JEP-394 style instanceof variable pattern"() {
        given:
        Object tier = service.customerTier(true)

        when:
        String normalized = null
        if (tier instanceof String s) {
            normalized = s.toLowerCase()
        }

        then:
        normalized == 'premium'
    }

    def "supports underscore placeholders in multi assignment and closures"() {
        given:
        var (_, discountPercent, itemCount, _) = ['ignored', 15, 3, 'ignored-too']
        def combine = { base, _, shipping -> base - (base * discountPercent / 100) + shipping }

        expect:
        combine(2000, 'unused', service.shippingCost(false, itemCount)) == 2099
    }

    def "supports index variables in for-in loops"() {
        given:
        def subtotals = [1000, 2000, 3000]
        def discounted = []

        when:
        for (int idx, var amount in subtotals) {
            discounted << service.applyDiscount(amount, idx * 5)
        }

        then:
        discounted == [1000, 1900, 2700]
    }

    def "showcases new Groovy 5 collection helpers"() {
        given:
        def zipped = ['A', 'B', 'C'].zipAll([100, 200], '_', -1)
            .collect { [it[0], it[1]] }

        expect:
        zipped == [['A', 100], ['B', 200], ['C', -1]]
        ['a', 'b'].repeat(2) == ['a', 'b', 'a', 'b']
        [1, 2, 3].injectAll(0, Integer::sum) == [1, 3, 6]
    }
}
