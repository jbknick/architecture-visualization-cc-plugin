import greet from "@/greet";
import { Counter } from "@/index";
import { config } from "@/config";

const counter = new Counter();
counter.increment(config.retries);
console.log(greet("Ada", "Lovelace"), counter.current);
