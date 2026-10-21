import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encrypts small secrets stored in the database (providers' bank account numbers) with AES-256-GCM.
 * A stolen database dump is then useless without DATA_KEY. Losing DATA_KEY means those values cannot be read again.
 */
export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

export function createSecretBox(secret: string): SecretBox {
  const key = createHash('sha256').update(`home360-data-v1:${secret}`).digest();
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
    },
    decrypt(sealed) {
      const [v, iv, tag, enc] = sealed.split('.');
      if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Unrecognised encrypted value');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}
