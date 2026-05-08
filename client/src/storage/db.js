import { openDB } from 'idb';

const DB_NAME = 'whisperbox';
const DB_VERSION = 1;
const SESSION_KEY = 'session';

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('session')) {
          db.createObjectStore('session', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

// We persist the unwrapped RSA CryptoKey objects directly. CryptoKey is
// structured-cloneable, and IndexedDB stores them as opaque handles to the
// browser's keystore — the underlying bytes never leave the secure boundary,
// and because we imported the private key with extractable=false, no script
// (now or after refresh) can serialize it back to raw form.
export async function saveSession({ refreshToken, user, privateKey, publicKey }) {
  const db = await getDb();
  await db.put('session', {
    key: SESSION_KEY,
    refreshToken,
    user,
    privateKey,
    publicKey,
  });
}

export async function loadSession() {
  const db = await getDb();
  return db.get('session', SESSION_KEY);
}

export async function clearSession() {
  const db = await getDb();
  await db.delete('session', SESSION_KEY);
}
