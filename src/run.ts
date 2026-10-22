import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const app = buildServer();

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`listening on ${config.PORT}`);
} catch (error) {
  const message = error instanceof Error ? error.message : "failed to start";
  console.error(message);
  process.exit(1);
}
