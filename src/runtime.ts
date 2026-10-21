import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDbFromConfig, type Db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createMailer } from './mailer.js';
import { createDbBackend, createDiskStore, createObjectStore, createS3Backend, type ImageStore } from './storage.js';

export function createStoreFromConfig(cfg: Config, db?: Db): ImageStore {
  if (cfg.STORAGE === 'db') {
    if (!db) throw new Error('STORAGE=db needs the database');
    return createObjectStore(createDbBackend(db));
  }
  if (cfg.STORAGE === 's3') {
    return createObjectStore(
      createS3Backend({ bucket: cfg.S3_BUCKET!, region: cfg.S3_REGION, endpoint: cfg.S3_ENDPOINT, accessKeyId: cfg.S3_ACCESS_KEY_ID!, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY!, prefix: cfg.S3_PREFIX }),
    );
  }
  return createDiskStore(cfg.UPLOAD_DIR);
}

/**
 * Everything the running app needs, built once: config, database (with the schema brought up to date), mailer, file store and the
 * Express app. Used by the normal server (src/server.ts) and by the Vercel function (api/index.js).
 */
export async function createRuntime(env: Record<string, string | undefined> = process.env): Promise<{ cfg: Config; db: Db; app: ReturnType<typeof createApp> }> {
  const cfg = loadConfig(env);
  const db = await createDbFromConfig(cfg);
  // Several instances can start at once on a serverless host: take a lock so only one runs the migrations.
  const applied = cfg.DATABASE_URL
    ? await db.tx(async (t) => {
        await t.query('SELECT pg_advisory_xact_lock(360360)');
        return migrate(t);
      })
    : await migrate(db);
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  const app = createApp({ cfg, db, mailer: createMailer(cfg), store: createStoreFromConfig(cfg, db) });
  return { cfg, db, app };
}
