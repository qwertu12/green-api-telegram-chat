import { useState } from 'react';
import ChatWorkspace from './components/ChatWorkspace';
import Login from './components/Login';
import type { Session } from './chat/useChat';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  return session ? (
    <ChatWorkspace session={session} onLogout={() => setSession(null)} />
  ) : (
    <Login onConnect={setSession} />
  );
}
