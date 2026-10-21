import { loadConfig } from '../config.js';
import { createDbFromConfig } from './index.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

const cfg = loadConfig();
const db = await createDbFromConfig(cfg);
try {
  await migrate(db); // make sure the schema exists first
  await seed(db, { adminEmail: cfg.ADMIN_EMAIL });
  console.log('Seed complete: areas, skills, services, options, config' + (cfg.ADMIN_EMAIL ? `, admin ${cfg.ADMIN_EMAIL}` : ''));
  if (!cfg.ADMIN_EMAIL) console.log('Tip: set ADMIN_EMAIL in .env to create your first admin user.');
} finally {
  await db.close();
}
