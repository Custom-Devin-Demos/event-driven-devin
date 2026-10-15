package com.parks.inventory.job;

import com.parks.inventory.config.HoldProperties;
import com.parks.inventory.domain.Hold;
import com.parks.inventory.service.InventoryStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Instant;
import java.util.concurrent.TimeUnit;

/**
 * Returns abandoned cart holds to the sellable pool. A hold that was neither
 * checked out nor released within its TTL is released here.
 */
@Component
public class HoldReleaseJob {

    private static final Logger log = LoggerFactory.getLogger(HoldReleaseJob.class);

    private final InventoryStore store;
    private final HoldProperties properties;
    private final Clock clock;

    public HoldReleaseJob(InventoryStore store, HoldProperties properties, Clock clock) {
        this.store = store;
        this.properties = properties;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${inventory.holds.release-interval-ms:30000}")
    public void run() {
        releaseExpired(Instant.now(clock));
    }

    public int releaseExpired(Instant now) {
        int released = 0;
        int units = 0;
        for (Hold hold : store.activeHolds()) {
            if (isExpired(hold, now)) {
                hold.setStatus(Hold.Status.RELEASED);
                released++;
                units += hold.getQuantity();
            }
        }
        int stillActive = store.activeHolds().size();
        log.info("hold_release.run released={} units={} active_holds={}", released, units, stillActive);
        return released;
    }

    boolean isExpired(Hold hold, Instant now) {
        long ttlMillis = TimeUnit.MINUTES.toMillis(properties.getTtl());
        return hold.getCreatedAt().toEpochMilli() + ttlMillis <= now.toEpochMilli();
    }
}
