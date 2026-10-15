package com.parks.inventory.job;

import com.parks.inventory.domain.Product;
import com.parks.inventory.service.Catalog;
import com.parks.inventory.service.HoldService;
import com.parks.inventory.service.InventoryException;
import com.parks.inventory.service.InventoryStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Demo traffic: confirmed sales on the next 60 days plus a wave of carts that
 * were abandoned ~20 minutes ago on the peak Thanksgiving-weekend dates. The
 * release job should hand those abandoned holds straight back to the pool.
 */
@Component
public class AbandonedCartSimulator {

    private static final Logger log = LoggerFactory.getLogger(AbandonedCartSimulator.class);

    private final Catalog catalog;
    private final InventoryStore store;
    private final HoldService holdService;
    private final Clock clock;
    private final boolean enabled;

    public AbandonedCartSimulator(Catalog catalog, InventoryStore store, HoldService holdService, Clock clock,
                                  @Value("${inventory.demo.abandoned-carts:true}") boolean enabled) {
        this.catalog = catalog;
        this.store = store;
        this.holdService = holdService;
        this.clock = clock;
        this.enabled = enabled;
    }

    @Scheduled(initialDelay = 1000, fixedDelay = 300000)
    public void simulate() {
        if (!enabled) return;
        for (Product product : catalog.all()) {
            LocalDate today = LocalDate.now(clock.withZone(ZoneId.of(product.getZoneId())));
            for (int i = 0; i < 60; i++) {
                LocalDate date = today.plusDays(i);
                int baseline = (int) Math.round(product.getDailyCapacity() * loadFactor(date));
                if (store.sold(product.getId(), date) < baseline) {
                    store.setSold(product.getId(), date, baseline);
                }
            }
        }
        Instant abandonedAt = Instant.now(clock).minus(Duration.ofMinutes(20));
        int created = 0;
        for (Map.Entry<String, LocalDate> peak : peakDates().entrySet()) {
            Product product = catalog.find(peak.getKey()).orElse(null);
            if (product == null) continue;
            int remaining = holdService.remaining(product, peak.getValue());
            while (remaining > 0) {
                int qty = Math.min(remaining, product.getDailyCapacity() >= 100 ? 6 : 1);
                try {
                    holdService.createHoldAt(product.getId(), peak.getValue(), qty, "web-cart", abandonedAt);
                    created++;
                } catch (InventoryException e) {
                    break;
                }
                remaining -= qty;
            }
        }
        log.info("demo.abandoned_carts holds_created={} abandoned_at={}", created, abandonedAt);
    }

    static double loadFactor(LocalDate date) {
        switch (date.getDayOfWeek()) {
            case SATURDAY: return 0.93;
            case SUNDAY: return 0.88;
            case FRIDAY: return 0.84;
            default: return 0.72;
        }
    }

    private Map<String, LocalDate> peakDates() {
        int year = LocalDate.now(clock).getYear();
        LocalDate thanksgiving = LocalDate.of(year, 11, 1);
        while (thanksgiving.getDayOfWeek() != java.time.DayOfWeek.THURSDAY) {
            thanksgiving = thanksgiving.plusDays(1);
        }
        thanksgiving = thanksgiving.plusWeeks(3);
        Map<String, LocalDate> peaks = new LinkedHashMap<>();
        peaks.put("wdw-mk", thanksgiving.plusDays(2));
        peaks.put("wdw-hs", thanksgiving.plusDays(1));
        peaks.put("dlr-dl", thanksgiving.plusDays(2));
        peaks.put("wdw-gf", thanksgiving);
        peaks.put("dlr-gc", thanksgiving.plusDays(1));
        return peaks;
    }
}
