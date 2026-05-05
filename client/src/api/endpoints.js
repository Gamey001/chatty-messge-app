import { apiFetch } from './client';

export const authApi = {
  register: (body) =>
    apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (username, password) =>
    apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  me: () => apiFetch('/auth/me'),
  logout: (refresh_token) =>
    apiFetch('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refresh_token }),
    }),
};

export const usersApi = {
  search: (q) => apiFetch(`/users/search?q=${encodeURIComponent(q)}`),
  getPublicKey: (userId) => apiFetch(`/users/${userId}/public-key`),
};

export const conversationsApi = {
  list: () => apiFetch('/conversations'),
  history: async (userId, before) => {
    const qs = before ? `?before=${encodeURIComponent(before)}` : '';
    try {
      return await apiFetch(`/conversations/${userId}/messages${qs}`);
    } catch (err) {
      // Brand-new conversations (no messages exchanged yet) come back as
      // 404 "User not found" from the API. Treat that as an empty history.
      if (err.status === 404) return [];
      throw err;
    }
  },
};

export const messagesApi = {
  send: (to, payload) =>
    apiFetch('/messages', {
      method: 'POST',
      body: JSON.stringify({ to, payload }),
    }),
};
