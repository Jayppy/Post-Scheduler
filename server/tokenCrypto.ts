import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isProductionRuntime } from './aiProviders/authMiddleware';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const KEYRING_PATH = path.join(DATA_DIR, '.local-keyring');

export type TokenCryptoErrorCode =
  | 'ENCRYPTION_KEY_MISSING'
  | 'DECRYPTION_FAILED_KEY_MISMATCH'
  | 'INVALID_CIPHERTEXT_ENVELOPE';

export class TokenCryptoError extends Error {
  readonly code: TokenCryptoErrorCode;

  constructor(code: TokenCryptoErrorCode, message: string) {
    super(message);
    this.name = 'TokenCryptoError';
    this.code = code;
  }
}

export function hasStableEncryptionKey(): boolean {
  return Boolean(process.env.TOKEN_ENCRYPTION_KEY?.trim());
}

export function getTokenCryptoDiagnostics(): {
  encryptionKeyConfigured: boolean;
  productionMode: boolean;
  usingEphemeralDevKeyring: boolean;
} {
  const configured = hasStableEncryptionKey();
  const prod = isProductionRuntime();
  return {
    encryptionKeyConfigured: configured,
    productionMode: prod,
    usingEphemeralDevKeyring: !configured && !prod,
  };
}

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

  if (isProductionRuntime()) {
    throw new TokenCryptoError(
      'ENCRYPTION_KEY_MISSING',
      'TOKEN_ENCRYPTION_KEY environment secret is required in production. Refusing to generate a replacement key.'
    );
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

export function isValidEncryptedPayload(raw: unknown): raw is EncryptedPayload {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.iv === 'string' &&
    obj.iv.length > 0 &&
    typeof obj.tag === 'string' &&
    obj.tag.length > 0 &&
    typeof obj.ciphertext === 'string' &&
    obj.ciphertext.length > 0
  );
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
  if (!isValidEncryptedPayload(payload)) {
    throw new TokenCryptoError(
      'INVALID_CIPHERTEXT_ENVELOPE',
      'Stored encrypted token payload is malformed or empty.'
    );
  }
  const key = getEncryptionKey();
  try {
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    if (err instanceof TokenCryptoError) throw err;
    throw new TokenCryptoError(
      'DECRYPTION_FAILED_KEY_MISMATCH',
      'Unable to decrypt stored OAuth token with the active TOKEN_ENCRYPTION_KEY. Existing encrypted ciphertext was preserved untouched.'
    );
  }
}

export function getDataDirPath(): string {
  ensureDataDir();
  return DATA_DIR;
}
