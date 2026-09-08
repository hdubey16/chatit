"use client";

import * as React from "react";
import {
  Plus,
  ChevronDown,
  ArrowUp,
  X,
  FileText,
  Loader2,
  Check,
  Archive,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ShineBorder } from "@/components/ui/shine-border";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

/* ------------------------------------------------------------------ */
/*  utility                                                           */
/* ------------------------------------------------------------------ */
const formatFileSize = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

/* ------------------------------------------------------------------ */
/*  types                                                             */
/* ------------------------------------------------------------------ */
import {
  PasteAttachment,
  AttachmentCard,
  AttachmentEditor,
} from "../ruixen/smart-paste-input";

export interface AttachedFile {
  id: string;
  file: File;
  type: string;
  preview: string | null;
  uploadStatus: "pending" | "uploading" | "complete";
}

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
}

export interface DeepDocChatInputProps {
  onSubmit?: (data: {
    message: string;
    files: AttachedFile[];
    pastedContent: PasteAttachment[];
    model: string;
    thinking: boolean;
  }) => void;
  onFilesSelected?: (files: File[]) => void;
  placeholder?: string;
  models?: ModelOption[];
  defaultModel?: string;
  className?: string;
  isIndexing?: boolean;
  indexingProgress?: number;
  /** Per-file progress, keyed by fileKey(file) — lets concurrently uploading
   *  files show their own percentage instead of one shared number. */
  indexingProgressByKey?: Record<string, number>;
  /** True only when the whole upload batch finished with every file indexed. */
  indexingDone?: boolean;
}

/** Stable key for a File across the upload lifecycle. Must match the key
 *  page.tsx uses to track per-file indexing progress. */
