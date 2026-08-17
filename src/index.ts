import { loadConfig } from "./config.js";
import { createHttpServer } from "./server.js";

const config = loadConfig();
const server = createHttpServer(config);

server.listen(config.port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      msg: "reachmy.ai phase -1 listening",
      port: config.port,
      publicUrl: config.publicUrl,
      mcp: `${config.publicUrl}/mcp`,
      health: `${config.publicUrl}/health`,
    }),
  );
});
