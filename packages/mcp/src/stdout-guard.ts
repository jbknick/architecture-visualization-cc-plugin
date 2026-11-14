import { redirectConsoleToStderr } from "./log.js";

// Imported first by main.ts. ES imports run in order, so this runs before the SDK or any other module can log.
redirectConsoleToStderr();
