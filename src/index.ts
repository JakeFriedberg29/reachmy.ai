import { loadConfig } from "./config.js";
import { createSql, createDb } from "./db/client.js";
import { loadOrCreateJwks } from "./db/jwks.js";
import { applyMigrations } from "./db/migrate.js";
import { createHttpServer } from "./server.js";

const config = loadConfig();
const sql = createSql(config.databaseUrl);
const db = createDb(sql);
await applyMigrations(db, config.databaseUrl);
const jwks = await loadOrCreateJwks(db);
const server = await createHttpServer(config, db, jwks);

server.listen(config.port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      msg: "reachmy.ai phase 1 listening",
      port: config.port,
      publicUrl: config.publicUrl,
      mcp: `${config.publicUrl}/mcp`,
      health: `${config.publicUrl}/health`,
    }),
  );
});
