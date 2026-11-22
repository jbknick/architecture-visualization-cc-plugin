package com.acme.core;

public class Formatter {
    public String format(String text) {
        return format(text, 1);
    }

    public String format(String text, int times) {
        return pad(text).repeat(times);
    }

    public String pad(String text) {
        return " " + text + " ";
    }

    public String pad(int width) {
        return " ".repeat(width);
    }
}
