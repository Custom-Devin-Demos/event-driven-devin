package com.parks.inventory.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Cart hold settings ({@code inventory.holds.*}).
 */
@ConfigurationProperties(prefix = "inventory.holds")
public class HoldProperties {

    /** Hold time-to-live in minutes. */
    private long ttl = 15;

    /** How often HoldReleaseJob sweeps for expired holds. */
    private long releaseIntervalMs = 30000;

    public long getTtl() {
        return ttl;
    }

    public void setTtl(long ttl) {
        this.ttl = ttl;
    }

    public long getReleaseIntervalMs() {
        return releaseIntervalMs;
    }

    public void setReleaseIntervalMs(long releaseIntervalMs) {
        this.releaseIntervalMs = releaseIntervalMs;
    }
}
