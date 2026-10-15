package com.parks.inventory.domain;

public enum ProductType {
    /** Theme park ticket + Park Pass reservation for one park on one date. */
    PARK_PASS,
    /** One resort hotel room-night. */
    RESORT_ROOM,
    /** One seat at a table-service restaurant seating (Disney Dining reservations). */
    DINING
}
