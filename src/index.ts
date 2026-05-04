import { loadDotEnv } from "./config/env.js";
import { runServer } from "./server.js";

loadDotEnv();
await runServer();
