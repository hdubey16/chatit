import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { createHash } from "crypto";
import { EventEmitter } from "events";
import {
  chunkId,
  contentFingerprint,
  countIndexedChunks,
  countIndexedPages,
  detectSectionTitle,
  EMBED_BATCH_CHARACTERS,
  EMBED_BATCH_ITEMS,
  EMBEDDING_CONCURRENCY,
  embedPassages,
  ensureRagIndexes,
  getIndexedChunkIds,
  importFilesystemIndexIfNeeded,
  isDocumentReady,
  persistChunksToMongo,
  toMongoChunk,
  upsertManifest,
} from "@/lib/rag";

export const runtime = "nodejs";

// Allow long-running indexing jobs (300 s; raise on paid Vercel plans if needed)
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Global job registry — survives across requests on the same Node.js process */
const jobManager: Map<string, EventEmitter> = (globalThis as any).__jobManager
  ?? ((globalThis as any).__jobManager = new Map<string, EventEmitter>());

/** Split chunks into embedding batches respecting item and character limits */
function batches<T extends { text: string }>(chunks: T[]): T[][] {
  const output: T[][] = [];
  let batch: T[] = [];
  let chars = 0;
  for (const chunk of chunks) {
    if (
      batch.length &&
      (batch.length >= EMBED_BATCH_ITEMS ||
        chars + chunk.text.length > EMBED_BATCH_CHARACTERS)
    ) {
      output.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(chunk);
    chars += chunk.text.length;
  }
  if (batch.length) output.push(batch);
  return output;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

async function extractNonPdf(
  buffer: Buffer,
  fileName: string,
  hash: string,
): Promise<Document[]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer });
    return [
      new Document({
        pageContent: value,
        metadata: { documentId: hash, documentHash: hash, fileName, loc: { pageNumber: 1 } },
      }),
    ];
  }
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    const Tesseract = (await import("tesseract.js")).default;
    const { data: { text } } = await Tesseract.recognize(buffer, "eng");
    return [
      new Document({
        pageContent: text,
        metadata: { documentId: hash, documentHash: hash, fileName, loc: { pageNumber: 1 } },
      }),
    ];
  }
  return [
    new Document({
      pageContent: buffer.toString("utf-8"),
      metadata: { documentId: hash, documentHash: hash, fileName, loc: { pageNumber: 1 } },
    }),
  ];
}

