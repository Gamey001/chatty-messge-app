import { useEffect, useMemo, useState } from "react";
import { FiSearch, FiLogOut, FiEdit, FiLock } from "react-icons/fi";
import Avatar from "./Avatar";
import { useAuth } from "../context/AuthContext";
import { conversationsApi, usersApi } from "../api/endpoints";

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const diffDays = Math.floor((now - d) / 86_400_000);
  if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: "short" });
  }
  return d.toLocaleDateString();
}

export default function Sidebar({
  conversations,
  refreshConversations,
  selectedUserId,
  onSelect,
  connection,
}) {
  const { user, logout } = useAuth();
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await usersApi.search(query.trim());
        if (!cancelled) setSearchResults(res || []);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const filteredConvs = useMemo(() => {
    if (!query.trim() || searchResults) return conversations;
    return conversations;
  }, [conversations, query, searchResults]);

  function pickSearchUser(u) {
    if (u.id === user?.id) return;
    onSelect({
      user_id: u.id,
      username: u.username,
      display_name: u.display_name,
      last_message_at: null,
    });
    setQuery("");
    setSearchResults(null);
    refreshConversations();
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <div className="me">
          <Avatar name={user?.display_name || user?.username} />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontWeight: 500,
                fontSize: 14,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {user?.display_name}
            </div>
            <div className={`connection-status ${connection}`}>
              <span className="dot" />
              {connection === "online"
                ? "Realtime connected"
                : connection === "connecting"
                ? "Connecting…"
                : "Offline (REST fallback)"}
            </div>
          </div>
        </div>
        <button className="icon-btn" title="Log out" onClick={logout}>
          <FiLogOut />
        </button>
      </header>

      <div className="search-row">
        <div className="search-wrap">
          <FiSearch className="search-icon" size={16} />
          <input
            className="search-input"
            placeholder="Search users to start a chat (type 'demo' for test)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="conv-list">
        {searchResults !== null ? (
          <>
            {searching && <div className="empty-list">Searching…</div>}
            {!searching && searchResults.length === 0 && (
              <div className="empty-list">No users matched "{query}"</div>
            )}
            {searchResults
              .filter((u) => u.id !== user?.id)
              .map((u) => (
                <div
                  key={u.id}
                  className="user-search-result"
                  onClick={() => pickSearchUser(u)}
                >
                  <Avatar name={u.display_name || u.username} />
                  <div className="conv-meta">
                    <div className="conv-name">{u.display_name}</div>
                    <div className="conv-sub">@{u.username}</div>
                  </div>
                  <FiEdit color="var(--wb-text-muted)" />
                </div>
              ))}
          </>
        ) : (
          <>
            {filteredConvs.length === 0 && (
              <div className="empty-list">
                <FiLock style={{ marginBottom: 8 }} />
                <div>No conversations yet.</div>
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  Search a username above to start one.
                </div>
              </div>
            )}
            {filteredConvs.map((c) => (
              <div
                key={c.user_id}
                className={`conv-item ${
                  selectedUserId === c.user_id ? "active" : ""
                }`}
                onClick={() => onSelect(c)}
              >
                <Avatar name={c.display_name || c.username} />
                <div className="conv-meta">
                  <div className="conv-name">{c.display_name}</div>
                  <div className="conv-sub">
                    <FiLock size={10} />
                    Encrypted · @{c.username}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--wb-text-muted)" }}>
                  {formatTime(c.last_message_at)}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
