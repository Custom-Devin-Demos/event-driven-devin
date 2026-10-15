package com.parks.inventory.domain;

import java.time.LocalDate;
import java.util.Objects;

public final class InventoryKey {

    private final String productId;
    private final LocalDate date;

    public InventoryKey(String productId, LocalDate date) {
        this.productId = productId;
        this.date = date;
    }

    public String getProductId() { return productId; }
    public LocalDate getDate() { return date; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof InventoryKey)) return false;
        InventoryKey other = (InventoryKey) o;
        return productId.equals(other.productId) && date.equals(other.date);
    }

    @Override
    public int hashCode() {
        return Objects.hash(productId, date);
    }
}
