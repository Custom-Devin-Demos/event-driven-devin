package com.parks.inventory.web;

import com.parks.inventory.domain.Hold;
import com.parks.inventory.domain.Product;
import com.parks.inventory.service.AvailabilityService;
import com.parks.inventory.service.Catalog;
import com.parks.inventory.service.HoldService;
import com.parks.inventory.service.InventoryException;
import com.parks.inventory.service.InventoryStore;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@RestController
public class InventoryController {

    private final Catalog catalog;
    private final AvailabilityService availability;
    private final HoldService holds;
    private final InventoryStore store;

    public InventoryController(Catalog catalog, AvailabilityService availability, HoldService holds, InventoryStore store) {
        this.catalog = catalog;
        this.availability = availability;
        this.holds = holds;
        this.store = store;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        return Collections.singletonMap("status", "ok");
    }

    @GetMapping("/api/catalog")
    public List<Product> catalog() {
        return catalog.all();
    }

    @GetMapping("/api/availability")
    public Map<String, Object> availability(@RequestParam String productId,
                                            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
                                            @RequestParam(defaultValue = "35") int days) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("productId", productId);
        out.put("days", availability.calendar(productId, from, Math.min(Math.max(days, 1), 62)));
        return out;
    }

    @PostMapping("/api/holds")
    public ResponseEntity<Hold> hold(@RequestBody Map<String, Object> body) {
        Hold hold = holds.createHold(String.valueOf(body.get("productId")),
                LocalDate.parse(String.valueOf(body.get("date"))),
                body.get("quantity") instanceof Number ? ((Number) body.get("quantity")).intValue() : 1,
                "web");
        return ResponseEntity.status(HttpStatus.CREATED).body(hold);
    }

    @PostMapping("/api/checkout")
    public Map<String, Object> checkout(@RequestBody Map<String, Object> body) {
        Hold hold = holds.checkout(String.valueOf(body.get("holdId")));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("confirmation", "WDPR-" + hold.getId().substring(2));
        out.put("hold", hold);
        return out;
    }

    @GetMapping("/internal/inventory/audit")
    public Map<String, Object> audit(@RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
                                     @RequestParam(defaultValue = "60") int days) {
        List<Map<String, Object>> rows = availability.audit(from, Math.min(Math.max(days, 1), 90));
        List<Hold> active = store.activeHolds();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("soldOutWithCapacity", rows);
        out.put("activeHolds", active.size());
        out.put("oldestActiveHoldCreatedAt", active.stream().map(Hold::getCreatedAt).min(Comparable::compareTo).orElse(null));
        out.put("holdsPastExpiry", active.stream()
                .filter(h -> h.getExpiresAt().isBefore(java.time.Instant.now()))
                .collect(Collectors.counting()));
        return out;
    }

    @ExceptionHandler(InventoryException.class)
    public ResponseEntity<Map<String, Object>> inventoryError(InventoryException e) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", e.getCode());
        out.put("error", e.getMessage());
        HttpStatus status = "SOLD_OUT".equals(e.getCode()) ? HttpStatus.CONFLICT
                : e.getCode().endsWith("NOT_FOUND") || "UNKNOWN_PRODUCT".equals(e.getCode()) ? HttpStatus.NOT_FOUND
                : HttpStatus.BAD_REQUEST;
        return ResponseEntity.status(status).body(out);
    }
}
