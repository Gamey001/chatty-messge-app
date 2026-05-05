import { useState } from "react";
import { FiLock, FiShield, FiUsers } from "react-icons/fi";
import { useAuth } from "../context/AuthContext";
import { DEMO_USERS } from "../demo/users";

export default function AuthPage() {
  const { login, register, loginOrRegister } = useAuth();
  const [mode, setMode] = useState("login");
  const [demoBusy, setDemoBusy] = useState(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState(null);

  function validate() {
    if (!username.trim()) return "Username is required";
    if (username.trim().length < 3)
      return "Username must be at least 3 characters";
    if (!password) return "Password is required";
    if (password.length < 8) return "Password must be at least 8 characters";
    if (mode === "register") {
      if (!displayName.trim()) return "Display name is required";
      if (password !== confirm) return "Passwords do not match";
    }
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErrMsg(null);
    const err = validate();
    if (err) {
      setErrMsg(err);
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") {
        await login(username.trim(), password);
      } else {
        await register({
          username: username.trim(),
          displayName: displayName.trim(),
          password,
        });
      }
    } catch (e) {
      setErrMsg(e.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={handleSubmit}>
        <div className="auth-brand">
          <FiShield />
          <span>WhisperBox</span>
        </div>
        <h1>{mode === "login" ? "Welcome back" : "Create your account"}</h1>
        {/* <p className="subtitle">
          {mode === "login"
            ? // ? 'Sign in to unwrap your private key and decrypt your messages.'
              ""
            : "We generate your encryption keys in this browser. Your password protects your private key — we cannot recover it for you."}
        </p> */}

        <label>Username</label>
        <input
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="alice_92"
          disabled={busy}
        />

        {mode === "register" && (
          <>
            <label>Display name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Alice"
              disabled={busy}
            />
          </>
        )}

        <label>Password</label>
        <input
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          disabled={busy}
        />

        {mode === "register" && (
          <>
            <label>Confirm password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
              disabled={busy}
            />
          </>
        )}

        {errMsg && <div className="auth-error">{errMsg}</div>}

        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? (
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <span className="spinner" />
              {mode === "login" ? "Unwrapping key…" : "Generating keys…"}
            </span>
          ) : mode === "login" ? (
            "Sign in"
          ) : (
            "Create account"
          )}
        </button>

        <div className="auth-switch">
          {mode === "login" ? (
            <>
              New to WhisperBox?{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setMode("register");
                  setErrMsg(null);
                }}
              >
                Create an account
              </a>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setMode("login");
                  setErrMsg(null);
                }}
              >
                Sign in
              </a>
            </>
          )}
        </div>

        <div className="demo-section">
          <div className="demo-divider">
            <span>Or try the live demo</span>
          </div>
          <div className="demo-hint">
            <FiUsers size={12} /> Open each button in a separate tab or browser,
            then chat between them.
          </div>
          <div className="demo-buttons">
            {DEMO_USERS.map((u) => (
              <button
                type="button"
                key={u.username}
                className="demo-btn"
                disabled={busy || !!demoBusy}
                onClick={async () => {
                  setErrMsg(null);
                  setDemoBusy(u.username);
                  try {
                    await loginOrRegister({
                      username: u.username,
                      displayName: u.display_name,
                      password: u.password,
                    });
                  } catch (e) {
                    setErrMsg(e.message || "Demo sign-in failed");
                  } finally {
                    setDemoBusy(null);
                  }
                }}
              >
                {demoBusy === u.username ? (
                  <span className="spinner" />
                ) : (
                  <span className="demo-avatar" style={{ background: u.color }}>
                    {u.display_name[0]}
                  </span>
                )}
                <span style={{ textAlign: "left" }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    Sign in as {u.display_name.split(" ")[0]}
                  </div>
                  <div
                    style={{ fontSize: 11.5, color: "var(--wb-text-muted)" }}
                  >
                    @{u.username}
                  </div>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            marginTop: 22,
            fontSize: 12,
            color: "var(--wb-text-muted)",
            display: "flex",
            gap: 6,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FiLock size={12} />
          End-to-end encrypted · Web Crypto API
        </div>
      </form>
    </div>
  );
}
