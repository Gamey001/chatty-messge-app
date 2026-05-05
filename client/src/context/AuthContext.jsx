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

  useEffect(() => {
    setUnauthorizedHandler(() => {
      reset();
    });
    setBootstrapping(false);
  }, [reset]);

  async function adoptSession(authResponse, password) {
    const { access_token, refresh_token, user: profile } = authResponse;
    setTokens(access_token, refresh_token);
    const priv = await unwrapPrivateKey(
      profile.wrapped_private_key,
      profile.pbkdf2_salt,
      password
    );
    const pub = await importPublicKeyForEncrypt(profile.public_key);
    setPrivateKey(priv);
    setPublicKey(pub);
    setUser(profile);
    await saveSession({
      refreshToken: refresh_token,
      userId: profile.id,
      username: profile.username,
    });
  }

  async function importPublicKeyForEncrypt(b64) {
    return importPublicKey(b64);
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
