import { runHousekeeping } from './housekeeping.js';
import { createRuntime } from './runtime.js';

const { cfg, db, app } = await createRuntime();

const server = app.listen(cfg.PORT, () => {
  console.log(`Home360 API listening on http://localhost:${cfg.PORT} (${cfg.NODE_ENV})`);
});

// Housekeeping once a minute: release unpaid slots and close timed-out job offers even when nobody is looking at the app.
const sweep = setInterval(async () => {
  try {
    await runHousekeeping(db);
  } catch (err) {
    console.error('Housekeeping sweep failed:', err);
  }
}, 60_000);
sweep.unref();

const shutdown = async () => {
  clearInterval(sweep);
  server.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
