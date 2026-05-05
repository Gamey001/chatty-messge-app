import { WS_BASE } from './config';
import { getAccessToken } from './client';

export function connectSocket({ onMessage, onOpen, onClose, onError }) {
  let ws = null;
  let closed = false;
  let reconnectTimer = null;
  let attempt = 0;

  function open() {
    const token = getAccessToken();
    if (!token) return;
    ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);

    ws.onopen = () => {
      attempt = 0;
      onOpen?.();
    };

    ws.onmessage = (evt) => {
      try {
        const frame = JSON.parse(evt.data);
        onMessage?.(frame);
      } catch (err) {
        console.warn('Bad WS frame', err);
      }
    };

    ws.onerror = (err) => {
      onError?.(err);
    };

    ws.onclose = () => {
      onClose?.();
      if (closed) return;
      attempt += 1;
      const delay = Math.min(1000 * 2 ** attempt, 15_000);
      reconnectTimer = setTimeout(open, delay);
    };
  }

  open();

  return {
    send(frame) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame));
        return true;
      }
      return false;
    },
    isOpen() {
      return ws?.readyState === WebSocket.OPEN;
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
