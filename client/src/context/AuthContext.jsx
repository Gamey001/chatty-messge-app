import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { authApi } from '../api/endpoints';
import { setTokens, setUnauthorizedHandler, getRefreshToken } from '../api/client';
import {
  generateRsaKeypair,
  exportPublicKey,
  importPublicKey,
  wrapPrivateKey,
  unwrapPrivateKey,
} from '../crypto/keys';
import { saveSession, loadSession, clearSession } from '../storage/db';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [privateKey, setPrivateKey] = useState(null);
  const [publicKey, setPublicKey] = useState(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [error, setError] = useState(null);

  const reset = useCallback(async () => {
    setUser(null);
    setPrivateKey(null);
    setPublicKey(null);
    setTokens(null, null);
    await clearSession();
  }, []);

  // Restore session from IndexedDB on mount. The CryptoKey handles survive
  // refresh because IndexedDB persists them as keystore references, and the
  // refresh token lets us mint a new short-lived access token without
  // re-prompting for the password.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      reset();
    });

    let cancelled = false;
    (async () => {
      try {
        const saved = await loadSession();
        if (!saved || !saved.refreshToken || !saved.privateKey || !saved.user) {
          return;
        }
        // Seed the API client with the refresh token so the next 401 triggers
        // a refresh instead of a logout.
        setTokens(null, saved.refreshToken);
        // Hit /auth/me to verify the refresh token still works AND to pick up
        // any server-side profile changes (display name, etc).
        let me;
        try {
          me = await authApi.me();
        } catch (err) {
          // Refresh failed (e.g. token revoked). Clear and fall back to login.
          if (!cancelled) await clearSession();
          setTokens(null, null);
          return;
        }
        if (cancelled) return;
        setUser(me);
        setPrivateKey(saved.privateKey);
        setPublicKey(saved.publicKey);
      } catch (err) {
        console.warn('Failed to restore session:', err);
        try { await clearSession(); } catch {}
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reset]);

  async function adoptSession(authResponse, password) {
    const { access_token, refresh_token, user: profile } = authResponse;
    setTokens(access_token, refresh_token);
    const priv = await unwrapPrivateKey(
      profile.wrapped_private_key,
      profile.pbkdf2_salt,
      password
    );
    const pub = await importPublicKey(profile.public_key);
    setPrivateKey(priv);
    setPublicKey(pub);
    setUser(profile);
    await saveSession({
      refreshToken: refresh_token,
      user: profile,
      privateKey: priv,
      publicKey: pub,
    });
  }

  async function login(username, password) {
    setError(null);
    try {
      const auth = await authApi.login(username, password);
      await adoptSession(auth, password);
    } catch (err) {
      setError(err.message || 'Login failed');
      throw err;
    }
  }

  async function register({ username, displayName, password }) {
    setError(null);
    try {
      const keypair = await generateRsaKeypair();
      const publicB64 = await exportPublicKey(keypair.publicKey);
      const { wrapped_private_key, pbkdf2_salt } = await wrapPrivateKey(
        keypair.privateKey,
        password
      );
      const auth = await authApi.register({
        username,
        display_name: displayName,
        password,
        public_key: publicB64,
        wrapped_private_key,
        pbkdf2_salt,
      });
      await adoptSession(auth, password);
    } catch (err) {
      setError(err.message || 'Registration failed');
      throw err;
    }
  }

  async function loginOrRegister({ username, displayName, password }) {
    setError(null);
    try {
      const auth = await authApi.login(username, password);
      await adoptSession(auth, password);
      return { mode: 'login' };
    } catch (loginErr) {
      const isCredsError =
        /401|invalid|unauthor/i.test(loginErr.message || '') ||
        /not found/i.test(loginErr.message || '');
      if (!isCredsError) {
        setError(loginErr.message || 'Login failed');
        throw loginErr;
      }
      try {
        const keypair = await generateRsaKeypair();
        const publicB64 = await exportPublicKey(keypair.publicKey);
        const { wrapped_private_key, pbkdf2_salt } = await wrapPrivateKey(
          keypair.privateKey,
          password
        );
        const auth = await authApi.register({
          username,
          display_name: displayName,
          password,
          public_key: publicB64,
          wrapped_private_key,
          pbkdf2_salt,
        });
        await adoptSession(auth, password);
        return { mode: 'register' };
      } catch (regErr) {
        if (/409|exists|taken/i.test(regErr.message || '')) {
          setError('Demo account password mismatch. Reset the demo accounts on the server.');
        } else {
          setError(regErr.message || 'Demo sign-in failed');
        }
        throw regErr;
      }
    }
  }

  async function logout() {
    try {
      const rt = getRefreshToken();
      if (rt) await authApi.logout(rt);
    } catch {
    } finally {
      await reset();
    }
  }

  const value = {
    user,
    privateKey,
    publicKey,
    bootstrapping,
    error,
    login,
    register,
    loginOrRegister,
    logout,
    isAuthenticated: !!user && !!privateKey,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
