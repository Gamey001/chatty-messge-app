import { AuthProvider, useAuth } from './context/AuthContext';
import AuthPage from './pages/AuthPage';
import ChatPage from './pages/ChatPage';
import './styles/global.css';

function Router() {
  const { isAuthenticated, bootstrapping } = useAuth();
  if (bootstrapping) {
    return (
      <div className="full-spinner">
        <span className="spinner" />
        Loading…
      </div>
    );
  }
  return isAuthenticated ? <ChatPage /> : <AuthPage />;
}

export default function App() {
  return (
    <AuthProvider>
      <Router />
    </AuthProvider>
  );
}
