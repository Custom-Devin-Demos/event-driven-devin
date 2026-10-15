package com.parks.inventory.service;

import com.parks.inventory.domain.Hold;
import com.parks.inventory.domain.InventoryKey;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * In-memory inventory ledger: tickets/rooms sold per product-date plus every
 * cart hold. Remaining = capacity - sold - quantity held by ACTIVE holds.
 */
@Component
public class InventoryStore {

    private final Map<InventoryKey, Integer> sold = new ConcurrentHashMap<>();
    private final Map<String, Hold> holds = new ConcurrentHashMap<>();

    public int sold(String productId, LocalDate date) {
        return sold.getOrDefault(new InventoryKey(productId, date), 0);
    }

    public void setSold(String productId, LocalDate date, int quantity) {
        sold.put(new InventoryKey(productId, date), quantity);
    }

    public void addSold(String productId, LocalDate date, int quantity) {
        sold.merge(new InventoryKey(productId, date), quantity, Integer::sum);
    }

    public int activeHeld(String productId, LocalDate date) {
        return holds.values().stream()
                .filter(h -> h.getStatus() == Hold.Status.ACTIVE)
                .filter(h -> h.getProductId().equals(productId) && h.getDate().equals(date))
                .mapToInt(Hold::getQuantity)
                .sum();
    }

    public void save(Hold hold) {
        holds.put(hold.getId(), hold);
    }

    public Optional<Hold> hold(String holdId) {
        return Optional.ofNullable(holds.get(holdId));
    }

    public List<Hold> activeHolds() {
        return holds.values().stream()
                .filter(h -> h.getStatus() == Hold.Status.ACTIVE)
                .collect(Collectors.toList());
    }

    public Collection<Hold> allHolds() {
        return new ArrayList<>(holds.values());
    }
}
