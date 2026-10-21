import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './db/index.js';

/** Private file storage for photos and ID documents. Files are never served directly: only through checked routes. */

export type ImageExt = 'jpg' | 'png' | 'webp';
const MIME: Record<ImageExt, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export class ImageError extends Error {
  constructor(
    public readonly code: 'invalid_image' | 'image_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'ImageError';
  }
}

export interface StoredImage {
  data: Buffer;
  mime: string;
}

export interface ImageStore {
  save(data: Buffer, ext: ImageExt): Promise<string>;
  read(key: string): Promise<StoredImage | null>;
  remove(key: string): Promise<void>;
}

/** Decode an uploaded image (base64, optionally a data: URL) and check it really is a JPEG, PNG or WebP of a sane size. */
export function parseImage(input: string): { data: Buffer; ext: ImageExt } {
  const b64 = input.replace(/^data:image\/[a-z+.-]+;base64,/i, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new ImageError('invalid_image', 'That does not look like an image.');
  const data = Buffer.from(b64, 'base64');
  if (data.length > MAX_IMAGE_BYTES) throw new ImageError('image_too_large', 'The image is too large (3 MB at most).');
  // Judge by the file's own first bytes, never by what the client claims it is.
  if (data.length > 12 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { data, ext: 'jpg' };
  if (data.length > 12 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { data, ext: 'png' };
  if (data.length > 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return { data, ext: 'webp' };
  throw new ImageError('invalid_image', 'Please upload a JPEG, PNG or WebP photo.');
}

export const mimeOf = (key: string): string | null => {
  const ext = KEY.exec(key)?.[1] as ImageExt | undefined;
  return ext ? MIME[ext] : null;
};

export function createDiskStore(dir: string): ImageStore {
  const root = path.resolve(dir);
  // Keys are generated here and re-checked on every use, so a tampered database value can never point outside the folder.
  const file = (key: string) => (KEY.test(key) ? path.join(root, key) : null);
  return {
    async save(data, ext) {
      await mkdir(root, { recursive: true });
      const key = `${randomUUID()}.${ext}`;
      await writeFile(file(key)!, data, { flag: 'wx' });
      return key;
    },
    async read(key) {
      const f = file(key);
      if (!f) return null;
      try {
        return { data: await readFile(f), mime: mimeOf(key)! };
      } catch {
        return null;
      }
    },
    async remove(key) {
      const f = file(key);
      if (f) await unlink(f).catch(() => {});
    },
  };
}

/** Where bytes live. The S3 version is below; tests use a Map. */
export interface ObjectBackend {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  del(key: string): Promise<void>;
}

/** An ImageStore on top of any object backend. Same key rules as the disk store: generated here, re-checked on every use. */
export function createObjectStore(backend: ObjectBackend): ImageStore {
  return {
    async save(data, ext) {
      const key = `${randomUUID()}.${ext}`;
      await backend.put(key, data, MIME[ext]);
      return key;
    },
    async read(key) {
      if (!KEY.test(key)) return null;
      try {
        const data = await backend.get(key);
        return data ? { data, mime: mimeOf(key)! } : null;
      } catch {
        return null;
      }
    },
    async remove(key) {
      if (KEY.test(key)) await backend.del(key).catch(() => {});
    },
  };
}

/** Keeps files in the database (table stored_files). For a small online demo with no bucket; use disk or S3 for real use. */
export function createDbBackend(db: Db): ObjectBackend {
  return {
    async put(key, data) {
      await db.query('INSERT INTO stored_files (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data', [key, data]);
    },
    async get(key) {
      const r = await db.query<{ data: Uint8Array }>('SELECT data FROM stored_files WHERE key = $1', [key]);
      return r.rows[0] ? Buffer.from(r.rows[0].data) : null;
    },
    async del(key) {
      await db.query('DELETE FROM stored_files WHERE key = $1', [key]);
    },
  };
}

/**
 * Private S3-compatible bucket (AWS S3, Cloudflare R2, ...). Files are never public: the app fetches them and only serves them to
 * people who are allowed to see them. The SDK is loaded on first use so disk-only setups do not need it.
 */
export function createS3Backend(o: { bucket: string; region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string; prefix?: string }): ObjectBackend {
  const prefix = o.prefix ?? '';
  let loaded: Promise<{ sdk: typeof import('@aws-sdk/client-s3'); client: import('@aws-sdk/client-s3').S3Client }> | null = null;
  const load = () =>
    (loaded ??= import('@aws-sdk/client-s3').then((sdk) => ({
      sdk,
      client: new sdk.S3Client({
        region: o.region,
        endpoint: o.endpoint,
        forcePathStyle: Boolean(o.endpoint),
        credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
      }),
    })));
  return {
    async put(key, data, contentType) {
      const { sdk, client } = await load();
      await client.send(new sdk.PutObjectCommand({ Bucket: o.bucket, Key: prefix + key, Body: data, ContentType: contentType, CacheControl: 'private, no-store' }));
    },
    async get(key) {
      const { sdk, client } = await load();
      try {
        const r = await client.send(new sdk.GetObjectCommand({ Bucket: o.bucket, Key: prefix + key }));
        return r.Body ? Buffer.from(await r.Body.transformToByteArray()) : null;
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === 'NoSuchKey' || name === 'NotFound') return null;
        throw err;
      }
    },
    async del(key) {
      const { sdk, client } = await load();
      await client.send(new sdk.DeleteObjectCommand({ Bucket: o.bucket, Key: prefix + key }));
    },
  };
}

/** For tests: keeps everything in memory. */
export function createMemoryStore(): ImageStore & { size(): number } {
  const files = new Map<string, Buffer>();
  return {
    async save(data, ext) {
      const key = `${randomUUID()}.${ext}`;
      files.set(key, data);
      return key;
    },
    async read(key) {
      const data = files.get(key);
      return data ? { data, mime: mimeOf(key)! } : null;
    },
    async remove(key) {
      files.delete(key);
    },
    size: () => files.size,
  };
}
