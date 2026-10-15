package com.parks.inventory.service;

public class InventoryException extends RuntimeException {

    private final String code;

    public InventoryException(String code, String message) {
        super(message);
        this.code = code;
    }

    public String getCode() {
        return code;
    }
}
