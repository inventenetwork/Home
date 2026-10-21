// Vercel entry point. The app is compiled to dist/ by `npm run build`; this file only hands each request to it.
import { createRuntime } from '../dist/runtime.js';

let runtime;
const start = () => (runtime ??= createRuntime().catch((err) => {
  runtime = undefined; // try again on the next request
  console.error('Home360 failed to start:', err);
  throw err;
}));

export default async function handler(req, res) {
  try {
    const { app } = await start();
    return app(req, res);
  } catch {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'startup_failed', message: 'The server could not start. Check the deployment logs for the reason.' }));
  }
}
