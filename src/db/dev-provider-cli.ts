import { loadConfig } from '../config.js';
import { createDbFromConfig } from './index.js';
import { createDevProvider } from './dev-provider.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

// Usage: npm run db:dev-provider -- [email] [name]
const cfg = loadConfig();
if (cfg.NODE_ENV === 'production') {
  console.error('Refusing to create a test provider in production.');
  process.exit(1);
}
const [email, name] = process.argv.slice(2);
const db = await createDbFromConfig(cfg);
try {
  await migrate(db);
  await seed(db); // areas and skills must exist
  const p = await createDevProvider(db, { email, name });
  console.log(`Test provider ready: ${p.email} (approved, all services, all areas, 08:00-20:00 daily).`);
  console.log('Run it again with another email to add more capacity: npm run db:dev-provider -- second@example.com');
} finally {
  await db.close();
}
