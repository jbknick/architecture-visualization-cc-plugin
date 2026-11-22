package com.acme.app.model;

public record Person(String name) {
    public String label() {
        return name.trim();
    }
}
