import { loadConfig } from '../config.js';
import { createDbFromConfig } from './index.js';
import { migrate } from './migrate.js';

const db = await createDbFromConfig(loadConfig());
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date.');
} finally {
  await db.close();
}
