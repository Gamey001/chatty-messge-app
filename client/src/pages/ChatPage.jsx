import { useEffect, useRef, useState, useCallback } from 'react';
import Sidebar from '../components/Sidebar';
import ChatArea from '../components/ChatArea';
import { conversationsApi } from '../api/endpoints';
import { connectSocket } from '../api/socket';
import { useAuth } from '../context/AuthContext';

export default function ChatPage() {
  const { isAuthenticated } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [incomingFrame, setIncomingFrame] = useState(null);
  const socketRef = useRef(null);

  const refreshConversations = useCallback(async () => {
    try {
      const list = await conversationsApi.list();
      setConversations(list || []);
    } catch (e) {
      console.error('Failed to load conversations', e);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    refreshConversations();
    const interval = setInterval(refreshConversations, 5000);
    return () => clearInterval(interval);
  }, [isAuthenticated, refreshConversations]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const s = connectSocket({
      onOpen: () => setConnection('online'),
      onClose: () => setConnection('offline'),
      onError: () => setConnection('offline'),
      onMessage: (frame) => {
        setIncomingFrame({ ...frame, _t: Date.now() });
        if (frame?.type === 'message.receive' || frame?.type === 'message.sent') {
          refreshConversations();
        }
      },
    });
    socketRef.current = s;
    setConnection('connecting');
    return () => s.close();
  }, [isAuthenticated, refreshConversations]);

  return (
    <div className={`app-shell ${selected ? 'show-chat' : ''}`}>
      <Sidebar
        conversations={conversations}
        refreshConversations={refreshConversations}
        selectedUserId={selected?.user_id}
        onSelect={setSelected}
        connection={connection}
      />
      <ChatArea
        conversation={selected}
        socket={socketRef.current}
        incomingFrame={incomingFrame}
        onBack={() => setSelected(null)}
        onMessageSent={refreshConversations}
      />
    </div>
  );
}
