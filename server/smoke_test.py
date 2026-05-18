"""End-to-end smoke test that exercises every endpoint the React client uses.

Boots NOTHING — assumes the server is already running at SMOKE_API.
Run after `uvicorn main:app ...`.
"""
import asyncio
import json
import os
import sys
import urllib.error
import urllib.request

API = os.getenv("SMOKE_API", "http://127.0.0.1:8765")
WS = os.getenv("SMOKE_WS", "ws://127.0.0.1:8765")


def req(method: str, path: str, *, token: str | None = None, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = urllib.request.Request(f"{API}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} {method} {path}: {e.read().decode()}")


def ok(msg: str) -> None:
    print(f"  ok  {msg}")


# Fake opaque blobs — server should store them verbatim, never inspect.
def blob(prefix: str) -> str:
    return prefix + "_" + os.urandom(8).hex()


def main() -> None:
    print(f"smoke test against {API}")
    suffix = os.urandom(4).hex()
    ALICE = f"alice_smoke_{suffix}"
    BOB = f"bob_smoke_{suffix}"
    globals()["ALICE"] = ALICE
    globals()["BOB"] = BOB

    # 1. Health
    h = req("GET", "/health")
    assert h.get("status") == "ok", h
    ok("/health")

    # 2. Register Alice
    alice_pw = "alice-password-12345"
    alice = req("POST", "/auth/register", body={
        "username": ALICE,
        "display_name": "Alice Smoke",
        "password": alice_pw,
        "public_key": blob("alice-pub"),
        "wrapped_private_key": blob("alice-wpk"),
        "pbkdf2_salt": blob("alice-salt"),
    })
    assert alice["user"]["username"] == ALICE
    assert alice["user"]["wrapped_private_key"].startswith("alice-wpk")
    assert alice["user"]["pbkdf2_salt"].startswith("alice-salt")
    assert alice["access_token"] and alice["refresh_token"]
    alice_id = alice["user"]["id"]
    a_tok = alice["access_token"]
    a_ref = alice["refresh_token"]
    ok(f"register alice -> id={alice_id[:8]}…")

    # 3. Duplicate register fails 409
    try:
        req("POST", "/auth/register", body={
            "username": ALICE, "display_name": "x", "password": alice_pw,
            "public_key": "x", "wrapped_private_key": "x", "pbkdf2_salt": "x",
        })
        raise SystemExit("duplicate register should have failed")
    except SystemExit as e:
        assert "409" in str(e), e
        ok("duplicate register -> 409")

    # 4. Register Bob
    bob_pw = "bob-password-12345"
    bob = req("POST", "/auth/register", body={
        "username": BOB,
        "display_name": "Bob Smoke",
        "password": bob_pw,
        "public_key": blob("bob-pub"),
        "wrapped_private_key": blob("bob-wpk"),
        "pbkdf2_salt": blob("bob-salt"),
    })
    bob_id = bob["user"]["id"]
    b_tok = bob["access_token"]
    ok(f"register bob -> id={bob_id[:8]}…")

    # 5. Login as Alice
    login = req("POST", "/auth/login", body={"username": ALICE, "password": alice_pw})
    assert login["user"]["id"] == alice_id
    assert login["user"]["wrapped_private_key"] == alice["user"]["wrapped_private_key"]
    ok("login returns same wrapped key blob")

    # 6. Wrong password
    try:
        req("POST", "/auth/login", body={"username": ALICE, "password": "wrong"})
        raise SystemExit("wrong password should have failed")
    except SystemExit as e:
        assert "401" in str(e), e
        ok("wrong password -> 401")

    # 7. /auth/me
    me = req("GET", "/auth/me", token=a_tok)
    assert me["id"] == alice_id and me["username"] == ALICE
    ok("/auth/me")

    # 8. Refresh
    rf = req("POST", "/auth/refresh", body={"refresh_token": a_ref})
    assert rf["access_token"], rf
    a_tok = rf["access_token"]
    ok("/auth/refresh")

    # 9. Search
    results = req("GET", "/users/search?q=bob", token=a_tok)
    assert any(u["id"] == bob_id for u in results), results
    ok(f"/users/search?q=bob -> {len(results)} hit(s)")

    # 10. Public key fetch
    pk = req("GET", f"/users/{bob_id}/public-key", token=a_tok)
    assert pk["public_key"] == bob["user"]["public_key"]
    ok("/users/{id}/public-key")

    # 11. Send message Alice -> Bob (REST)
    payload = {
        "ciphertext": blob("ct"),
        "iv": blob("iv"),
        "encryptedKey": blob("ek"),
        "encryptedKeyForSelf": blob("eks"),
    }
    sent = req("POST", "/messages", token=a_tok, body={"to": bob_id, "payload": payload})
    assert sent["from_user_id"] == alice_id and sent["to_user_id"] == bob_id
    for k in ("ciphertext", "iv", "encryptedKey", "encryptedKeyForSelf"):
        assert sent["payload"][k] == payload[k], (k, sent["payload"][k], payload[k])
    msg_id = sent["id"]
    ok(f"POST /messages -> id={msg_id[:8]}… delivered={sent['delivered']}")

    # 12. Conversation list (Alice should see Bob)
    convs = req("GET", "/conversations", token=a_tok)
    assert any(c["user_id"] == bob_id for c in convs), convs
    ok(f"/conversations (alice) -> {[c['username'] for c in convs]}")

    # 13. History
    hist = req("GET", f"/conversations/{bob_id}/messages", token=a_tok)
    assert any(m["id"] == msg_id for m in hist), hist
    assert hist[0]["payload"]["ciphertext"] == payload["ciphertext"]  # newest-first
    ok(f"/conversations/{{bob}}/messages -> {len(hist)} message(s), newest-first")

    # 14. History for unknown user -> 404 (client treats as empty)
    try:
        req("GET", "/conversations/nonexistent/messages", token=a_tok)
        raise SystemExit("unknown user history should 404")
    except SystemExit as e:
        assert "404" in str(e), e
        ok("unknown user history -> 404")

    # 15. WebSocket: connect as Bob, then Alice sends, Bob should receive frame.
    asyncio.run(ws_test(b_tok, a_tok, alice_id, bob_id))

    # 16. Logout
    out = req("POST", "/auth/logout", body={"refresh_token": a_ref})
    assert out.get("ok") is True
    ok("/auth/logout")

    # 17. Refresh after logout -> 401
    try:
        req("POST", "/auth/refresh", body={"refresh_token": a_ref})
        raise SystemExit("revoked refresh should 401")
    except SystemExit as e:
        assert "401" in str(e), e
        ok("revoked refresh -> 401")

    print("\nALL SMOKE TESTS PASSED")


async def ws_test(bob_token: str, alice_token: str, alice_id: str, bob_id: str) -> None:
    import websockets

    received = asyncio.Queue()

    async def bob_listen():
        url = f"{WS}/ws?token={bob_token}"
        async with websockets.connect(url) as ws:
            await received.put("connected")
            try:
                async for msg in ws:
                    await received.put(msg)
                    return
            except Exception:
                return

    async def bob_listen_forever():
        url = f"{WS}/ws?token={bob_token}"
        async with websockets.connect(url) as ws:
            await received.put("connected")
            async for msg in ws:
                await received.put(msg)

    listener = asyncio.create_task(bob_listen_forever())
    first = await asyncio.wait_for(received.get(), timeout=5)
    assert first == "connected"

    # On connect, the server flushes any undelivered messages — drain them
    # briefly so they don't masquerade as the live frame we're about to test.
    pending_count = 0
    while True:
        try:
            await asyncio.wait_for(received.get(), timeout=0.5)
            pending_count += 1
        except asyncio.TimeoutError:
            break
    if pending_count:
        ok(f"WS connect flushed {pending_count} pending message(s)")

    # Now Alice sends a REST message; server should push frame to Bob live.
    payload = {
        "ciphertext": blob("ws-ct"),
        "iv": blob("ws-iv"),
        "encryptedKey": blob("ws-ek"),
        "encryptedKeyForSelf": blob("ws-eks"),
    }
    sent = req("POST", "/messages", token=alice_token, body={"to": bob_id, "payload": payload})
    assert sent["delivered"] is True, f"REST should mark delivered=True since Bob's WS is open: {sent}"

    # Read frames until we see the one we just sent (or time out).
    deadline = asyncio.get_event_loop().time() + 5
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise AssertionError(f"WS frame for msg {sent['id']} not received")
        raw_frame = await asyncio.wait_for(received.get(), timeout=remaining)
        frame = json.loads(raw_frame)
        if frame.get("id") == sent["id"]:
            break

    assert frame["event"] == "message.receive", frame
    assert frame["from_user_id"] == alice_id
    assert frame["to_user_id"] == bob_id
    assert frame["payload"]["ciphertext"] == payload["ciphertext"]
    ok(f"WS push received by Bob: event={frame['event']} id={frame['id'][:8]}…")

    listener.cancel()
    try:
        await listener
    except (asyncio.CancelledError, Exception):
        pass


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"\nASSERT FAILED: {e}", file=sys.stderr)
        sys.exit(1)
    except SystemExit as e:
        print(f"\nFAILED: {e}", file=sys.stderr)
        sys.exit(1)
