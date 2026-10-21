import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { NODE_ENV: 'test', JWT_SECRET: 'j'.repeat(32), OTP_SECRET: 'o'.repeat(32) };

describe('DATA_KEY', () => {
  it('falls back to JWT_SECRET outside production, and an empty value counts as unset', () => {
    expect(loadConfig({ ...base }).dataKey).toBe('j'.repeat(32));
    expect(loadConfig({ ...base, DATA_KEY: '' }).dataKey).toBe('j'.repeat(32));
    expect(loadConfig({ ...base, DATA_KEY: 'd'.repeat(40) }).dataKey).toBe('d'.repeat(40));
  });

  it('must be long enough when given, and is required in production', () => {
    expect(() => loadConfig({ ...base, DATA_KEY: 'short' })).toThrow(/DATA_KEY/);
    const prod = { ...base, NODE_ENV: 'production', DATABASE_URL: 'postgres://x', SMTP_HOST: 'smtp.example.com' };
    expect(() => loadConfig(prod)).toThrow(/DATA_KEY is required/);
  });
});
