# WhisperBox · Stage 4B E2EE Messaging Client

End-to-end encrypted messaging client built against the
[WhisperBox API](https://whisperbox.koyeb.app/docs). Plaintext never leaves the
browser — the server only ever sees ciphertext. Encryption uses the Web Crypto
API (RSA-OAEP-2048 + AES-GCM-256, password-derived key wrapping via PBKDF2 +
AES-GCM).

## Quick start

```bash
cd client
npm install
npm run dev      # http://localhost:5173
```

> Requires Node 20.19+ or 22.12+ (Vite 7).

The login screen has two **demo buttons** ("Sign in as Alice" / "Sign in as
Bob"). Open one in this tab/browser and the other in a different tab or
browser, then chat between them — that's the fastest way to evaluate the app.
The first click on each button registers the account on the server (generating
a fresh keypair locally). Subsequent clicks just sign in.

## Architecture

```
┌────────────────────────────────────┐         ┌────────────────────────────┐
│            Browser (client)        │         │   WhisperBox API (server)  │
│                                    │         │                            │
│  ┌─────────────┐  ┌─────────────┐  │  HTTPS  │  ┌──────────────────────┐  │
│  │  AuthPage   │  │  ChatPage   │  │ ──────▶ │  │  /auth /users        │  │
│  └─────┬───────┘  └──────┬──────┘  │         │  │  /conversations      │  │
│        │                 │         │   WSS   │  │  /messages   /ws     │  │
│  ┌─────▼─────────────────▼──────┐  │ ──────▶ │  └──────────────────────┘  │
│  │       AuthContext            │  │         │                            │
│  │  • RSA private key (in mem)  │  │         │   Stores only:             │
│  │  • RSA public key            │  │         │   • bcrypt(password)       │
│  └──────┬─────────────────┬─────┘  │         │   • public_key (b64)       │
│         │                 │        │         │   • wrapped_private_key    │
│  ┌──────▼──────┐   ┌──────▼─────┐  │         │   • pbkdf2_salt            │
│  │  crypto/    │   │   api/     │  │         │   • ciphertext blobs       │
│  │  keys.js    │   │  client.js │  │         │                            │
│  │  messages.js│   │  socket.js │  │         │   Plaintext: never seen    │
│  └─────────────┘   └────────────┘  │         │                            │
│         │                          │         └────────────────────────────┘
│  ┌──────▼──────────┐               │
│  │  IndexedDB      │  session record only
│  │  (storage/db.js)│  (refresh token, username)
│  └─────────────────┘
└────────────────────────────────────┘
```

### Module layout

```
client/src/
├── crypto/
│   ├── keys.js        RSA-OAEP keypair, PBKDF2-AES-GCM wrap/unwrap of private key
│   ├── messages.js    Per-message AES-GCM encryption + RSA-OAEP key wrap
│   └── base64.js      ArrayBuffer ⇄ base64 / UTF-8 helpers
├── api/
│   ├── client.js      fetch wrapper with auto token refresh
│   ├── endpoints.js   typed wrappers for /auth /users /conversations /messages
│   ├── socket.js      WebSocket client with exponential-backoff reconnect
│   └── config.js      base URLs
├── storage/db.js      IndexedDB session record (refresh token only)
├── context/AuthContext.jsx   register / login / logout / loginOrRegister flows
├── pages/
│   ├── AuthPage.jsx   login + register + demo buttons
│   └── ChatPage.jsx   sidebar + chat shell, manages WS connection
├── components/
│   ├── Sidebar.jsx    conversation list + user search
│   ├── ChatArea.jsx   message list, encrypt-on-send, decrypt-on-receive
│   └── Avatar.jsx
├── demo/users.js      hardcoded demo account credentials
└── styles/global.css  WhatsApp-inspired dark theme
```

## Encryption flow

### Registration (account creation)

```
        ┌─ user picks password ─┐
        │                       │
        ▼                       │
1. Generate RSA-OAEP-2048 keypair (extractable=true, usage=encrypt/decrypt)
2. Generate random 16-byte PBKDF2 salt
3. Derive 256-bit AES-GCM wrapping key from password+salt (250 000 iterations)
4. Export RSA private key as PKCS8 → encrypt with AES-GCM (random 12-byte IV)
   wrapped_private_key = base64( IV || ciphertext+tag )
5. Export RSA public key as SPKI → base64
6. POST /auth/register { username, display_name, password,
                         public_key, wrapped_private_key, pbkdf2_salt }
7. Server bcrypt-hashes the password, stores key blobs verbatim,
   returns access + refresh tokens.
```

### Login (key recovery)

```
1. POST /auth/login { username, password }
2. Server returns wrapped_private_key, pbkdf2_salt, public_key + tokens.
3. Client re-derives the same AES-GCM wrapping key from password+salt.
4. AES-GCM-decrypts the wrapped blob → PKCS8 → importKey('pkcs8', RSA-OAEP).
5. Private CryptoKey is held in React state only. Never written to disk.
```

### Sending a message  (Alice → Bob)

```
1. Generate fresh AES-GCM-256 key (per message; ephemeral)
2. Generate fresh 12-byte IV
3. ciphertext = AES-GCM(aesKey, iv, plaintext)
4. encryptedKey         = RSA-OAEP(bobPublicKey,   rawAesKey)
   encryptedKeyForSelf  = RSA-OAEP(alicePublicKey, rawAesKey)
5. Send { ciphertext, iv, encryptedKey, encryptedKeyForSelf } as
   the message payload over WebSocket (or POST /messages fallback).
```

The recipient copy and the self copy are needed because RSA-OAEP is one-way
per recipient — Alice can't recover her own AES key from `encryptedKey` alone,
so we encrypt it again under her own public key for her sent-history view.

### Receiving / loading history

```
1. Pull messages via WS frames or GET /conversations/{userId}/messages.
2. For each message: pick encryptedKeyForSelf if from_user_id == self.id,
   otherwise encryptedKey.
3. RSA-OAEP-decrypt → raw AES key → AES-GCM-decrypt(ciphertext, iv) → plaintext.
4. Failures are caught per-message and rendered as
   "Could not decrypt this message" so a single bad message doesn't break
   the conversation view.
```

## Key management

| Key                  | Where it lives                                         |
| -------------------- | ------------------------------------------------------ |
| RSA public key       | Server (b64) + in-memory CryptoKey                     |
| RSA private key      | **In-memory only** as a non-extractable CryptoKey      |
| Wrapped private key  | Server, returned at login; opaque to server            |
| PBKDF2 salt          | Server                                                 |
| Password             | Never sent except over HTTPS to `/auth/login` and `/auth/register` |
| Per-message AES key  | Generated fresh per message, exported only to be RSA-OAEP-wrapped, then discarded |

The unwrapped RSA private key is imported with `extractable=false` after
unwrapping, so even if a malicious script grabs the `CryptoKey` reference it
cannot export the raw bytes via `subtle.exportKey`. It is never serialized.
IndexedDB only holds the refresh token + the user's own id/username for
convenience on reload — no key material.

## Deviation from the WhisperBox docs

The API docs suggest using **AES-KW** for password-derived private-key
wrapping. We use **AES-GCM-256** instead because Web Crypto's `AES-KW`
implements RFC 3394 and rejects inputs whose byte length is not a multiple of
8. PKCS8 of an RSA-2048 private key is variable (1216–1219 bytes in practice),
so `wrapKey('pkcs8', priv, key, 'AES-KW')` fails non-deterministically. AES-GCM
provides equivalent (or stronger) authenticated encryption with no alignment
constraint and is also AEAD, so any tamper of the wrapped blob is detected.
The server is agnostic — `wrapped_private_key` is opaque storage.

## Security expectations

- All traffic over HTTPS / WSS.
- No plaintext persisted to `localStorage`. IndexedDB only stores the refresh
  token + last username.
- Inputs validated on the client (username length, password length, password
  confirmation match) and again by the server.
- Decryption failures are caught per-message and displayed inline rather
  than crashing the chat view.
- Tokens auto-refresh once on 401; if refresh also fails, the session is
  cleared (which discards the in-memory private key).

### Bonus considerations

- **Replay attacks** — each message has a server-assigned `id` and
  `created_at`; the client deduplicates by `id` when WS and history overlap.
  AES-GCM IVs are random per message, so identical plaintexts produce
  distinct ciphertexts. We do **not** sign or HMAC the envelope, so a
  malicious server *could* re-deliver an old ciphertext (the recipient would
  decrypt it again successfully). True replay protection would require
  including a sender-issued sequence number or timestamp in the encrypted
  plaintext and rejecting duplicates client-side.
- **Forward secrecy** — not implemented. RSA-OAEP key exchange means that if
  a user's RSA private key is later compromised, all of their historical
  ciphertext can be decrypted retroactively. A real-world deployment should
  layer on an X3DH/Double-Ratchet scheme (per-session ephemeral ECDH
  keypairs) — out of scope for Stage 4B.

## Known limitations

- **No multi-device support.** A second device that logs in will get the same
  wrapped private key and unwrap the same RSA key, but per-message random AES
  keys are fine; what's missing is any sort of device-pairing UX.
- **No message signing.** Message authenticity is implicit (only Alice
  can produce a ciphertext that decrypts under Bob's public key, *if* she
  knows the AES key), but the envelope itself isn't signed by Alice — a
  malicious server can swap `from_user_id` and the recipient has no
  cryptographic way to detect that. Adding RSASSA-PSS or Ed25519 message
  signatures is straightforward but not implemented.
- **Pagination cursor (`before`) is not yet wired into the UI.** History
  loads only the most recent page returned by the API. Scrolling-to-load
  older messages is a TODO.
- **No attachment support.** Text only.
- **Demo accounts share a password** that is committed in
  `client/src/demo/users.js`. They are intended for evaluation. Do not put
  any real conversation through them.
- **Password loss = data loss.** We cannot reset the password and recover
  history because the private key is wrapped under it.

## Submission

- **Live demo / interview** — run `npm run dev` and use the Alice/Bob demo
  buttons in two tabs. Or deploy `client/dist/` (output of `npm run build`)
  to any static host.
- **Repository** — this repo.
- **Architecture / encryption / key management / trade-offs / limitations** — above.
