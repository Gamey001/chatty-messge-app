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
  history: (userId, before) => {
    const qs = before ? `?before=${encodeURIComponent(before)}` : '';
    return apiFetch(`/conversations/${userId}/messages${qs}`);
  },
};

export const messagesApi = {
  send: (to, payload) =>
    apiFetch('/messages', {
      method: 'POST',
      body: JSON.stringify({ to, payload }),
    }),
};
