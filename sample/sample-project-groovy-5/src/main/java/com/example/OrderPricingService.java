package com.example;

public class OrderPricingService {

    public int applyDiscount(int subtotalCents, int discountPercent) {
        if (subtotalCents < 0) {
            throw new IllegalArgumentException("subtotalCents must be >= 0");
        }
        if (discountPercent < 0 || discountPercent > 50) {
            throw new IllegalArgumentException("discountPercent must be between 0 and 50");
        }
        return subtotalCents - (subtotalCents * discountPercent / 100);
    }

    public int shippingCost(boolean express, int itemCount) {
        if (itemCount < 0) {
            throw new IllegalArgumentException("itemCount must be >= 0");
        }
        if (itemCount == 0) {
            return 0;
        }
        int base = express ? 599 : 299;
        return base + Math.max(0, itemCount - 1) * 50;
    }

    public int totalWithShipping(int subtotalCents, int discountPercent, boolean express, int itemCount) {
        return applyDiscount(subtotalCents, discountPercent) + shippingCost(express, itemCount);
    }

    public Object customerTier(boolean premium) {
        return premium ? "PREMIUM" : "STANDARD";
    }
}
