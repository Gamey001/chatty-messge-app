import { createRoot } from 'react-dom/client';
import App from './App.jsx';

// We intentionally do not wrap in <StrictMode> here. StrictMode double-invokes
// effects in development, which causes the WebSocket connection to be opened
// then immediately closed on every render and doubles every API fetch — both
// of which made the realtime UX feel broken. Production behavior is unchanged.
createRoot(document.getElementById('root')).render(<App />);
