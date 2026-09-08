export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  documents?: string[];
  isError?: boolean;
};

export type ChatSession = {
  id: string;
  title: string;
  messages: ChatMessage[];
  documentHashes: string[];
  updatedAt: number;
};

const STORAGE_KEY = "chatit:sessions";
const MAX_SESSIONS = 100;

function isBrowser() {
  return typeof window !== "undefined";
}

export function loadSessions(): ChatSession[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ChatSession[];
  } catch (error) {
    console.warn("[chat-history] failed to load sessions:", error);
    return [];
  }
}

function persist(sessions: ChatSession[]) {
  if (!isBrowser()) return;
  try {
    const trimmed = sessions
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.warn("[chat-history] failed to save sessions:", error);
  }
}

function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser?.content) return "New chat";
  const text = firstUser.content.trim().replace(/\s+/g, " ");
  return text.length > 48 ? `${text.slice(0, 48)}…` : text || "New chat";
}

/** Insert or update one session, then persist the whole list. */
export function upsertSession(session: Omit<ChatSession, "title" | "updatedAt">): ChatSession[] {
  const sessions = loadSessions();
  const next: ChatSession = {
    ...session,
    title: deriveTitle(session.messages),
    updatedAt: Date.now(),
  };
  const idx = sessions.findIndex((s) => s.id === next.id);
  if (idx >= 0) sessions[idx] = next;
  else sessions.push(next);
  persist(sessions);
  return sessions;
}

export function deleteSession(id: string): ChatSession[] {
  const sessions = loadSessions().filter((s) => s.id !== id);
  persist(sessions);
  return sessions;
}

export function getSession(id: string): ChatSession | undefined {
  return loadSessions().find((s) => s.id === id);
}
