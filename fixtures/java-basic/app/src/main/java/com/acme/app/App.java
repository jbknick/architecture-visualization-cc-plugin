package com.acme.app;

import static com.acme.core.Strings.shout;

import com.acme.core.Formatter;
import com.acme.core.Greeter;

public class App {
    private final Greeter greeter;
    private final Formatter formatter = new Formatter();

    public App(Greeter greeter) {
        this.greeter = greeter;
    }

    public String run(String name) {
        String hello = greeter.greet(name);
        String shown = formatter.format(hello);
        return shout(shown);
    }

    private void log(String line) {
        System.out.println(line);
    }

    public class Inner {
        void ping() {
            log("ping");
        }
    }

    static class Counter {
        int next() {
            return 1;
        }
    }
}
