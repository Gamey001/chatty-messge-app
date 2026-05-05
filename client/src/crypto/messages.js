import { bufToB64, b64ToBuf, strToBuf, bufToStr } from './base64';

async function generateAesKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function rsaWrapAesKey(aesKey, rsaPublicKey) {
  const raw = await crypto.subtle.exportKey('raw', aesKey);
  const wrapped = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    rsaPublicKey,
    raw
  );
  return bufToB64(wrapped);
}

async function rsaUnwrapAesKey(wrappedB64, rsaPrivateKey) {
  const raw = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    rsaPrivateKey,
    b64ToBuf(wrappedB64)
  );
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

export async function encryptMessage(plaintext, recipientPublicKey, selfPublicKey) {
  const aesKey = await generateAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    strToBuf(plaintext)
  );
  const [encryptedKey, encryptedKeyForSelf] = await Promise.all([
    rsaWrapAesKey(aesKey, recipientPublicKey),
    rsaWrapAesKey(aesKey, selfPublicKey),
  ]);
  return {
    ciphertext: bufToB64(ciphertext),
    iv: bufToB64(iv),
    encryptedKey,
    encryptedKeyForSelf,
  };
}

export async function decryptMessage(payload, rsaPrivateKey, isOwnMessage) {
  const wrappedKey = isOwnMessage ? payload.encryptedKeyForSelf : payload.encryptedKey;
  if (!wrappedKey) throw new Error('No wrapped key available for this recipient');
  const aesKey = await rsaUnwrapAesKey(wrappedKey, rsaPrivateKey);
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(payload.iv) },
    aesKey,
    b64ToBuf(payload.ciphertext)
  );
  return bufToStr(plaintextBuf);
}
