# WhisperBox API (self-hosted)

Drop-in FastAPI backend that speaks the same contract the React client in
`../client/` was originally built against. Replaces the offline
`whisperbox.koyeb.app` deployment.

The server stores **only ciphertext and opaque key blobs** — exactly like the
original API. All cryptography happens in the browser; the server cannot
read message contents.

## Run locally

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Then point the client at it. Edit `client/src/api/config.js`:

```js
export const API_BASE = 'http://localhost:8000';
export const WS_BASE  = 'ws://localhost:8000';
```

Run the client:

```bash
cd client && npm run dev
```

OpenAPI docs are at `http://localhost:8000/docs`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:///./whisperbox.db` | SQLAlchemy URL. Use a Postgres URL on hosts with ephemeral filesystems. |
| `JWT_SECRET` | random per boot | **Set this in production.** A random default means tokens are invalidated on every restart. |
| `ACCESS_TOKEN_TTL_MIN` | `30` | Access-token lifetime in minutes. |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh-token lifetime in days. |
| `CORS_ALLOW_ORIGINS` | `*` | Comma-separated origin list, or `*`. Set this to your Netlify URL in prod. |
| `PORT` | (host-provided) | Used by `Procfile`. |

## Deploy

### Render (recommended)

1. Push this repo to GitHub.
2. On https://render.com → **New Web Service** → connect the repo.
3. Settings:
   - **Root directory:** `server`
   - **Runtime:** Python
   - **Build command:** `pip install -r requirements.txt`
   - **Start command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Add environment variables (`JWT_SECRET`, `CORS_ALLOW_ORIGINS=https://<your-netlify-host>`).
5. For persistent data, attach a Render Disk mounted at `/var/data` and set
   `DATABASE_URL=sqlite:////var/data/whisperbox.db`. (Free instances spin
   down — fine for demo, not for serious use.) For real persistence, use
   Render Postgres and set `DATABASE_URL=postgresql+psycopg://...`.
6. Once green, copy the service URL and update `client/src/api/config.js`:
   ```js
   export const API_BASE = 'https://<your-service>.onrender.com';
   export const WS_BASE  = 'wss://<your-service>.onrender.com';
   ```
7. Commit + redeploy the Netlify client.

### Fly.io

```bash
cd server
fly launch --no-deploy           # accept defaults; choose region
fly secrets set JWT_SECRET=$(openssl rand -base64 48)
fly secrets set CORS_ALLOW_ORIGINS=https://<your-netlify-host>
fly volumes create wb_data --size 1 --region <region>
# In fly.toml, mount the volume at /data and set DATABASE_URL=sqlite:////data/whisperbox.db
fly deploy
```

### Koyeb (matches the original setup)

1. https://app.koyeb.com → **Create Service** → GitHub.
2. **Work directory:** `server`
3. **Run command:** `uvicorn main:app --host 0.0.0.0 --port 8000`
4. **Port:** `8000` (HTTP)
5. Environment: `JWT_SECRET`, `CORS_ALLOW_ORIGINS`.
6. Koyeb's filesystem is ephemeral on free tier, so for persistence point
   `DATABASE_URL` at a managed Postgres (Neon, Supabase, Railway, etc.).

## Tested endpoints

The client exercises every route. After boot, you can confirm the server is
alive:

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

OpenAPI / Swagger UI: `http://localhost:8000/docs`.

## Contract notes

- All request/response field names match what `client/src/api/endpoints.js`
  sends and what `client/src/context/AuthContext.jsx`, `ChatArea.jsx`, and
  `socket.js` expect.
- Message payload is stored as four opaque strings:
  `ciphertext`, `iv`, `encryptedKey`, `encryptedKeyForSelf`. The server
  treats them as base64 blobs and never inspects them.
- WS frame on receive: `{ event: "message.receive", id, from_user_id, to_user_id, payload, created_at }`.
- History (`GET /conversations/{id}/messages`) returns newest-first; the
  client reverses for display.
