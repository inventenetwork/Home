import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

describe('web app hosting', () => {
  it('serves the app at / with a strict Content-Security-Policy', async () => {
    const { app } = await setup();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    const csp = res.headers['content-security-policy']!;
    expect(csp).toContain("script-src 'self' https://accounts.google.com/gsi/client");
    expect(csp).toContain("frame-src 'self' https://accounts.google.com/gsi/");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-inline'"); // no inline scripts or styles anywhere in the app
    expect(csp).not.toContain('upgrade-insecure-requests'); // plain-http localhost in development/test
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
  });

  it('serves modules, styles and the logo', async () => {
    const { app } = await setup();
    for (const [path, type] of [['/js/app.js', /javascript/], ['/css/styles.css', /css/], ['/img/logo.svg', /svg/]] as const) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers['content-type'], path).toMatch(type);
    }
  });

  it('keeps API errors as JSON, and does not serve the SPA for unknown paths', async () => {
    const { app } = await setup();
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('does not count page assets against the API rate limit', async () => {
    const { app } = await setup({ RATE_LIMIT_PER_MINUTE: '3' });
    for (let i = 0; i < 10; i++) expect((await request(app).get('/css/styles.css')).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await request(app).get('/areas')).status).toBe(200);
    expect((await request(app).get('/areas')).status).toBe(429);
  });

  it('index.html has no inline script, inline style or third-party asset', () => {
    const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//i);
  });
});
