package com.acme.app;

import com.acme.core.*;

public class Main {
    public static void main(String[] args) {
        App app = new App(new LoudGreeter());
        app.run("world");
    }
}
