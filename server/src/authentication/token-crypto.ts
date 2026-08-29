// Author: Preston Lee

import crypto from 'node:crypto';

export interface TokenBundle {
  refreshToken: string;
  idToken: string;
}

function deriveKey(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'fhir-studio-session-tokens', 'aes-256-gcm', 32));
}

export function encryptTokenBundle(bundle: TokenBundle, secret: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function decryptTokenBundle(ciphertext: string, secret: string): TokenBundle | null {
  try {
    const raw = Buffer.from(ciphertext, 'base64url');
    if (raw.length < 29) {
      return null;
    }
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const key = deriveKey(secret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext) as TokenBundle;
    if (typeof parsed.refreshToken !== 'string' || typeof parsed.idToken !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
