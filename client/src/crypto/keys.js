import { bufToB64, b64ToBuf, strToBuf } from './base64';

const RSA_ALG = {
  name: 'RSA-OAEP',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

const PBKDF2_ITERATIONS = 250_000;
const WRAP_IV_BYTES = 12;

export async function generateRsaKeypair() {
  return crypto.subtle.generateKey(RSA_ALG, true, ['encrypt', 'decrypt']);
}

export async function exportPublicKey(publicKey) {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return bufToB64(spki);
}

export async function importPublicKey(b64) {
  return crypto.subtle.importKey(
    'spki',
    b64ToBuf(b64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
}

// Derive an AES-GCM key from the password using PBKDF2-SHA256.
// AES-GCM is used instead of AES-KW so we don't depend on the
// PKCS8 byte length being 8-byte aligned (Web Crypto's RFC 3394
// AES-KW will reject keys whose pkcs8 isn't a multiple of 8 bytes).
async function deriveWrappingKey(password, saltBuf) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    strToBuf(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuf,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Wrap the RSA private key with the password-derived AES-GCM key.
// Layout of `wrapped_private_key` (base64): [12-byte IV][ciphertext+tag].
export async function wrapPrivateKey(privateKey, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(WRAP_IV_BYTES));
  const wrappingKey = await deriveWrappingKey(password, salt);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    pkcs8
  );
  const blob = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(ciphertext), iv.byteLength);
  return {
    wrapped_private_key: bufToB64(blob.buffer),
    pbkdf2_salt: bufToB64(salt),
  };
}

export async function unwrapPrivateKey(wrappedB64, saltB64, password) {
  const blob = new Uint8Array(b64ToBuf(wrappedB64));
  if (blob.byteLength < WRAP_IV_BYTES + 1) {
    throw new Error('Wrapped private key blob is malformed');
  }
  const iv = blob.slice(0, WRAP_IV_BYTES);
  const ciphertext = blob.slice(WRAP_IV_BYTES);
  const wrappingKey = await deriveWrappingKey(password, b64ToBuf(saltB64));
  const pkcs8 = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    ciphertext
  );
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt']
  );
}
