package com.parks.inventory.job;

import com.parks.inventory.domain.Product;
import com.parks.inventory.service.Catalog;
import com.parks.inventory.service.InventoryStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;

/**
 * Demo traffic: confirmed sales on the next 90 days so the calendar shows a
 * realistic mix of available and limited dates.
 */
@Component
public class AbandonedCartSimulator {

    private static final Logger log = LoggerFactory.getLogger(AbandonedCartSimulator.class);

    private final Catalog catalog;
    private final InventoryStore store;
    private final Clock clock;
    private final boolean enabled;

    public AbandonedCartSimulator(Catalog catalog, InventoryStore store, Clock clock,
                                  @Value("${inventory.demo.abandoned-carts:true}") boolean enabled) {
        this.catalog = catalog;
        this.store = store;
        this.clock = clock;
        this.enabled = enabled;
    }

    @Scheduled(initialDelay = 1000, fixedDelay = 300000)
    public void simulate() {
        if (!enabled) return;
        for (Product product : catalog.all()) {
            LocalDate today = LocalDate.now(clock.withZone(ZoneId.of(product.getZoneId())));
            for (int i = 0; i < 90; i++) {
                LocalDate date = today.plusDays(i);
                int baseline = (int) Math.round(product.getDailyCapacity() * loadFactor(date));
                if (store.sold(product.getId(), date) < baseline) {
                    store.setSold(product.getId(), date, baseline);
                }
            }
        }
        log.info("demo.sales_baseline refreshed products={}", catalog.all().size());
    }

    static double loadFactor(LocalDate date) {
        switch (date.getDayOfWeek()) {
            case SATURDAY: return 0.93;
            case SUNDAY: return 0.88;
            case FRIDAY: return 0.84;
            default: return 0.72;
        }
    }
}
