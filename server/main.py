import asyncio
import hashlib
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Boolean,
    create_engine,
    func,
    or_,
    select,
)
from sqlalchemy.orm import declarative_base, sessionmaker, Session


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./whisperbox.db")
JWT_SECRET = os.getenv("JWT_SECRET", secrets.token_urlsafe(48))
ACCESS_TOKEN_TTL = timedelta(minutes=int(os.getenv("ACCESS_TOKEN_TTL_MIN", "30")))
REFRESH_TOKEN_TTL = timedelta(days=int(os.getenv("REFRESH_TOKEN_TTL_DAYS", "30")))

# Comma-separated list, or "*" for any origin. Default permissive for dev;
# set CORS_ALLOW_ORIGINS to your Netlify URL in production.
_raw_cors = os.getenv("CORS_ALLOW_ORIGINS", "*").strip()
CORS_ORIGINS = ["*"] if _raw_cors == "*" else [o.strip() for o in _raw_cors.split(",") if o.strip()]


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, future=True)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, future=True)
Base = declarative_base()


def new_id() -> str:
    return uuid.uuid4().hex


class User(Base):
    __tablename__ = "users"
    id = Column(String, primary_key=True, default=new_id)
    username = Column(String, unique=True, nullable=False, index=True)
    display_name = Column(String, nullable=False)
    password_hash = Column(String, nullable=False)
    public_key = Column(Text, nullable=False)
    wrapped_private_key = Column(Text, nullable=False)
    pbkdf2_salt = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Message(Base):
    __tablename__ = "messages"
    id = Column(String, primary_key=True, default=new_id)
    from_user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    to_user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    ciphertext = Column(Text, nullable=False)
    iv = Column(Text, nullable=False)
    encrypted_key = Column(Text, nullable=False)
    encrypted_key_for_self = Column(Text, nullable=False)
    delivered = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


