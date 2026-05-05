import { openDB } from 'idb';

const DB_NAME = 'whisperbox';
const DB_VERSION = 1;

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

export async function saveSession({ refreshToken, userId, username }) {
  const db = await getDb();
  await db.put('session', { key: 'tokens', refreshToken, userId, username });
}

export async function loadSession() {
  const db = await getDb();
  return db.get('session', 'tokens');
}

export async function clearSession() {
  const db = await getDb();
  await db.delete('session', 'tokens');
}
