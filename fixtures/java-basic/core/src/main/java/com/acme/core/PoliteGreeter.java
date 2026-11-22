package com.acme.core;

public class PoliteGreeter implements Greeter {
    @Override
    public String greet(String name) {
        return "Good day, " + name;
    }
}
