package com.acme.core;

public final class Strings {
    private Strings() {}

    public static String shout(String text) {
        return text.toUpperCase() + "!";
    }
}
