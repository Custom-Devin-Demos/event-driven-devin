package com.parks.inventory.service;

import com.parks.inventory.config.HoldProperties;
import com.parks.inventory.domain.Hold;
import com.parks.inventory.domain.Product;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

@Service
public class HoldService {

    private static final Logger log = LoggerFactory.getLogger(HoldService.class);

    private final Catalog catalog;
    private final InventoryStore store;
    private final HoldProperties properties;
    private final Clock clock;

    public HoldService(Catalog catalog, InventoryStore store, HoldProperties properties, Clock clock) {
        this.catalog = catalog;
        this.store = store;
        this.properties = properties;
        this.clock = clock;
    }

    public int remaining(Product product, LocalDate date) {
        return product.getDailyCapacity()
                - store.sold(product.getId(), date)
                - store.activeHeld(product.getId(), date);
    }

    /** Reserve inventory for a guest's cart until the hold expires or converts. */
    public synchronized Hold createHold(String productId, LocalDate date, int quantity, String channel) {
        return createHoldAt(productId, date, quantity, channel, Instant.now(clock));
    }

    /** Create a hold stamped at {@code createdAt} (imports, replays and demo traffic). */
    public synchronized Hold createHoldAt(String productId, LocalDate date, int quantity, String channel, Instant createdAt) {
        Product product = catalog.find(productId)
                .orElseThrow(() -> new InventoryException("UNKNOWN_PRODUCT", "Unknown product " + productId));
        if (quantity < 1 || quantity > 10) {
            throw new InventoryException("INVALID_QUANTITY", "Quantity must be between 1 and 10");
        }
        int remaining = remaining(product, date);
        if (remaining < quantity) {
            log.info("hold.rejected product={} date={} requested={} remaining={}", productId, date, quantity, remaining);
            throw new InventoryException("SOLD_OUT", product.getName() + " is sold out for " + date);
        }
        Instant expiresAt = createdAt.plus(holdTtl());
        Hold hold = new Hold("H-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase(),
                productId, date, quantity, channel, createdAt, expiresAt);
        store.save(hold);
        log.info("hold.created id={} product={} date={} qty={} channel={} expiresAt={}",
                hold.getId(), productId, date, quantity, channel, expiresAt);
        return hold;
    }

    /** Convert an active hold into a sale. */
    public synchronized Hold checkout(String holdId) {
        Hold hold = store.hold(holdId)
                .orElseThrow(() -> new InventoryException("HOLD_NOT_FOUND", "Hold " + holdId + " not found"));
        if (hold.getStatus() != Hold.Status.ACTIVE) {
            throw new InventoryException("HOLD_EXPIRED", "Hold " + holdId + " is no longer active");
        }
        hold.setStatus(Hold.Status.CONVERTED);
        store.addSold(hold.getProductId(), hold.getDate(), hold.getQuantity());
        log.info("hold.converted id={} product={} date={} qty={}",
                holdId, hold.getProductId(), hold.getDate(), hold.getQuantity());
        return hold;
    }

    Duration holdTtl() {
        return Duration.ofMinutes(properties.getTtl());
    }
}
