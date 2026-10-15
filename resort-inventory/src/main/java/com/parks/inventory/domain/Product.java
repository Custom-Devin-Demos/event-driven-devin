package com.parks.inventory.domain;

public final class Product {

    private final String id;
    private final String destination;
    private final ProductType type;
    private final String name;
    private final String zoneId;
    private final int dailyCapacity;
    private final int priceFromUsd;

    public Product(String id, String destination, ProductType type, String name, String zoneId,
                   int dailyCapacity, int priceFromUsd) {
        this.id = id;
        this.destination = destination;
        this.type = type;
        this.name = name;
        this.zoneId = zoneId;
        this.dailyCapacity = dailyCapacity;
        this.priceFromUsd = priceFromUsd;
    }

    public String getId() { return id; }
    public String getDestination() { return destination; }
    public ProductType getType() { return type; }
    public String getName() { return name; }
    public String getZoneId() { return zoneId; }
    public int getDailyCapacity() { return dailyCapacity; }
    public int getPriceFromUsd() { return priceFromUsd; }
}