Index("ix_messages_pair_created", Message.from_user_id, Message.to_user_id, Message.created_at)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    jti = Column(String, primary_key=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    revoked = Column(Boolean, nullable=False, default=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def hash_password(password: str) -> str:
    # bcrypt has a 72-byte limit; pre-hash with sha256 so long passwords are
    # accepted without silent truncation.
    pre = hashlib.sha256(password.encode("utf-8")).digest()
    return bcrypt.hashpw(pre, bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, hashed: str) -> bool:
    try:
        pre = hashlib.sha256(password.encode("utf-8")).digest()
        return bcrypt.checkpw(pre, hashed.encode("ascii"))
    except Exception:
        return False


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def make_access_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "type": "access",
        "iat": int(now_utc().timestamp()),
        "exp": int((now_utc() + ACCESS_TOKEN_TTL).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def make_refresh_token(db: Session, user_id: str) -> str:
    jti = secrets.token_urlsafe(32)
    expires = now_utc() + REFRESH_TOKEN_TTL
    db.add(RefreshToken(jti=jti, user_id=user_id, expires_at=expires))
    db.commit()
    payload = {
        "sub": user_id,
        "jti": jti,
        "type": "refresh",
        "iat": int(now_utc().timestamp()),
        "exp": int(expires.timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def decode_token(token: str, expected_type: str) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("type") != expected_type:
        raise HTTPException(status_code=401, detail="Wrong token type")
    return payload


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth or not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = auth.split(" ", 1)[1].strip()
    payload = decode_token(token, "access")
    user = db.get(User, payload["sub"])
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    display_name: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=8, max_length=512)
    public_key: str
    wrapped_private_key: str
    pbkdf2_salt: str


class LoginIn(BaseModel):
    username: str
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class LogoutIn(BaseModel):
    refresh_token: str


class UserPublic(BaseModel):
    id: str
    username: str
    display_name: str


class UserProfile(BaseModel):
    id: str
    username: str
    display_name: str
    public_key: str
    wrapped_private_key: str
    pbkdf2_salt: str


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    user: UserProfile


class RefreshOut(BaseModel):
    access_token: str


class PublicKeyOut(BaseModel):
    public_key: str


class MessagePayload(BaseModel):
    ciphertext: str
    iv: str
    encryptedKey: str
    encryptedKeyForSelf: str


class SendMessageIn(BaseModel):
    to: str
    payload: MessagePayload


class MessageOut(BaseModel):
    id: str
    from_user_id: str
    to_user_id: str
    payload: MessagePayload
    created_at: str
    delivered: bool


class ConversationOut(BaseModel):
    user_id: str
    username: str
    display_name: str
    last_message_at: Optional[str] = None


def message_to_out(m: Message, delivered_override: Optional[bool] = None) -> MessageOut:
    return MessageOut(
        id=m.id,
        from_user_id=m.from_user_id,
        to_user_id=m.to_user_id,
        payload=MessagePayload(
            ciphertext=m.ciphertext,
            iv=m.iv,
            encryptedKey=m.encrypted_key,
            encryptedKeyForSelf=m.encrypted_key_for_self,
        ),
        created_at=(m.created_at or now_utc()).isoformat(),
        delivered=delivered_override if delivered_override is not None else m.delivered,
    )


# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------
class ConnectionManager:
    def __init__(self) -> None:
        self._sockets: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._sockets.setdefault(user_id, set()).add(ws)

    async def disconnect(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            sockets = self._sockets.get(user_id)
            if not sockets:
                return
            sockets.discard(ws)
            if not sockets:
                self._sockets.pop(user_id, None)

    def is_online(self, user_id: str) -> bool:
        return bool(self._sockets.get(user_id))

    async def send_to(self, user_id: str, frame: dict) -> bool:
        sockets = list(self._sockets.get(user_id, ()))
        if not sockets:
            return False
        delivered = False
        for ws in sockets:
            try:
                await ws.send_json(frame)
                delivered = True
            except Exception:
                pass
        return delivered


manager = ConnectionManager()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="WhisperBox API (self-hosted)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"service": "whisperbox", "status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok"}


# ----- Auth -----
@app.post("/auth/register", response_model=AuthResponse)
def register(body: RegisterIn, db: Session = Depends(get_db)):
    existing = db.execute(select(User).where(User.username == body.username)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Username already exists")
    user = User(
        username=body.username,
        display_name=body.display_name,
        password_hash=hash_password(body.password),
        public_key=body.public_key,
        wrapped_private_key=body.wrapped_private_key,
        pbkdf2_salt=body.pbkdf2_salt,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return AuthResponse(
        access_token=make_access_token(user.id),
        refresh_token=make_refresh_token(db, user.id),
        user=UserProfile(
            id=user.id,
            username=user.username,
            display_name=user.display_name,
            public_key=user.public_key,
            wrapped_private_key=user.wrapped_private_key,
            pbkdf2_salt=user.pbkdf2_salt,
        ),
    )


@app.post("/auth/login", response_model=AuthResponse)
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.username == body.username)).scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return AuthResponse(
        access_token=make_access_token(user.id),
        refresh_token=make_refresh_token(db, user.id),
        user=UserProfile(
            id=user.id,
            username=user.username,
            display_name=user.display_name,
            public_key=user.public_key,
            wrapped_private_key=user.wrapped_private_key,
            pbkdf2_salt=user.pbkdf2_salt,
        ),
    )


@app.post("/auth/refresh", response_model=RefreshOut)
def refresh(body: RefreshIn, db: Session = Depends(get_db)):
    payload = decode_token(body.refresh_token, "refresh")
    record = db.get(RefreshToken, payload["jti"])
    if not record or record.revoked:
        raise HTTPException(status_code=401, detail="Refresh token revoked")
    if record.expires_at and record.expires_at.replace(tzinfo=timezone.utc) < now_utc():
        raise HTTPException(status_code=401, detail="Refresh token expired")
    return RefreshOut(access_token=make_access_token(payload["sub"]))


@app.post("/auth/logout")
def logout(body: LogoutIn, db: Session = Depends(get_db)):
    try:
        payload = jwt.decode(body.refresh_token, JWT_SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return {"ok": True}
    record = db.get(RefreshToken, payload.get("jti"))
    if record:
        record.revoked = True
        db.commit()
    return {"ok": True}


@app.get("/auth/me", response_model=UserProfile)
def me(user: User = Depends(current_user)):
    return UserProfile(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        public_key=user.public_key,
        wrapped_private_key=user.wrapped_private_key,
        pbkdf2_salt=user.pbkdf2_salt,
    )


# ----- Users -----
@app.get("/users/search", response_model=list[UserPublic])
def users_search(
    q: str = Query(min_length=1, max_length=64),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    pattern = f"%{q}%"
    rows = (
        db.execute(
            select(User)
            .where(
                or_(
                    User.username.ilike(pattern),
                    User.display_name.ilike(pattern),
                )
            )
            .order_by(User.username)
            .limit(25)
        )
        .scalars()
        .all()
    )
    return [UserPublic(id=u.id, username=u.username, display_name=u.display_name) for u in rows]


@app.get("/users/{user_id}/public-key", response_model=PublicKeyOut)
def get_public_key(
    user_id: str,
    _user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    other = db.get(User, user_id)
    if not other:
        raise HTTPException(status_code=404, detail="User not found")
    return PublicKeyOut(public_key=other.public_key)


# ----- Conversations -----
@app.get("/conversations", response_model=list[ConversationOut])
def list_conversations(user: User = Depends(current_user), db: Session = Depends(get_db)):
    # Find every peer this user has exchanged messages with, plus the most
    # recent message timestamp in that pair. SQLite-friendly: pull all
    # messages involving the user, group in Python.
    rows = (
        db.execute(
            select(Message)
            .where(or_(Message.from_user_id == user.id, Message.to_user_id == user.id))
            .order_by(Message.created_at.desc())
        )
        .scalars()
        .all()
    )
    last_at: dict[str, datetime] = {}
    for m in rows:
        peer = m.to_user_id if m.from_user_id == user.id else m.from_user_id
        if peer not in last_at:
            last_at[peer] = m.created_at or now_utc()
    if not last_at:
        return []
    peers = db.execute(select(User).where(User.id.in_(list(last_at.keys())))).scalars().all()
    out = [
        ConversationOut(
            user_id=p.id,
            username=p.username,
            display_name=p.display_name,
            last_message_at=last_at[p.id].isoformat() if last_at[p.id] else None,
        )
        for p in peers
    ]
    out.sort(key=lambda c: c.last_message_at or "", reverse=True)
    return out


@app.get("/conversations/{other_id}/messages", response_model=list[MessageOut])
def conversation_history(
    other_id: str,
    before: Optional[str] = None,
    limit: int = Query(default=100, ge=1, le=200),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    other = db.get(User, other_id)
    if not other:
        raise HTTPException(status_code=404, detail="User not found")
    stmt = select(Message).where(
        or_(
            (Message.from_user_id == user.id) & (Message.to_user_id == other_id),
            (Message.from_user_id == other_id) & (Message.to_user_id == user.id),
        )
    )
    if before:
        try:
            cutoff = datetime.fromisoformat(before.replace("Z", "+00:00"))
            stmt = stmt.where(Message.created_at < cutoff)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid 'before' timestamp")
    stmt = stmt.order_by(Message.created_at.desc()).limit(limit)
    rows = db.execute(stmt).scalars().all()
    # Newest-first; the client reverses to render oldest-first.
    return [message_to_out(m) for m in rows]


# ----- Messages -----
@app.post("/messages", response_model=MessageOut)
async def send_message(
    body: SendMessageIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    if body.to == user.id:
        raise HTTPException(status_code=400, detail="Cannot send to yourself")
    recipient = db.get(User, body.to)
    if not recipient:
        raise HTTPException(status_code=404, detail="Recipient not found")
    msg = Message(
        from_user_id=user.id,
        to_user_id=recipient.id,
        ciphertext=body.payload.ciphertext,
        iv=body.payload.iv,
        encrypted_key=body.payload.encryptedKey,
        encrypted_key_for_self=body.payload.encryptedKeyForSelf,
        delivered=False,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    frame = {
        "event": "message.receive",
        "id": msg.id,
        "from_user_id": msg.from_user_id,
        "to_user_id": msg.to_user_id,
        "payload": {
            "ciphertext": msg.ciphertext,
            "iv": msg.iv,
            "encryptedKey": msg.encrypted_key,
            "encryptedKeyForSelf": msg.encrypted_key_for_self,
        },
        "created_at": (msg.created_at or now_utc()).isoformat(),
    }
    delivered = await manager.send_to(recipient.id, frame)
    if delivered and not msg.delivered:
        msg.delivered = True
        db.commit()
        db.refresh(msg)
    return message_to_out(msg)


# ----- WebSocket -----
@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket, token: Optional[str] = Query(default=None)):
    if not token:
        await websocket.close(code=4401)
        return
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        if payload.get("type") != "access":
            raise jwt.InvalidTokenError("wrong type")
        user_id = payload["sub"]
    except jwt.InvalidTokenError:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    await manager.connect(user_id, websocket)

    # Flush any messages that arrived while the user was offline.
    db = SessionLocal()
    try:
        pending = (
            db.execute(
                select(Message)
                .where(Message.to_user_id == user_id, Message.delivered.is_(False))
                .order_by(Message.created_at.asc())
            )
            .scalars()
            .all()
        )
        for m in pending:
            try:
                await websocket.send_json(
                    {
                        "event": "message.receive",
                        "id": m.id,
                        "from_user_id": m.from_user_id,
                        "to_user_id": m.to_user_id,
                        "payload": {
                            "ciphertext": m.ciphertext,
                            "iv": m.iv,
                            "encryptedKey": m.encrypted_key,
                            "encryptedKeyForSelf": m.encrypted_key_for_self,
                        },
                        "created_at": (m.created_at or now_utc()).isoformat(),
                    }
                )
                m.delivered = True
            except Exception:
                break
        db.commit()
    finally:
        db.close()

    try:
        while True:
            # Drain client frames; the client doesn't currently send anything
            # meaningful over WS (it uses REST for sends), but we keep the
            # socket alive and reply to pings to detect dead connections.
            data = await websocket.receive_json()
            if isinstance(data, dict) and data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await manager.disconnect(user_id, websocket)
