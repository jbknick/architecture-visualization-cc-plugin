package com.acme.core;

public class LoudGreeter extends PoliteGreeter {
    @Override
    public String greet(String name) {
        return Strings.shout(super.greet(name));
    }
}
