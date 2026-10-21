import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSecretBox } from '../src/crypto.js';
import { createDiskStore, createMemoryStore, ImageError, MAX_IMAGE_BYTES, parseImage } from '../src/storage.js';
import { png } from './helpers.js';

describe('secret box', () => {
  it('round-trips, never repeats ciphertext, and rejects tampering or a wrong key', () => {
    const box = createSecretBox('a-long-secret-a-long-secret-a-long-secret');
    const a = box.encrypt('514012345678');
    expect(box.decrypt(a)).toBe('514012345678');
    expect(box.encrypt('514012345678')).not.toBe(a); // fresh random IV every time
    const parts = a.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
    expect(() => createSecretBox('another-secret-another-secret-123456').decrypt(a)).toThrow();
    expect(() => box.decrypt('garbage')).toThrow();
  });
});

describe('image parsing', () => {
  it('identifies JPEG, PNG and WebP by their bytes, whatever the data URL claims', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]).toString('base64');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(40)]).toString('base64');
    expect(parseImage(jpeg).ext).toBe('jpg');
    expect(parseImage(webp).ext).toBe('webp');
    expect(parseImage(`data:image/jpeg;base64,${png()}`).ext).toBe('png'); // a lie in the header changes nothing
  });

  it('rejects scripts, non-images and oversized files', () => {
    const html = Buffer.from('<script>alert(1)</script>'.padEnd(60, ' ')).toString('base64');
    expect(() => parseImage(html)).toThrow(ImageError);
    expect(() => parseImage('!!!not base64!!!')).toThrow(ImageError);
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_IMAGE_BYTES)]).toString('base64');
    expect(() => parseImage(big)).toThrowError(/too large/);
  });
});

describe('image stores', () => {
  it('disk store saves, reads and removes, and refuses keys that escape the folder', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'h360-'));
    try {
      const store = createDiskStore(dir);
      const { data, ext } = parseImage(png(7));
      const key = await store.save(data, ext);
      expect((await store.read(key))?.mime).toBe('image/png');
      expect(await store.read('../../etc/passwd')).toBeNull();
      expect(await store.read(`..${path.sep}${key}`)).toBeNull();
      await store.remove('../../etc/passwd'); // ignored
      await store.remove(key);
      expect(await store.read(key)).toBeNull();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('memory store behaves the same', async () => {
    const store = createMemoryStore();
    const key = await store.save(Buffer.from('x'), 'jpg');
    expect((await store.read(key))?.mime).toBe('image/jpeg');
    await store.remove(key);
    expect(store.size()).toBe(0);
  });
});
