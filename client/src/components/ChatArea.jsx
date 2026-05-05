import { useEffect, useMemo, useRef, useState } from 'react';
import { FiSend, FiLock, FiAlertTriangle, FiCheck, FiArrowLeft } from 'react-icons/fi';
import Avatar from './Avatar';
import { useAuth } from '../context/AuthContext';
import { conversationsApi, usersApi, messagesApi } from '../api/endpoints';
import { encryptMessage, decryptMessage } from '../crypto/messages';
import { importPublicKey } from '../crypto/keys';

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  const [text, setText] = useState('');
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
      try {
        const [history, pk] = await Promise.all([
          conversationsApi.history(conversation.user_id),
          usersApi.getPublicKey(conversation.user_id),
        ]);
        if (cancelled) return;
        const recipientPub = await importPublicKey(pk.public_key);
        if (cancelled) return;
        setRecipientKey(recipientPub);
        const decrypted = await decryptList(history || [], privateKey, user.id);
        if (cancelled) return;
        setMessages(decrypted.reverse());
      } catch (e) {
        if (!cancelled) setKeyError(e.message || 'Failed to load conversation');
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
    if (incomingFrame.type !== 'message.receive' && incomingFrame.type !== 'message.sent') return;
    const msg = incomingFrame.message;
    if (!msg) return;
    if (!conversation) return;
    const involvesActive =
      (msg.from_user_id === conversation.user_id && msg.to_user_id === user.id) ||
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
          { ...msg, plaintext: null, decryptError: e.message || 'Decryption failed' },
        ]);
      }
    })();
  }, [incomingFrame, conversation, privateKey, user?.id]);

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (taRef.current) {
      taRef.current.style.height = 'auto';
      taRef.current.style.height = Math.min(taRef.current.scrollHeight, 160) + 'px';
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
    setText('');
    try {
      const payload = await encryptMessage(value, recipientKey, publicKey);
      const sentViaWs = socket?.send({
        type: 'message.send',
        to: conversation.user_id,
        payload,
      });
      if (!sentViaWs) {
        const created = await messagesApi.send(conversation.user_id, payload);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId ? { ...m, id: created.id, delivered: created.delivered, pending: false, created_at: created.created_at } : m
          )
        );
      }
      onMessageSent?.();
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? { ...m, failed: true, pending: false, error: e.message } : m))
      );
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
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
            Pick a conversation, or search a username on the left to start a new one.
            Plaintext never leaves this device — the server only sees ciphertext.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="chat-area">
      <header className="chat-header">
        <button className="icon-btn" onClick={onBack} style={{ display: 'none' }} aria-label="Back">
          <FiArrowLeft />
        </button>
        <Avatar name={conversation.display_name || conversation.username} />
        <div className="info">
          <div className="name">{conversation.display_name}</div>
          <div className="sub">
            @{conversation.username}
            <span className="encrypted-pill">
              <FiLock size={10} />
              E2EE
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
            Messages are end-to-end encrypted. Not even WhisperBox can read them.
          </div>
        )}
        {loading && <div className="empty-list">Decrypting history…</div>}
        {!loading && messages.length === 0 && !keyError && (
          <div className="empty-list">Say hi! Your first message will be encrypted.</div>
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
    <div className={`bubble-row ${isOwn ? 'out' : 'in'}`}>
      <div className={`bubble ${isOwn ? 'out' : 'in'} ${m.failed ? 'failed' : ''}`}>
        {m.decryptError ? (
          <span style={{ fontStyle: 'italic', color: 'var(--wb-text-muted)' }}>
            <FiAlertTriangle /> Could not decrypt this message
          </span>
        ) : (
          <span>{m.plaintext}</span>
        )}
        <div className="bubble-meta">
          {formatTime(m.created_at)}
          {isOwn && !m.failed && (
            <FiCheck color={m.delivered ? 'var(--wb-accent)' : 'var(--wb-text-muted)'} size={14} />
          )}
          {m.failed && <FiAlertTriangle color="var(--wb-danger)" size={12} title={m.error} />}
          {m.pending && <span className="spinner" style={{ width: 10, height: 10 }} />}
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
      out.push({ ...m, plaintext: null, decryptError: e.message || 'Decryption failed' });
    }
  }
  return out;
}
