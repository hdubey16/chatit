"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Image from "next/image";
import { User, FileText, RotateCw } from "lucide-react";
import DeepDocChatInput, { fileKey } from "@/components/deepdoc/deepdoc-chat-input";
import { ArcRevealHero } from "@/components/ruixen/arc-reveal-hero";
import GlobeStudy from "@/components/ui/globe-study";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { cn } from "@/lib/utils";
import { loadSessions, upsertSession, deleteSession, type ChatSession, type ChatMessage } from "@/lib/chat-history";

type Message = ChatMessage;

function newSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function DeepDocChat() {
  const [hasStarted, setHasStarted] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [indexing, setIndexing] = useState<{
    status: "idle" | "extracting" | "indexing" | "done" | "error";
    message?: string;
    hashes?: string[];
    /** Per-file progress, keyed by fileKey(file) — each concurrently
     *  uploading file tracks its own indexed/total instead of sharing one. */
    files: Record<string, { status: "extracting" | "indexing" | "done" | "error"; indexed: number; total: number }>;
  }>({ status: "idle", hashes: [], files: {} });
  const scrollRef = useRef<HTMLDivElement>(null);
  const indexingPromiseRef = useRef<Promise<string[] | null> | null>(null);
  // State updates are asynchronous. Keep the active scope in a ref so the
  // first question submitted after indexing cannot capture stale hashes.
  const documentHashesRef = useRef<string[]>([]);
  // Files from the most recent upload batch that did NOT finish indexing.
  // A chat request must never be sent while any selected upload is still
  // pending or has failed — a partial hash list biases retrieval toward the
  // documents that finished first and silently loses the last-uploaded file.
  const batchFailedFilesRef = useRef<string[]>([]);

  // Auto-scroll to bottom when messages change, only if near bottom
  useEffect(() => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 150;
      if (isNearBottom) {
        scrollRef.current.scrollTop = scrollHeight;
      }
    }
  }, [messages]);

  // Load saved chats from localStorage on first mount, and restore the most
  // recently updated one so a refresh doesn't lose the conversation.
  useEffect(() => {
    const saved = loadSessions();
    setSessions(saved);
    const mostRecent = saved[0]; // loadSessions/persist keep newest-first order
    if (mostRecent) {
      setActiveSessionId(mostRecent.id);
      setMessages(mostRecent.messages);
      documentHashesRef.current = mostRecent.documentHashes;
      setIndexing((p) => ({ ...p, hashes: mostRecent.documentHashes }));
      setHasStarted(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active session to localStorage whenever its messages change.
  useEffect(() => {
    if (!activeSessionId || messages.length === 0) return;
    const updated = upsertSession({
      id: activeSessionId,
      messages,
      documentHashes: documentHashesRef.current,
    });
    setSessions(updated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeSessionId]);

  const [isLoading, setIsLoading] = useState(false);

  // Per-file percentage, keyed by fileKey(file) — each attached file shows
  // its own progress instead of every file mirroring one shared number.
  const indexingProgressByKey = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [key, f] of Object.entries(indexing.files)) {
      out[key] = f.total > 0 ? Math.round((f.indexed / f.total) * 100) : 0;
    }
    return out;
  }, [indexing.files]);

  // Overall batch progress (shown on the send button) — average of every
  // in-flight file's own percentage, not one file's total overwriting another's.
  const overallIndexingProgress = useMemo(() => {
    const values = Object.values(indexingProgressByKey);
    if (!values.length) return undefined;
    return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
  }, [indexingProgressByKey]);

  // ── SSE-based upload with live progress ───────────────────────────────
  // `key` (fileKey(file)) scopes every progress update to this file only, so
  // concurrently uploading files each show their own percentage instead of
  // all sharing — and overwriting — one global indexed/total pair.
  const uploadWithProgress = useCallback(async (uploadForm: FormData, key: string): Promise<string | null> => {
    const defaultFileProgress = { status: "extracting" as const, indexed: 0, total: 0 };
    const updateFile = (patch: Partial<{ status: "extracting" | "indexing" | "done" | "error"; indexed: number; total: number }>) => {
      setIndexing((p) => ({
        ...p,
        files: {
          ...p.files,
          [key]: { ...defaultFileProgress, ...p.files[key], ...patch },
        },
      }));
    };

    return new Promise((resolve) => {
      // True once a `done` or `error` SSE event arrived. The stream can also
      // close with neither — when the indexing job dies server-side (server
      // restart, crash). That must surface as a failure, not a silent drop.
      let settled = false;
      fetch("/api/upload", { method: "POST", body: uploadForm })
        .then(async (res) => {
          if (!res.body) { resolve(null); return; }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === "status") {
                  updateFile({ status: "extracting" });
                } else if (evt.type === "extraction_progress") {
                  updateFile({ status: "extracting", indexed: evt.current, total: evt.total });
                } else if (evt.type === "total") {
                  updateFile({ status: "indexing", indexed: 0, total: evt.total });
                } else if (evt.type === "progress") {
                  updateFile({ status: "indexing", indexed: evt.indexed, total: evt.total });
                } else if (evt.type === "done") {
                  const newHashes = Array.from(new Set([...documentHashesRef.current, evt.hash]));
                  documentHashesRef.current = newHashes;
                  updateFile({ status: "done", indexed: evt.indexed, total: evt.total });
                  setIndexing((p) => ({ ...p, hashes: newHashes }));
                  settled = true;
                  resolve(evt.hash);
                } else if (evt.type === "error") {
                  updateFile({ status: "error" });
                  setIndexing((p) => ({ ...p, message: evt.error }));
                  settled = true;
                  resolve(null);
                }
              } catch { /* ignore bad JSON */ }
            }
          }
          if (!settled) {
            // Stream closed without `done`/`error` — the indexing job died
            // server-side (restart/crash). Mark it loudly instead of silently
            // dropping this document from the chat's hash list.
            updateFile({ status: "error" });
            setIndexing((p) => ({
              ...p,
              message: "Indexing was interrupted before completion — please retry the upload.",
            }));
          }
          resolve(null);
        })
        .catch(() => { updateFile({ status: "error" }); resolve(null); });
    });
  }, []);

  // Multiple files upload/index concurrently (bounded pool) instead of one at
  // a time — each has its own SSE stream, MongoDB document hash, and job
  // entry, so they don't interfere with each other; this just stops the
  // batch's total wall-clock time from being the sum of every file's time.
  const UPLOAD_CONCURRENCY = 3;

  const startPdfIndexing = useCallback((files: File[]) => {
    if (!files.length) return;

    const task = (async () => {
      const prevHashes = indexingPromiseRef.current ? await indexingPromiseRef.current.catch(() => []) : [];
      setIndexing((p) => ({ ...p, status: "extracting", message: "Extracting document pages…" }));

      const newHashes: string[] = [];
      const failedFiles: string[] = [];
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < files.length) {
          const file = files[nextIndex++];
          const form = new FormData();
          form.append("files", file);
          const hash = await uploadWithProgress(form, fileKey(file));
          if (hash) newHashes.push(hash);
          else failedFiles.push(file.name);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker),
      );

      const allHashes = Array.from(new Set([...(prevHashes || []), ...newHashes, ...documentHashesRef.current]));
      // Record which selected files did NOT finish indexing. The chat gate in
      // handleSubmit blocks sending until every selected upload completed.
      batchFailedFilesRef.current = failedFiles;
      setIndexing((p) => ({
        ...p,
        status: failedFiles.length ? "error" : "done",
        message: failedFiles.length
          ? `Indexing failed for: ${failedFiles.join(", ")}. Please re-attach and retry.`
          : p.message,
        hashes: allHashes,
      }));
      return allHashes;
    })();

    indexingPromiseRef.current = task;
    void task.finally(() => {
      if (indexingPromiseRef.current === task) {
        indexingPromiseRef.current = null;
      }
    });
  }, [uploadWithProgress]);

  const handleSubmit = async (data: any) => {
    if (!data.message.trim() && (!data.files || data.files.length === 0) && (!data.pastedContent || data.pastedContent.length === 0)) return;

    let finalMessage = data.message;
    if (data.pastedContent && data.pastedContent.length > 0) {
      const pasteText = data.pastedContent.map((p: any) => `\n---\n${p.content}\n---`).join("\n\n");
      finalMessage = finalMessage.trim() ? `${finalMessage}\n\n${pasteText}` : pasteText.trim();
    }

    // Optimistically add user message
    const newMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: finalMessage,
      documents: data.files ? data.files.map((f: any) => f.file.name) : [],
    };

    if (!activeSessionId) setActiveSessionId(newSessionId());
    setMessages((prev) => [...prev, newMsg]);
    setIsLoading(true);

    // Force scroll to bottom on new user message
    setTimeout(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, 10);

    try {
      const formData = new FormData();
      const payload = {
        messages: [...messages, newMsg].map((m) => ({
          role: m.role,
          content: m.content
        })),
        model: data.model,
        temperature: 0.2,
        top_p: 1,
        max_tokens: 2000,
        useRAG: documentHashesRef.current.length > 0,
        documentHashes: documentHashesRef.current,
      } as any;

      // Wait for any in-flight batch, even if the UI already marked files complete.
      if (indexingPromiseRef.current) {
        const runningHashes = await indexingPromiseRef.current;
        if (runningHashes?.length) {
          const merged = Array.from(new Set([...documentHashesRef.current, ...runningHashes]));
          documentHashesRef.current = merged;
        }
      }
      
      // Upload files via SSE stream to get live progress
      if (data.files && data.files.length > 0) {
        const pendingFiles = data.files.filter((f: any) => f.uploadStatus !== "complete").map((f: any) => f.file);
        if (pendingFiles.length > 0) {
          if (!indexingPromiseRef.current) startPdfIndexing(pendingFiles);
          const newHashes = await indexingPromiseRef.current;
          if (!newHashes?.length && !documentHashesRef.current.length) {
            throw new Error("Document indexing did not complete. Please retry the upload.");
          }
          const finalHashes = Array.from(new Set([...documentHashesRef.current, ...(newHashes || [])]));
          documentHashesRef.current = finalHashes;
          setIndexing(p => ({ ...p, hashes: finalHashes }));
        }
        payload.useRAG = documentHashesRef.current.length > 0;
      }

      // GATE: never send a chat while any selected upload is still pending or
      // has failed. A partial hash list makes retrieval search only the
      // documents that finished first — the last-uploaded document gets lost.
      if (batchFailedFilesRef.current.length > 0) {
        throw new Error(
          `Not all uploaded documents finished indexing (failed: ${batchFailedFilesRef.current.join(", ")}). Please re-attach and retry the failed upload before asking a question.`,
        );
      }

      payload.documentHashes = [...documentHashesRef.current];
      payload.useRAG = payload.useRAG || payload.documentHashes.length > 0;

      formData.append("payload", JSON.stringify(payload));

      const response = await fetch("/api/chat", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let errorMsg = "Failed to fetch AI response";
        try {
          const result = await response.json();
          if (result.details) {
            try {
              const parsed = JSON.parse(result.details);
              const candidate = parsed.error || parsed.message || result.details;
              errorMsg = typeof candidate === "object" ? JSON.stringify(candidate) : candidate;
            } catch {
              errorMsg = result.details;
            }
          } else {
            errorMsg = result.error || errorMsg;
          }
        } catch {
          errorMsg = await response.text();
        }
        
        if (typeof errorMsg === "object") {
          errorMsg = JSON.stringify(errorMsg);
        }
        throw new Error(errorMsg);
      }

      // Add a placeholder message for the AI response
      const aiMsgId = (Date.now() + 1).toString();
      setMessages((prev) => [
        ...prev,
        { id: aiMsgId, role: "assistant", content: "" },
      ]);

      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const dataStr = line.slice(6).trim();
            if (!dataStr) continue;
            const parsed = JSON.parse(dataStr);
            if (parsed.text) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === aiMsgId ? { ...m, content: m.content + parsed.text } : m
                )
              );
              // Force scroll to bottom while streaming
              if (scrollRef.current) {
                const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
                if (scrollHeight - scrollTop - clientHeight < 150) {
                  scrollRef.current.scrollTop = scrollHeight;
                }
              }
            }
          } catch (e) {
            console.error("Error parsing chat chunk", e, line);
          }
        }
      }
    } catch (error: any) {
      console.error(error);
      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `**Error:** ${error.message}`,
        isError: true,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
      // The index remains available for RAG, but its upload/progress UI is
      // cleared once the associated chat request has finished.
      setIndexing(p => ({ ...p, status: "idle", indexed: 0, total: 0 }));
    }
  };

  const handleRetry = (failedMessageIndex: number) => {
    // Find the last user message before this error
    const msgs = [...messages];
    const prevUserMsg = msgs.slice(0, failedMessageIndex).reverse().find(m => m.role === "user");
    
    if (prevUserMsg) {
      // Remove the error message
      setMessages(msgs.slice(0, failedMessageIndex));
      // Re-submit the user message
      handleSubmit({ message: prevUserMsg.content, model: "sarvam-105b-conversations" }); // Defaulting to the model
    }
  };

  const isEmpty = messages.length === 0;

  if (!hasStarted) {
    return (
      <div className="fixed inset-0 z-50 bg-background">
        {/* Globe background */}
        <div className="absolute inset-0 z-0 pointer-events-none opacity-50">
          <GlobeStudy mode="dark" scale={1} opacity={1} />
        </div>
        {/* Radial vignette so text stays readable */}
        <div className="absolute inset-0 z-[1] pointer-events-none bg-[radial-gradient(ellipse_60%_60%_at_50%_50%,transparent_30%,hsl(var(--background)/0.85)_100%)]" />
        <ArcRevealHero 
          greetings={[
            { text: "Read." },
            { text: "Analyze." },
            { text: "Chatit." },
          ]}
          introClassName="bg-[#819c70]"
          greetingClassName="text-black"
        >
          <div className="relative z-[2] flex min-h-screen w-full flex-col items-center justify-center gap-5 px-6 text-center">
            <div className="mb-4 relative flex h-24 w-72 items-center justify-center overflow-hidden">
              <Image src="/logo.png" alt="Chatit Logo" fill priority sizes="256px" className="object-contain" />
            </div>
            <h1 className="max-w-2xl text-balance text-4xl font-semibold tracking-tight text-white sm:text-5xl md:text-6xl">
              Your Documents. Decoded.
            </h1>
            <p className="max-w-md text-balance text-base text-gray-400 md:text-lg">
              An intelligent AI assistant for document analysis, research, and deep conversational insights. Developed by Echos.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => setHasStarted(true)}
                type="button"
                className="rounded-full bg-[#819c70] px-8 py-3 text-sm font-semibold text-black shadow-lg transition-all hover:bg-[#6e8560] active:scale-[0.97]"
              >
                Start Chatting
              </button>
            </div>
          </div>
        </ArcRevealHero>
      </div>
    );
  }

  const handleNewChat = useCallback(() => {
    documentHashesRef.current = [];
    setActiveSessionId(null);
    setMessages([]);
    setIndexing({ status: "idle", hashes: [], files: {} });
  }, []);

  const handleSelectSession = useCallback((id: string) => {
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    setActiveSessionId(session.id);
    setMessages(session.messages);
    documentHashesRef.current = session.documentHashes;
    setIndexing((p) => ({ ...p, status: "idle", hashes: session.documentHashes }));
    setHasStarted(true);
  }, [sessions]);

  const handleDeleteSession = useCallback((id: string) => {
    const updated = deleteSession(id);
    setSessions(updated);
    if (id === activeSessionId) handleNewChat();
  }, [activeSessionId, handleNewChat]);

  return (
    <SidebarProvider defaultOpen={true}>
        <AppSidebar
          onNewChat={handleNewChat}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
        />
      <SidebarInset className="bg-background w-full">
        <div className="flex h-screen w-full flex-col bg-background animate-in fade-in duration-500 relative">
          {/* Sidebar Toggle Button */}
          <div className="absolute top-4 left-4 z-10">
            <SidebarTrigger className="text-gray-400 hover:text-white hover:bg-white/10" />
          </div>

          {isEmpty ? (
            /* Empty State: Center everything */
            <div className="flex h-full flex-col items-center justify-center px-4">
              <div className="mb-8 relative flex h-20 w-64 items-center justify-center overflow-hidden">
                <Image src="/logo.png" alt="Chatit Logo" fill priority sizes="256px" className="object-contain" />
              </div>
              <h1 className="mb-2 text-2xl font-semibold tracking-tight text-white">
                Welcome to Chatit
              </h1>
              <p className="text-sm text-gray-400 mb-8 text-center max-w-sm">
                Your intelligent assistant for document analysis and research. How can I help you today?
              </p>
              
              <div className="w-full max-w-5xl">
                <DeepDocChatInput
                  placeholder="Message Chatit..."
                  onSubmit={handleSubmit}
                  onFilesSelected={startPdfIndexing}
                  isIndexing={indexing.status === "extracting" || indexing.status === "indexing"}
                  indexingDone={indexing.status === "done"}
                  indexingProgress={overallIndexingProgress}
                  indexingProgressByKey={indexingProgressByKey}
                  className="shadow-[0_2px_24px_rgba(0,0,0,0.4)]"
                />
                <p className="text-center text-[11px] text-gray-500 mt-4 font-medium">
                  Chatit can make mistakes. Consider verifying important information.
                </p>
              </div>
            </div>
          ) : (
            /* Active Chat State */
            <>
              {/* Scrollable Message Area */}
              <div 
                ref={scrollRef}
                className="flex-1 overflow-y-auto scroll-smooth"
              >
                <div className="mx-auto w-full max-w-5xl px-4 py-12 pb-48 flex flex-col gap-6">
                  {messages.map((msg) => {
                    const isAi = msg.role === "assistant";
                    return (
                      <div key={msg.id} className={cn("flex w-full gap-3", isAi ? "justify-start" : "justify-end")}>
                        {/* AI Avatar on left */}
                        {isAi && (
                          <div className="flex-shrink-0 mt-1">
                            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-[#1e1e1e] shadow-sm border border-white/10 overflow-hidden">
                              <Image src="/logo-square.png" alt="Chatit Logo" fill sizes="40px" className="object-contain" />
                            </div>
                          </div>
                        )}

                        {/* Content Bubble */}
                        <div 
                          className={cn(
                            "relative flex flex-col max-w-[85%] rounded-3xl px-5 py-4 shadow-sm",
                            isAi 
                              ? "bg-[#1e1e1e] border border-white/10 rounded-tl-sm text-[#819c70]" 
                              : "bg-[#819c70] text-black rounded-tr-sm"
                          )}
                        >
                          <div className={cn(
                            "prose prose-sm max-w-none leading-relaxed",
                            isAi ? "prose-invert text-[#819c70]" : "text-black prose-p:text-black prose-strong:text-black"
                          )}>
                            {msg.content.trim().split('\n').map((line, i) => (
                              <p key={i} className="mb-2 last:mb-0">
                                {line.includes('**') 
                                  ? <span dangerouslySetInnerHTML={{ __html: line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }} />
                                  : line
                                }
                              </p>
                            ))}
                          </div>

                          {/* Document Citations / Attachments */}
                          {msg.documents && msg.documents.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {msg.documents.map((doc, i) => (
                                <div 
                                  key={i} 
                                  className={cn(
                                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium",
                                    isAi 
                                      ? "bg-white/5 border border-white/10 text-gray-400" 
                                      : "bg-black/10 text-black"
                                  )}
                                >
                                  <FileText className={cn("h-3.5 w-3.5", isAi ? "text-[#819c70]" : "text-black/80")} />
                                  {doc}
                                </div>
                              ))}
                            </div>
                          )}
                          
                          {/* Retry Button */}
                          {msg.isError && (
                            <button
                              onClick={() => handleRetry(messages.indexOf(msg))}
                              className="mt-3 flex w-fit items-center gap-1.5 rounded-md bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors"
                            >
                              <RotateCw className="h-3.5 w-3.5" />
                              Retry
                            </button>
                          )}
                        </div>

                        {/* User Avatar on right */}
                        {!isAi && (
                          <div className="flex-shrink-0 mt-1">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#819c70] text-black shadow-sm">
                              <User className="h-6 w-6" />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Typing indicator — shown while waiting for the first
                      streamed token. Without this, a slow RAG query (large
                      PDFs, cross-document synthesis) looks like the app
                      hung with zero feedback. */}
                  {isLoading && (!messages.length || messages[messages.length - 1].role === "user" || messages[messages.length - 1].content === "") && (
                    <div className="flex w-full justify-start gap-3">
                      <div className="flex-shrink-0 mt-1">
                        <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-[#1e1e1e] shadow-sm border border-white/10 overflow-hidden">
                          <Image src="/logo-square.png" alt="Chatit Logo" fill sizes="40px" className="object-contain" />
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 rounded-3xl rounded-tl-sm border border-white/10 bg-[#1e1e1e] px-5 py-4 shadow-sm">
                        <span className="h-2 w-2 animate-bounce rounded-full bg-[#819c70] [animation-delay:-0.3s]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-[#819c70] [animation-delay:-0.15s]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-[#819c70]" />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Input Area - Fixed at bottom */}
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background via-background to-transparent pt-10 pb-6 px-4">
                <div className="mx-auto w-full max-w-5xl">

                  <DeepDocChatInput
                    placeholder="Message Chatit..."
                    onSubmit={handleSubmit}
                    onFilesSelected={startPdfIndexing}
                    isIndexing={indexing.status === "extracting" || indexing.status === "indexing"}
                    indexingDone={indexing.status === "done"}
                    indexingProgress={overallIndexingProgress}
                    indexingProgressByKey={indexingProgressByKey}
                    className="shadow-[0_2px_24px_rgba(0,0,0,0.4)]"
                  />
                  <p className="text-center text-[11px] text-gray-500 mt-3 font-medium">
                    Chatit can make mistakes. Consider verifying important information.
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
