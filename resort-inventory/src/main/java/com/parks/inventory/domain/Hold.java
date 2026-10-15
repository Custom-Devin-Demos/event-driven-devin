package com.parks.inventory.domain;

import java.time.Instant;
import java.time.LocalDate;

public final class Hold {

    public enum Status { ACTIVE, CONVERTED, RELEASED }

    private final String id;
    private final String productId;
    private final LocalDate date;
    private final int quantity;
    private final String channel;
    private final Instant createdAt;
    private final Instant expiresAt;
    private volatile Status status = Status.ACTIVE;

    public Hold(String id, String productId, LocalDate date, int quantity, String channel,
                Instant createdAt, Instant expiresAt) {
        this.id = id;
        this.productId = productId;
        this.date = date;
        this.quantity = quantity;
        this.channel = channel;
        this.createdAt = createdAt;
        this.expiresAt = expiresAt;
    }

    public String getId() { return id; }
    public String getProductId() { return productId; }
    public LocalDate getDate() { return date; }
    public int getQuantity() { return quantity; }
    public String getChannel() { return channel; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getExpiresAt() { return expiresAt; }
    public Status getStatus() { return status; }
    public void setStatus(Status status) { this.status = status; }
}
