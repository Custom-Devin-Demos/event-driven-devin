package com.parks.inventory;

import com.parks.inventory.config.HoldProperties;
import com.parks.inventory.domain.Hold;
import com.parks.inventory.service.Catalog;
import com.parks.inventory.service.HoldService;
import com.parks.inventory.service.InventoryException;
import com.parks.inventory.service.InventoryStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class HoldServiceTest {

    private static final LocalDate DATE = LocalDate.of(2026, 11, 28);
    private final Clock clock = Clock.fixed(Instant.parse("2026-10-15T15:00:00Z"), ZoneOffset.UTC);
    private Catalog catalog;
    private InventoryStore store;
    private HoldService holds;

    @BeforeEach
    void setUp() {
        catalog = new Catalog();
        store = new InventoryStore();
        holds = new HoldService(catalog, store, new HoldProperties(), clock);
    }

    @Test
    void holdReducesRemainingAndExpiresAfterTtl() {
        Hold hold = holds.createHold("wdw-mk", DATE, 4, "web");
        assertEquals(1196, holds.remaining(catalog.find("wdw-mk").get(), DATE));
        assertEquals(Instant.parse("2026-10-15T15:15:00Z"), hold.getExpiresAt());
    }

    @Test
    void checkoutConvertsHoldToSale() {
        Hold hold = holds.createHold("dlr-gc", DATE, 1, "web");
        holds.checkout(hold.getId());
        assertEquals(1, store.sold("dlr-gc", DATE));
        assertEquals(39, holds.remaining(catalog.find("dlr-gc").get(), DATE));
    }

    @Test
    void rejectsHoldsBeyondCapacity() {
        store.setSold("dlr-dlh", DATE, 40);
        InventoryException e = assertThrows(InventoryException.class, () -> holds.createHold("dlr-dlh", DATE, 1, "web"));
        assertEquals("SOLD_OUT", e.getCode());
    }
}
