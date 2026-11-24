import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const KEYRING_PATH = path.join(DATA_DIR, '.local-keyring');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function getEncryptionKey(): Buffer {
  const envSecret = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (envSecret) {
    // Derive a fixed 32-byte AES-256 key deterministically from the configured server secret
    return crypto.createHash('sha256').update(envSecret, 'utf8').digest();
  }

  ensureDataDir();
  if (fs.existsSync(KEYRING_PATH)) {
    const hex = fs.readFileSync(KEYRING_PATH, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      return Buffer.from(hex, 'hex');
    }
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(KEYRING_PATH, generated.toString('hex'), { mode: 0o600 });
  return generated;
}

export interface EncryptedPayload {
  iv: string;
  tag: string;
  ciphertext: string;
}

export function encryptSecret(plaintext: string): EncryptedPayload {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

export function decryptSecret(payload: EncryptedPayload): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function getDataDirPath(): string {
  ensureDataDir();
  return DATA_DIR;
}
