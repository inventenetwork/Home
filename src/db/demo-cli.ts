import { loadConfig } from '../config.js';
import { activateAllServices, clearDemoData, loadDemoData } from './demo.js';
import { createDbFromConfig } from './index.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

// Usage: npm run db:demo            switch every service on and add dummy bookings
//        npm run db:demo -- --clear remove the dummy bookings, customers and nothing else
const cfg = loadConfig();
if (cfg.NODE_ENV === 'production') {
  console.error('Refusing to add demo data in production.');
  process.exit(1);
}
const db = await createDbFromConfig(cfg);
try {
  await migrate(db);
  await seed(db, { adminEmail: cfg.ADMIN_EMAIL });
  if (process.argv.includes('--clear')) {
    const n = await clearDemoData(db);
    console.log(`Removed ${n} demo booking(s) and the demo customers. (Demo providers and switched-on services were left alone.)`);
  } else {
    const on = await activateAllServices(db);
    const r = await loadDemoData(db);
    console.log(`Switched on ${on} service(s). Added ${r.bookings} dummy bookings, ${r.customers} demo customers and ${r.providers} demo providers (all services, all areas).`);
    console.log('Open Admin → Analytics. Remove the dummy bookings later with: npm run db:demo -- --clear');
  }
} finally {
  await db.close();
}