export function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/* ------------------------------------------------------------------ */
/*  file preview card                                                 */
/* ------------------------------------------------------------------ */
const FilePreviewCard: React.FC<{
  file: AttachedFile;
  progress?: number;
  onRemove: (id: string) => void;
}> = ({ file, progress, onRemove }) => {
  const isImage = file.type.startsWith("image/") && file.preview;

  return (
    <div className="group/file relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-2xl border border-foreground/[0.06] bg-foreground/[0.015] transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:border-foreground/[0.10]">
      {isImage ? (
        <div className="relative h-full w-full">
          <img
            src={file.preview!}
            alt={file.file.name}
            className="h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-black/10 transition-colors duration-300 group-hover/file:bg-black/0" />
        </div>
      ) : (
        <div className="flex h-full w-full flex-col justify-between p-3">
          <div className="flex items-center gap-2">
            <div className="rounded bg-foreground/[0.04] p-1.5">
              <FileText className="h-3.5 w-3.5 text-foreground/30" />
            </div>
            <span className="truncate text-[10px] font-medium uppercase tracking-wider text-foreground/25">
              {file.file.name.split(".").pop()}
            </span>
          </div>
          <div className="space-y-0.5">
            <p
              className="truncate text-xs font-medium text-foreground/60"
              title={file.file.name}
            >
              {file.file.name}
            </p>
            <p className="text-[10px] text-foreground/25">
              {formatFileSize(file.file.size)}
            </p>
          </div>
        </div>
      )}

      <Button
        variant="ghost"
        size="icon"
        onClick={() => onRemove(file.id)}
        className="absolute right-1 top-1 h-auto w-auto rounded-full bg-black/40 p-1 text-white opacity-0 hover:bg-black/60 hover:text-white group-hover/file:opacity-100"
      >
        <X className="size-2.5" />
      </Button>

      {file.uploadStatus === "uploading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50">
          <Loader2 className="h-4 w-4 animate-spin text-white mb-1" />
          {progress !== undefined && (
            <span className="text-[10px] font-bold text-white tracking-widest">{progress}%</span>
          )}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  model selector — Popover with thinking toggle & more models       */
/* ------------------------------------------------------------------ */
const ModelSelector: React.FC<{
  models: ModelOption[];
  selectedModel: string;
  onSelect: (id: string) => void;
  thinking: boolean;
  onThinkingChange: (v: boolean) => void;
}> = ({ models, selectedModel, onSelect, thinking, onThinkingChange }) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const current = models.find((m) => m.id === selectedModel) || models[0];

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger render={<Button variant="ghost" className={cn(
                      "h-8 gap-1 rounded-xl px-2.5 text-[13px] font-medium tracking-[-0.01em] transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                      isOpen
                        ? "bg-foreground/[0.06] text-foreground/70"
                        : "text-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground/60",
                    )} />}><span className="select-none whitespace-nowrap">{current.name}</span><ChevronDown
                      className={cn(
                        "size-3 opacity-50 transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
                        isOpen && "rotate-180",
                      )}
                    /></PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[260px] rounded-xl p-0 shadow-[0_4px_24px_-4px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)]"
      >
        {/* model list */}
        <div className="p-1.5">
          {models.map((model) => (
            <button
              key={model.id}
              onClick={() => {
                onSelect(model.id);
                setIsOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left transition-all duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-foreground/[0.035]"
            >
              <div className="flex flex-col gap-px">
                <span className="text-[13.5px] font-medium tracking-[-0.01em] text-foreground/75">
                  {model.name}
                </span>
                {model.description && (
                  <span className="text-[11.5px] text-foreground/30">
                    {model.description}
                  </span>
                )}
              </div>
              {selectedModel === model.id && (
                <Check className="h-4 w-4 flex-shrink-0 text-emerald-500" />
              )}
            </button>
          ))}
        </div>

        <Separator className="mx-3 bg-foreground/[0.06]" />

        {/* extended thinking toggle */}
        <div className="p-1.5">
          <button
            onClick={() => onThinkingChange(!thinking)}
            className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-all duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-foreground/[0.035]"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium tracking-[-0.01em] text-foreground/75">
                Extended thinking
              </p>
              <p className="text-[11.5px] leading-snug text-foreground/30">
                Think longer for complex tasks
              </p>
            </div>
            <Switch
              checked={thinking}
              onCheckedChange={onThinkingChange}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              className="h-[22px] w-10 data-[state=checked]:bg-[#819c70] data-[state=unchecked]:bg-foreground/[0.12]"
            />
          </button>
        </div>


      </PopoverContent>
    </Popover>
  );
};

/* ------------------------------------------------------------------ */
/*  defaults                                                          */
/* ------------------------------------------------------------------ */
const defaultModels: ModelOption[] = [
  {
    id: "max",
    name: "Max",
    description: "Most capable for ambitious work",
  },
  {
    id: "pro",
    name: "Pro",
    description: "Best for everyday tasks",
  },
];

/* ------------------------------------------------------------------ */
/*  main component                                                    */
/* ------------------------------------------------------------------ */
export default function DeepDocChatInput({
  onSubmit,
  onFilesSelected,
  placeholder = "How can I help you today?",
  models = defaultModels,
  defaultModel = "max",
  className,
  isIndexing,
  indexingProgress,
  indexingProgressByKey,
  indexingDone,
}: DeepDocChatInputProps) {
  const [message, setMessage] = React.useState("");
  const [files, setFiles] = React.useState<AttachedFile[]>([]);
  const [pastedContent, setPastedContent] = React.useState<PasteAttachment[]>([]);
  const [openPasteId, setOpenPasteId] = React.useState<string | null>(null);
  const openPaste = pastedContent.find(p => p.id === openPasteId) || null;
  const [isDragging, setIsDragging] = React.useState(false);
  const [selectedModel, setSelectedModel] = React.useState(defaultModel);
  const [thinking, setThinking] = React.useState(defaultModel === "max");

  const handleModelSelect = (id: string) => {
    setSelectedModel(id);
    setThinking(id === "max");
  };

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  /* auto-resize textarea */
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 384) + "px";
  }, [message]);

  /* update file upload status when indexing completes successfully.
     Gated on `indexingDone` (whole batch finished with every file indexed)
     so failed or interrupted uploads keep showing their pending state —
     they are NOT searchable and must not look complete. */
  React.useEffect(() => {
    if (indexingDone) {
      setFiles((prev) =>
        prev.map((f) =>
          f.uploadStatus === "uploading" ? { ...f, uploadStatus: "complete" } : f
        )
      );
    }
  }, [indexingDone]);

  /* file handling */
  const handleFiles = React.useCallback((list: FileList | File[]) => {
    const incoming = Array.from(list).map((file) => {
      const isImage =
        file.type.startsWith("image/") ||
        /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.name);
      return {
        id: Math.random().toString(36).slice(2, 11),
        file,
        type: isImage
          ? "image/unknown"
          : file.type || "application/octet-stream",
        preview: isImage ? URL.createObjectURL(file) : null,
        uploadStatus: "uploading" as "uploading" | "pending" | "complete",
      };
    });

    setFiles((prev) => [...prev, ...incoming]);

    // Every attached file — PDF or not — goes through the real /api/upload
    // pipeline. The backend already extracts non-PDF types (extractNonPdf);
    // faking a client-side "complete" status here previously meant non-PDF
    // files were never actually indexed and RAG silently had nothing to
    // retrieve from them.
    onFilesSelected?.(incoming.map((item) => item.file));
  }, [onFilesSelected]);

  /* paste handling */
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === "file") {
        const file = items[i].getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      handleFiles(pastedFiles);
      return;
    }
    const text = e.clipboardData.getData("text");
    const isLong = text.length > 300 || text.split('\n').length >= 8;
    if (isLong) {
      e.preventDefault();
      setPastedContent((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).slice(2, 11),
          content: text,
        },
      ]);
    }
  };

  /* drag & drop */
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  };

  /* submit */
  const handleSend = () => {
    if (isIndexing) return;
    if (!message.trim() && files.length === 0 && pastedContent.length === 0)
      return;
    onSubmit?.({
      message,
      files,
      pastedContent,
      model: selectedModel,
      thinking,
    });
    setMessage("");
    setFiles([]);
    setPastedContent([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasContent =
    message.trim() || files.length > 0 || pastedContent.length > 0;

  return (
    <div
      className={cn("relative mx-auto w-full", className)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* input container — elegant, large rounded corners, gentle shadow */}
      <div
        className={cn(
          "relative z-10 flex cursor-text flex-col rounded-3xl border border-white/10 bg-[#1e1e1e] shadow-[0_8px_30px_rgba(0,0,0,0.4)] transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:shadow-[0_8px_30px_rgba(0,0,0,0.6)]",
        )}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (!target.closest('button') && !target.closest('[role="button"]') && !target.closest('a')) {
            textareaRef.current?.focus();
          }
        }}
      >
        <ShineBorder shineColor={["#819c70", "#ffffff", "#819c70"]} borderWidth={1} />
        <div className="px-4 pb-3 pt-4 relative z-10">
          {/* attachments row */}
          {(files.length > 0 || pastedContent.length > 0) && (
            <div className="mb-3 flex gap-2.5 overflow-x-auto pb-1">
              {pastedContent.map((c) => (
                <div key={c.id} className="shrink-0">
                  <AttachmentCard
                    attachment={c}
                    onOpen={() => setOpenPasteId(c.id)}
                    onRemove={() =>
                      setPastedContent((prev) => prev.filter((p) => p.id !== c.id))
                    }
                  />
                </div>
              ))}
              {files.map((f) => (
                <FilePreviewCard
                  key={f.id}
                  file={f}
                  progress={
                    f.uploadStatus === "uploading"
                      ? indexingProgressByKey?.[fileKey(f.file)] ?? indexingProgress
                      : undefined
                  }
                  onRemove={(id) =>
                    setFiles((prev) => prev.filter((p) => p.id !== id))
                  }
                />
              ))}
            </div>
          )}

          {/* textarea */}
          <div className="mb-4 max-h-96 overflow-y-auto">
            <Textarea
              ref={textareaRef}
              id="chat-message-input"
              name="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              aria-label="Message input"
              className="min-h-0 w-full resize-none overflow-hidden rounded-none border-0 bg-transparent dark:bg-transparent px-0 py-0 text-[15px] leading-[1.65] tracking-[-0.01em] text-foreground/90 shadow-none outline-none ring-0 ring-offset-0 placeholder:text-foreground/[0.28] focus-visible:ring-0 focus-visible:ring-offset-0"
              rows={1}
              style={{ minHeight: "1.5em" }}
            />
          </div>

          {/* action bar */}
          <div className="flex w-full items-center">
            {/* left: attach */}
            <div className="flex flex-1 items-center">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                type="button"
                className="h-8 w-8 rounded-xl text-foreground/25 transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-foreground/[0.04] hover:text-foreground/45 active:scale-95"
              >
                <Plus className="size-5" strokeWidth={1.8} />
              </Button>
            </div>

            {/* right: model selector + send */}
            <div className="flex items-center gap-2">
              <ModelSelector
                models={models}
                selectedModel={selectedModel}
                onSelect={handleModelSelect}
                thinking={thinking}
                onThinkingChange={setThinking}
              />

              {/* send — elegant circular button */}
              <button
                onClick={handleSend}
                disabled={!hasContent || isIndexing}
                type="button"
                style={{ backgroundColor: (!hasContent || isIndexing) ? "#333" : "#819c70" }}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white shadow-sm transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:opacity-90 active:scale-[0.92] disabled:cursor-default disabled:opacity-50"
              >
                {isIndexing ? (
                  indexingProgress !== undefined ? (
                    <span className="text-[10px] font-bold text-white tracking-tighter">{indexingProgress}%</span>
                  ) : (
                    <Loader2 className="size-4 animate-spin text-white" strokeWidth={2.5} />
                  )
                ) : (
                  <ArrowUp className="size-4" strokeWidth={2.5} />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* drag overlay */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center rounded-[24px] border-2 border-dashed border-foreground/15 bg-background/90 backdrop-blur-sm">
          <Archive className="mb-2 h-8 w-8 animate-bounce text-foreground/40" />
          <p className="text-sm font-medium text-foreground/40">
            Drop files to upload
          </p>
        </div>
      )}

      {/* hidden file input */}
      <input
        ref={fileInputRef}
        id="chat-file-input"
        name="attachments"
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <AttachmentEditor
        attachment={openPaste}
        editable={true}
        accentClassName="bg-[#819c70] text-black hover:bg-[#6e8560]"
        onClose={() => setOpenPasteId(null)}
        onSave={(id, content) => {
          setPastedContent((prev) => prev.map((p) => p.id === id ? { ...p, content } : p));
          setOpenPasteId(null);
        }}
        onRemove={(id) => {
          setPastedContent((prev) => prev.filter((p) => p.id !== id));
          setOpenPasteId(null);
        }}
      />
    </div>
  );
}
