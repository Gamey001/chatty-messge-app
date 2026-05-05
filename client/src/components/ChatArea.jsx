import { useEffect, useMemo, useRef, useState } from "react";
import {
  FiSend,
  FiLock,
  FiAlertTriangle,
  FiCheck,
  FiArrowLeft,
} from "react-icons/fi";
import Avatar from "./Avatar";
import { useAuth } from "../context/AuthContext";
import { conversationsApi, usersApi, messagesApi } from "../api/endpoints";
import { encryptMessage, decryptMessage } from "../crypto/messages";
import { importPublicKey } from "../crypto/keys";

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ChatArea({
  conversation,
  socket,
  incomingFrame,
  onBack,
  onMessageSent,
}) {
  const { user, privateKey, publicKey } = useAuth();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [recipientKey, setRecipientKey] = useState(null);
  const [keyError, setKeyError] = useState(null);
  const scrollerRef = useRef(null);
  const taRef = useRef(null);

  useEffect(() => {
    if (!conversation) return;
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    setRecipientKey(null);
    setKeyError(null);

    (async () => {
      // Fetch the recipient's public key first — without it we cannot
      // encrypt, and there's no point loading history we can't show. We
      // run history in parallel and tolerate it failing independently.
      const historyPromise = conversationsApi
        .history(conversation.user_id)
        .catch(() => []);
      try {
        const pk = await usersApi.getPublicKey(conversation.user_id);
        if (cancelled) return;
        const recipientPub = await importPublicKey(pk.public_key);
        if (cancelled) return;
        setRecipientKey(recipientPub);
      } catch (e) {
        if (!cancelled) {
          setKeyError(
            e.status === 404
              ? "This account no longer exists on the server."
              : e.message || "Could not load this user's public key."
          );
          setLoading(false);
        }
        return;
      }
      try {
        const history = await historyPromise;
        if (cancelled) return;
        const decrypted = await decryptList(history || [], privateKey, user.id);
        if (cancelled) return;
        setMessages(decrypted.reverse());
      } catch (e) {
        console.warn("History load failed:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversation, privateKey, user?.id]);

  useEffect(() => {
    if (!incomingFrame) return;
    // Server frames use { event, ...flat fields } — not { type, message: {...} }.
    if (incomingFrame.event !== "message.receive") return;
    const msg = {
      id: incomingFrame.id,
      from_user_id: incomingFrame.from_user_id,
      to_user_id: incomingFrame.to_user_id,
      payload: incomingFrame.payload,
      created_at: incomingFrame.created_at,
      delivered: true,
    };
    if (!msg.id || !msg.payload) return;
    if (!conversation) return;
    const involvesActive =
      (msg.from_user_id === conversation.user_id &&
        msg.to_user_id === user.id) ||
      (msg.from_user_id === user.id && msg.to_user_id === conversation.user_id);
    if (!involvesActive) return;
    (async () => {
      try {
        const isOwn = msg.from_user_id === user.id;
        const plaintext = await decryptMessage(msg.payload, privateKey, isOwn);
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, { ...msg, plaintext }];
        });
      } catch (e) {
        setMessages((prev) => [
          ...prev,
          {
            ...msg,
            plaintext: null,
            decryptError: e.message || "Decryption failed",
          },
        ]);
      }
    })();
  }, [incomingFrame, conversation, privateKey, user?.id]);

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [messages]);

  // The server doesn't push REST-sent messages to an already-connected
  // recipient over WebSocket — they only arrive on the next reconnect's
  // flush. To get a live-feeling experience we poll the conversation
  // history every few seconds while it's open and merge in any new ids.
  useEffect(() => {
    if (!conversation || !privateKey || !recipientKey) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const list = await conversationsApi.history(conversation.user_id);
        if (cancelled || !Array.isArray(list)) return;
        const decrypted = await decryptList(list, privateKey, user.id);
        if (cancelled) return;
        setMessages((prev) => {
          const known = new Set(prev.map((m) => m.id));
          const newOnes = decrypted
            .filter((m) => !known.has(m.id))
            .map((m) => ({ ...m, delivered: m.delivered ?? true }));
          if (!newOnes.length) return prev;
          // If a polled message matches an optimistic temp entry by plaintext
          // + sender + tight timestamp, swallow the temp so the user sees
          // exactly one bubble.
          const filtered = prev.filter((m) => {
            if (!m.pending) return true;
            return !newOnes.some(
              (n) =>
                n.from_user_id === m.from_user_id &&
                n.to_user_id === m.to_user_id &&
                n.plaintext === m.plaintext &&
                Math.abs(new Date(n.created_at) - new Date(m.created_at)) <
                  10_000
            );
          });
          return [...filtered, ...newOnes].sort(
            (a, b) => new Date(a.created_at) - new Date(b.created_at)
          );
        });
      } catch {}
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [conversation, privateKey, recipientKey, user?.id]);

  useEffect(() => {
    if (taRef.current) {
      taRef.current.style.height = "auto";
      taRef.current.style.height =
        Math.min(taRef.current.scrollHeight, 160) + "px";
    }
  }, [text]);

  async function handleSend() {
    const value = text.trim();
    if (!value || sending || !recipientKey || !publicKey || !privateKey) return;
    setSending(true);
    const tempId = `tmp-${Date.now()}`;
    const optimistic = {
      id: tempId,
      from_user_id: user.id,
      to_user_id: conversation.user_id,
      plaintext: value,
      created_at: new Date().toISOString(),
      delivered: false,
      pending: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    setText("");
    try {
      const payload = await encryptMessage(value, recipientKey, publicKey);
      // Always use REST for sends. The WS API doesn't echo a sent-confirmation
      // frame back to the sender, which made WS-sent messages stay in their
      // optimistic "pending" state forever. REST gives us the persisted record
      // synchronously so we can swap the temp message for the real one.
      const created = await messagesApi.send(conversation.user_id, payload);
      setMessages((prev) => {
        // If the poll already merged the server-issued message into the list
        // while the REST call was in flight, drop the optimistic temp entry
        // instead of leaving a duplicate.
        if (prev.some((m) => m.id === created.id)) {
          return prev.filter((m) => m.id !== tempId);
        }
        return prev.map((m) =>
          m.id === tempId
            ? {
                ...m,
                id: created.id,
                delivered: created.delivered,
                pending: false,
                created_at: created.created_at,
              }
            : m
        );
      });
      onMessageSent?.();
    } catch (e) {
      const friendly =
        e.status === 404
          ? "Recipient no longer exists on the server."
          : e.message || "Send failed";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempId
            ? { ...m, failed: true, pending: false, error: friendly }
            : m
        )
      );
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!conversation) {
    return (
      <main className="chat-area">
        <div className="chat-empty">
          <FiLock size={48} color="var(--wb-accent)" />
          <h2>Your messages are encrypted</h2>
          <p>
            Pick a conversation, or search a username on the left to start a new
            one. Plaintext never leaves this device — the server only sees
            ciphertext.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="chat-area">
      <header className="chat-header">
        <button
          className="icon-btn"
          onClick={onBack}
          style={{ display: "none" }}
          aria-label="Back"
        >
          <FiArrowLeft />
        </button>
        <Avatar name={conversation.display_name || conversation.username} />
        <div className="info">
          <div className="name">{conversation.display_name}</div>
          <div className="sub">
            @{conversation.username}
            <span className="encrypted-pill">
              <FiLock size={10} />
              {/* E2EE */}
            </span>
          </div>
        </div>
      </header>

      <div className="messages" ref={scrollerRef}>
        {keyError && (
          <div className="encryption-banner">
            <FiAlertTriangle />
            {keyError}
          </div>
        )}
        {!keyError && (
          <div className="encryption-banner">
            <FiLock />
            {/* Messages are end-to-end encrypted. Not even WhisperBox can read them. */}
            Messages are end-to-end encrypted.
          </div>
        )}
        {/* {loading && <div className="empty-list">Decrypting history…</div>} */}
        {loading && <div className="empty-list">loading history...</div>}

        {!loading && messages.length === 0 && !keyError && (
          <div className="empty-list">
            Say hi! Your first message will be encrypted.
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} isOwn={m.from_user_id === user.id} />
        ))}
      </div>

      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder="Type an encrypted message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!recipientKey || !!keyError}
        />
        <button
          className="send"
          onClick={handleSend}
          disabled={!text.trim() || sending || !recipientKey}
          aria-label="Send"
        >
          <FiSend />
        </button>
      </div>
    </main>
  );
}

function MessageBubble({ m, isOwn }) {
  return (
    <div className={`bubble-row ${isOwn ? "out" : "in"}`}>
      <div
        className={`bubble ${isOwn ? "out" : "in"} ${m.failed ? "failed" : ""}`}
      >
        {m.decryptError ? (
          <span style={{ fontStyle: "italic", color: "var(--wb-text-muted)" }}>
            <FiAlertTriangle /> Could not decrypt this message
          </span>
        ) : (
          <span>{m.plaintext}</span>
        )}
        <div className="bubble-meta">
          {formatTime(m.created_at)}
          {isOwn && !m.failed && (
            <FiCheck
              color={m.delivered ? "var(--wb-accent)" : "var(--wb-text-muted)"}
              size={14}
            />
          )}
          {m.failed && (
            <FiAlertTriangle
              color="var(--wb-danger)"
              size={12}
              title={m.error}
            />
          )}
          {m.pending && (
            <span className="spinner" style={{ width: 10, height: 10 }} />
          )}
        </div>
      </div>
    </div>
  );
}

async function decryptList(list, privateKey, selfId) {
  const out = [];
  for (const m of list) {
    try {
      const isOwn = m.from_user_id === selfId;
      const plaintext = await decryptMessage(m.payload, privateKey, isOwn);
      out.push({ ...m, plaintext });
    } catch (e) {
      out.push({
        ...m,
        plaintext: null,
        decryptError: e.message || "Decryption failed",
      });
    }
  }
  return out;
}