async function extractPdfPage(
  doc: any,
  pageIndex: number,
  hash: string,
  fileName: string,
  lastSection?: string,
): Promise<{ doc: Document | null; section?: string }> {
  let text: string = await doc.toMarkdown(pageIndex);
  // pdf-oxide returns a non-empty placeholder sentence for scanned/image-only
  // pages instead of "" (e.g. "[OCR REQUIRED — page N] ... no extractable
  // text layer"). That placeholder is well over 10 chars, so it slipped past
  // the length check below and got embedded as if it were real page content.
  const needsOcr = !text || text.trim().length < 10 || /OCR REQUIRED/i.test(text);
  if (needsOcr) {
    try {
      // RenderOptions has no "scale" field (pdf-oxide/lib/index.d.ts) — it was
      // silently ignored, so OCR always rendered at the 150 dpi default. Use
      // "dpi" directly for the intended 1.5x resolution boost.
      const img = doc.renderPageWithOptions(pageIndex, { format: "png", dpi: 225 });
      const Tesseract = (await import("tesseract.js")).default;
      const { data: { text: ocrText } } = await Tesseract.recognize(Buffer.from(img), "eng");
      text = ocrText;
    } catch (ocrErr) {
      console.warn(`[upload:${hash.slice(0, 8)}] OCR failed on page ${pageIndex + 1}:`, ocrErr instanceof Error ? ocrErr.message : ocrErr);
    }
  }
  if (!text?.trim()) return { doc: null, section: lastSection };

  const section = detectSectionTitle(text) ?? lastSection;
  return {
    section,
    doc: new Document({
      pageContent: text,
      metadata: {
        documentId: hash,
        documentHash: hash,
        fileName,
        filename: fileName,
        section,
        loc: { pageNumber: pageIndex + 1 },
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Embed + store one batch of pending chunks
// ---------------------------------------------------------------------------

async function embedAndStore(
  pending: ReturnType<typeof toMongoChunk>[],
  already: Set<string>,
  embeddingCache: Map<string, number[]>,
  apiKey: string,
  emitter: EventEmitter,
  totals: { indexed: number; total: number; hash: string },
): Promise<void> {
  if (!pending.length) return;

  const groups = batches(pending);
  let next = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= groups.length) return;
      const group = groups[i];

      // Resolve embeddings — reuse cached vectors where possible
      const needEmbed: number[] = [];
      const needTexts: string[] = [];
      for (let j = 0; j < group.length; j++) {
        const fp = group[j].contentHash ?? contentFingerprint(group[j].text);
        const cached = embeddingCache.get(fp);
        if (cached) {
          group[j].embedding = cached;
        } else {
          needEmbed.push(j);
          needTexts.push(group[j].text);
        }
      }

      if (needTexts.length) {
        console.log(`[upload:${totals.hash.slice(0, 8)}] embedding batch ${i + 1}/${groups.length} (${needTexts.length} texts)`);
        const embeddings = await embedPassages(needTexts, apiKey, "passage");
        embeddings.forEach((vec, k) => {
          const j = needEmbed[k];
          group[j].embedding = vec;
          embeddingCache.set(
            group[j].contentHash ?? contentFingerprint(group[j].text),
            vec,
          );
        });
      }

      console.log(`[upload:${totals.hash.slice(0, 8)}] writing batch ${i + 1}/${groups.length} to MongoDB (${group.length} chunks)`);
      await persistChunksToMongo(group);

      for (const chunk of group) already.add(String(chunk._id));
      totals.indexed += group.length;
      emitter.emit("data", {
        type: "progress",
        indexed: totals.indexed,
        total: totals.total,
        message: `Indexed ${totals.indexed}/${totals.total} chunks`,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, EMBEDDING_CONCURRENCY) }, worker),
  );
}

// ---------------------------------------------------------------------------
// Split one page Document into chunks, preserving page metadata
// ---------------------------------------------------------------------------

/**
 * Chunks accumulate here across pages instead of being embedded/written one
 * page at a time — a 961-page scan produced 961 embedding calls + 961 Mongo
 * writes of ~2-4 chunks each. Flushing every FLUSH_CHUNK_THRESHOLD chunks
 * (a few EMBED_BATCH_ITEMS batches' worth) collapses that into far fewer,
 * full-sized batches while keeping memory bounded and progress events regular.
 */
const FLUSH_CHUNK_THRESHOLD = EMBED_BATCH_ITEMS * 4;

async function maybeFlush(
  pendingAccumulator: ReturnType<typeof toMongoChunk>[],
  already: Set<string>,
  embeddingCache: Map<string, number[]>,
  apiKey: string,
  emitter: EventEmitter,
  totals: { indexed: number; total: number; hash: string },
  force = false,
): Promise<void> {
  if (!pendingAccumulator.length) return;
  if (!force && pendingAccumulator.length < FLUSH_CHUNK_THRESHOLD) return;
  const batch = pendingAccumulator.splice(0, pendingAccumulator.length);
  await embedAndStore(batch, already, embeddingCache, apiKey, emitter, totals);
}

async function indexDocuments(
  pages: Document[],
  hash: string,
  fileName: string,
  startIndex: number,
  already: Set<string>,
  pendingAccumulator: ReturnType<typeof toMongoChunk>[],
  totals: { indexed: number; total: number; hash: string },
): Promise<number> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const split = await splitter.splitDocuments(pages);

  let chunkIndex = startIndex;

  for (const chunk of split) {
    const meta = chunk.metadata as any;

    // ── Resolve pageNumber through all possible metadata paths ───────────
    let pageNumber: number | null =
      typeof meta?.loc?.pageNumber === "number" ? meta.loc.pageNumber :
      typeof meta?.pageNumber      === "number" ? meta.pageNumber :
      typeof meta?.page            === "number" ? meta.page :
      null;

    // Recovery: match against parent pages by leading text
    if (pageNumber === null) {
      const snippet = chunk.pageContent.slice(0, 80);
      const parent = pages.find(
        (p) =>
          p.pageContent.includes(snippet) &&
          typeof (p.metadata as any)?.loc?.pageNumber === "number",
      );
      if (parent) pageNumber = (parent.metadata as any).loc.pageNumber as number;
    }

    // Stamp back so toMongoChunk always sees consistent values
    if (pageNumber !== null) {
      if (!meta.loc) meta.loc = {};
      meta.loc.pageNumber = pageNumber;
      meta.pageNumber = pageNumber;
    }
    // ────────────────────────────────────────────────────────────────────

    const section = typeof meta.section === "string" ? meta.section : undefined;
    const id = chunkId(hash, chunkIndex);
    const record = toMongoChunk({
      documentHash: hash,
      fileName,
      pageNumber,
      chunkIndex,
      section,
      text: chunk.pageContent,
      embedding: [],
      contentHash: contentFingerprint(chunk.pageContent),
    });
    chunkIndex += 1;
    totals.total = Math.max(totals.total, chunkIndex);

    if (already.has(id) || already.has(String(record._id))) continue;
    pendingAccumulator.push(record);
  }

  return chunkIndex;
}

// ---------------------------------------------------------------------------
// Background indexing job
// ---------------------------------------------------------------------------

async function processDocumentJob(
  hash: string,
  buffer: Buffer,
  fileName: string,
  emitter: EventEmitter,
): Promise<void> {
  const tag = `[upload:${hash.slice(0, 8)}]`;
  try {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");

    // ── Ensure indexes ONCE at job start — not on every batch write ───────
    console.log(`${tag} ensureRagIndexes`);
    await ensureRagIndexes();

    // ── Fast-path: document already fully indexed ─────────────────────────
    if (await isDocumentReady(hash)) {
      const indexed = await countIndexedChunks(hash);
      const indexedPages = await countIndexedPages(hash);
      console.log(`${tag} already ready — ${indexed} chunks, ${indexedPages} pages`);
      emitter.emit("data", { type: "status", message: "Document already indexed." });
      emitter.emit("data", { type: "total", total: indexed, pages: 0 });
      emitter.emit("data", { type: "done", indexed, total: indexed, hash });
      await upsertManifest({
        documentHash: hash,
        fileName,
        status: "ready",
        totalChunks: indexed,
        indexedChunks: indexed,
        indexedPages,
      });
      return;
    }

    // ── Filesystem migration (legacy .rag-index JSON → MongoDB) ──────────
    const migrated = await importFilesystemIndexIfNeeded(hash);
    if (migrated && await isDocumentReady(hash)) {
      const indexed = await countIndexedChunks(hash);
      console.log(`${tag} migrated from local index — ${indexed} chunks`);
      emitter.emit("data", { type: "status", message: "Imported local index into MongoDB." });
      emitter.emit("data", { type: "done", indexed, total: indexed, hash });
      return;
    }

    // ── Resumable indexing ────────────────────────────────────────────────
    const already = await getIndexedChunkIds(hash);
    const embeddingCache = new Map<string, number[]>();
    const pendingAll: ReturnType<typeof toMongoChunk>[] = [];
    const totals = { indexed: already.size, total: already.size, hash };
    if (already.size) {
      console.log(`${tag} resuming — ${already.size} chunks already indexed`);
      emitter.emit("data", {
        type: "progress",
        indexed: already.size,
        total: already.size,
        message: `Resuming — ${already.size} chunks already indexed`,
      });
    }

    await upsertManifest({
      documentHash: hash,
      fileName,
      status: "indexing",
      totalChunks: already.size,
      indexedChunks: already.size,
    });

    emitter.emit("data", { type: "status", message: "Extracting document text…" });

    let nextChunkIndex = 0;
    let totalPages: number | undefined;
    const lowerName = fileName.toLowerCase();

    if (lowerName.endsWith(".pdf")) {
      // ── PDF: extract page-by-page, preserving pageNumber metadata ────────
      const { PdfDocument } = await import("pdf-oxide");
      const doc = await PdfDocument.openFromBuffer(buffer);

      // Release the raw buffer after pdf-oxide has opened it — we no longer
      // need the original bytes; all subsequent work uses extracted text.
      (buffer as any) = null;

      try {
        const pageCount = doc.pageCount();
        totalPages = pageCount;
        console.log(`${tag} PDF pages=${pageCount}`);
        emitter.emit("data", { type: "total", total: Math.max(already.size, 1), pages: pageCount });
        await upsertManifest({
          documentHash: hash,
          fileName,
          status: "indexing",
          totalPages: pageCount,
          totalChunks: already.size,
          indexedChunks: already.size,
        });

        let lastSection: string | undefined;
        let emptyPages = 0;

        for (let i = 0; i < pageCount; i++) {
          const extracted = await extractPdfPage(doc, i, hash, fileName, lastSection);
          if (extracted.section) lastSection = extracted.section;

          if (!extracted.doc) {
            emptyPages += 1;
          } else {
            nextChunkIndex = await indexDocuments(
              [extracted.doc],
              hash,
              fileName,
              nextChunkIndex,
              already,
              pendingAll,
              totals,
            );
            await maybeFlush(pendingAll, already, embeddingCache, apiKey, emitter, totals);
          }

          // Emit extraction progress every other page and on the last page
          if (i % 2 === 0 || i === pageCount - 1) {
            emitter.emit("data", { type: "extraction_progress", current: i + 1, total: pageCount });
          }

          // Yield to the event loop every 10 pages so the SSE stream stays alive
          if (i % 10 === 0) await sleep(0);
        }

        // Flush any remainder that didn't reach the threshold
        await maybeFlush(pendingAll, already, embeddingCache, apiKey, emitter, totals, true);

        console.log(`${tag} extraction done — pages with text: ${pageCount - emptyPages}, chunks: ${nextChunkIndex}`);
      } finally {
        if (typeof doc.close === "function") doc.close();
      }
    } else {
      // ── Non-PDF documents ─────────────────────────────────────────────
      const docs = await extractNonPdf(buffer, fileName, hash);
      if (!docs.length) throw new Error("No extractable text found in document");
      nextChunkIndex = await indexDocuments(
        docs,
        hash,
        fileName,
        0,
        already,
        pendingAll,
        totals,
      );
      await maybeFlush(pendingAll, already, embeddingCache, apiKey, emitter, totals, true);
    }

    if (!nextChunkIndex && !already.size) {
      throw new Error("No extractable text found in document");
    }

    const indexed = await countIndexedChunks(hash);
    const indexedPages = await countIndexedPages(hash);
    const total = Math.max(nextChunkIndex, indexed);
    await upsertManifest({
      documentHash: hash,
      fileName,
      status: "ready",
      totalChunks: total,
      indexedChunks: indexed,
      indexedPages,
      totalPages,
    });
    console.log(`${tag} indexing complete — ${indexed} chunks, ${indexedPages} pages`);
    emitter.emit("data", { type: "done", indexed, total, hash });

  } catch (error) {
    console.error(`${tag} job failed:`, error instanceof Error ? error.message : error);
    await upsertManifest({
      documentHash: hash,
      fileName,
      status: "error",
      totalChunks: 0,
      indexedChunks: 0,
    }).catch(() => undefined);
    emitter.emit("data", {
      type: "error",
      error: error instanceof Error ? error.message : "Unknown indexing error",
    });
  } finally {
    jobManager.delete(hash);
    emitter.emit("end");
  }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // controller already closed (client disconnected)
        }
      };

      // ── SSE keepalive ─────────────────────────────────────────────────
      // Emit a heartbeat comment every 15 s so browsers and proxies don't
      // close the idle connection during long extraction/embedding phases.
      let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        }
      }, 15_000);

      const stopHeartbeat = () => {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      };

      try {
        const files = (await request.formData()).getAll("files") as File[];
        if (!files.length) throw new Error("No files uploaded");

        const file = files[0];
        const buffer = Buffer.from(await file.arrayBuffer());
        const hash = createHash("sha256").update(buffer).digest("hex");

        let emitter = jobManager.get(hash);
        if (!emitter) {
          emitter = new EventEmitter();
          jobManager.set(hash, emitter);
          // Fire-and-forget — the SSE stream carries all progress events
          processDocumentJob(hash, buffer, file.name, emitter).catch((e) => {
            console.error("[upload] fatal job error:", e instanceof Error ? e.message : e);
          });
        }

        const onData = (data: unknown) => send(data as object);
        const onEnd = () => { stopHeartbeat(); controller.close(); };

        emitter.on("data", onData);
        emitter.once("end", onEnd);

        request.signal.addEventListener("abort", () => {
          emitter?.removeListener("data", onData);
          emitter?.removeListener("end", onEnd);
          stopHeartbeat();
        });

      } catch (error) {
        console.error("[upload] handler error:", error instanceof Error ? error.message : error);
        send({ type: "error", error: error instanceof Error ? error.message : "Unknown error" });
        stopHeartbeat();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
