package com.parks.inventory.service;

import com.parks.inventory.domain.Product;
import com.parks.inventory.domain.ProductType;
import org.springframework.stereotype.Component;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Sellable inventory pools. Walt Disney World products run on Eastern time,
 * Disneyland Resort products on Pacific time.
 */
@Component
public class Catalog {

    private static final String WDW = "America/New_York";
    private static final String DLR = "America/Los_Angeles";

    private final Map<String, Product> products = new LinkedHashMap<>();

    public Catalog() {
        for (Product p : Arrays.asList(
                new Product("wdw-mk", "wdw", ProductType.PARK_PASS, "Magic Kingdom Park", WDW, 1200, 159),
                new Product("wdw-ep", "wdw", ProductType.PARK_PASS, "EPCOT", WDW, 1000, 134),
                new Product("wdw-hs", "wdw", ProductType.PARK_PASS, "Disney's Hollywood Studios", WDW, 900, 149),
                new Product("wdw-ak", "wdw", ProductType.PARK_PASS, "Disney's Animal Kingdom Theme Park", WDW, 800, 124),
                new Product("dlr-dl", "dlr", ProductType.PARK_PASS, "Disneyland Park", DLR, 1100, 168),
                new Product("dlr-dca", "dlr", ProductType.PARK_PASS, "Disney California Adventure Park", DLR, 900, 168),
                new Product("wdw-gf", "wdw", ProductType.RESORT_ROOM, "Disney's Grand Floridian Resort & Spa", WDW, 60, 899),
                new Product("wdw-poly", "wdw", ProductType.RESORT_ROOM, "Disney's Polynesian Village Resort", WDW, 60, 799),
                new Product("wdw-cr", "wdw", ProductType.RESORT_ROOM, "Disney's Contemporary Resort", WDW, 60, 649),
                new Product("dlr-dlh", "dlr", ProductType.RESORT_ROOM, "Disneyland Hotel", DLR, 40, 749),
                new Product("dlr-gc", "dlr", ProductType.RESORT_ROOM, "Disney's Grand Californian Hotel & Spa", DLR, 40, 829),
                new Product("wdw-bog", "wdw", ProductType.DINING, "Be Our Guest Restaurant", WDW, 160, 69),
                new Product("wdw-crt", "wdw", ProductType.DINING, "Cinderella's Royal Table", WDW, 70, 75),
                new Product("wdw-sp", "wdw", ProductType.DINING, "Space 220 Restaurant", WDW, 90, 79),
                new Product("wdw-oha", "wdw", ProductType.DINING, "'Ohana", WDW, 140, 55),
                new Product("dlr-bb", "dlr", ProductType.DINING, "Blue Bayou Restaurant", DLR, 90, 65),
                new Product("dlr-ll", "dlr", ProductType.DINING, "Lamplight Lounge", DLR, 110, 45))) {
            products.put(p.getId(), p);
        }
    }

    public List<Product> all() {
        return Collections.unmodifiableList(new java.util.ArrayList<>(products.values()));
    }

    public Optional<Product> find(String productId) {
        return Optional.ofNullable(products.get(productId));
    }
}
