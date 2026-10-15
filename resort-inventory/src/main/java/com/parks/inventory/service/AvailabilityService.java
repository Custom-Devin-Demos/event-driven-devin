package com.parks.inventory.service;

import com.parks.inventory.domain.Product;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class AvailabilityService {

    private final Catalog catalog;
    private final HoldService holdService;
    private final InventoryStore store;

    public AvailabilityService(Catalog catalog, HoldService holdService, InventoryStore store) {
        this.catalog = catalog;
        this.holdService = holdService;
        this.store = store;
    }

    public List<Map<String, Object>> calendar(String productId, LocalDate from, int days) {
        Product product = catalog.find(productId)
                .orElseThrow(() -> new InventoryException("UNKNOWN_PRODUCT", "Unknown product " + productId));
        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < days; i++) {
            LocalDate date = from.plusDays(i);
            int remaining = holdService.remaining(product, date);
            Map<String, Object> day = new LinkedHashMap<>();
            day.put("date", date.toString());
            day.put("status", status(product, remaining));
            // INV-2291 availability v2: one money shape for every channel (tickets,
            // hotels, dining, retail). Replaces the v1 USD-only `priceFromUsd` field.
            Map<String, Object> price = new LinkedHashMap<>();
            price.put("amount", product.getPriceFromUsd() + surcharge(date));
            price.put("currency", "USD");
            day.put("price", price);
            out.add(day);
        }
        return out;
    }

    /**
     * Dates the storefront shows as sold out even though tickets/rooms are not
     * actually sold: capacity minus confirmed sales is still positive, and the
     * shortfall is entirely held inventory.
     */
    public List<Map<String, Object>> audit(LocalDate from, int days) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Product product : catalog.all()) {
            for (int i = 0; i < days; i++) {
                LocalDate date = from.plusDays(i);
                int sold = store.sold(product.getId(), date);
                int held = store.activeHeld(product.getId(), date);
                int unsold = product.getDailyCapacity() - sold;
                if (unsold > 0 && unsold - held <= 0) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("productId", product.getId());
                    row.put("product", product.getName());
                    row.put("date", date.toString());
                    row.put("capacity", product.getDailyCapacity());
                    row.put("sold", sold);
                    row.put("held", held);
                    row.put("unsoldCapacity", unsold);
                    rows.add(row);
                }
            }
        }
        return rows;
    }

    private static String status(Product product, int remaining) {
        if (remaining <= 0) return "SOLD_OUT";
        if (remaining < product.getDailyCapacity() / 10) return "LIMITED";
        return "AVAILABLE";
    }

    private static int surcharge(LocalDate date) {
        switch (date.getDayOfWeek()) {
            case SATURDAY: return 20;
            case SUNDAY: return 15;
            case FRIDAY: return 10;
            default: return 0;
        }
    }
}
