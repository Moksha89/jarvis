import { createServer } from './server/server.js';
import { CORE_DEFAULT_PORT } from './client/contract.js';

const port = Number(process.env.JARVIS_CORE_PORT ?? CORE_DEFAULT_PORT);
const databaseFile = process.env.JARVIS_DB_FILE;
const enableAgent = process.env.JARVIS_ENABLE_AGENT !== 'false';

const handle = await createServer({ port, databaseFile, enableAgent });
console.log(`[jarvis-core] listening on http://127.0.0.1:${handle.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void handle.close().then(() => process.exit(0));
  });
}
