import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { getDb, withMongoRetry } from "@/lib/mongodb";
import {
  classifyQuery,
  diversifyByDocument,
  diversifyByPage,
  expandedTerms,
  FINAL_CHUNK_LIMIT_BROAD,
  FINAL_CHUNK_LIMIT_SPECIFIC,
  FINAL_CHUNK_LIMIT_GENERIC,
  filterCandidates,
  hybridScore,
  lexicalScore,
  phraseScore,
  metadataScore,
  packContext,
  INTENT_CHUNK_LIMIT,
  INTENT_CONTEXT_CHARS,
  type FactualField,
  type QueryIntent,
  type ScoredChunk,
  type ConversationContext,
} from "@/lib/rag-query";

export { classifyQuery, packContext, parsePageQuery, queryTerms, rewriteQuery } from "@/lib/rag-query";
export type { QueryType, QueryIntent, FactualField, ScoredChunk, ConversationContext } from "@/lib/rag-query";

export const INDEX_DIR = ".rag-index";
export const EMBED_MODEL = "nvidia/nemotron-3-embed-1b";
export const EMBED_URL = "https://integrate.api.nvidia.com/v1/embeddings";
export const EMBEDDING_DIMENSIONS = 2048;
export const RAG_COLLECTION = "vectors";
export const MANIFEST_COLLECTION = "manifests";
export const VECTOR_SEARCH_INDEX = "vector_index";

export const EMBED_BATCH_ITEMS = 64;
export const EMBED_BATCH_CHARACTERS = 240_000;
export const EMBEDDING_CONCURRENCY = 1;
export const MAX_EMBED_RETRIES = 24;

const CANDIDATE_LIMIT = 50;
const VECTOR_NUM_CANDIDATES = 100;
const BROAD_VECTOR_CANDIDATES = 200;
const BROAD_VECTOR_LIMIT = 60;
const NEIGHBOR_RADIUS = 2;
const QUERY_EMBED_TTL_MS = 10 * 60 * 1000;

export const VECTOR_SEARCH_INDEX_DEFINITION = {
  name: VECTOR_SEARCH_INDEX,
  type: "vectorSearch" as const,
  definition: {
    fields: [
      {
        type: "vector",
        path: "embedding",
        numDimensions: EMBEDDING_DIMENSIONS,
        similarity: "cosine",
      },
      { type: "filter", path: "documentHash" },
      { type: "filter", path: "hash" },
      { type: "filter", path: "pageNumber" },
    ],
  },
};

export type ChunkMeta = {
  documentId?: string;
  documentHash?: string;
  fileName?: string;
  filename?: string;
  chunkIndex?: number;
  section?: string;
  loc?: { pageNumber?: number; lines?: { from?: number; to?: number } };
  [key: string]: unknown;
};

export type MongoChunk = {
  _id?: string;
  documentId: string;
  documentHash: string;
  hash: string;
  fileName: string;
  pageNumber: number | null;
  chunkIndex: number;
  section?: string | null;
  text: string;
  content?: string;
  embedding: number[];
  contentHash?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  metadata?: ChunkMeta;
};

export type DocumentManifest = {
  _id: string;
  documentHash: string;
  hash: string;
  fileName: string;
  status: "indexing" | "ready" | "error";
  totalChunks: number;
  totalPages?: number;
  indexedPages?: number;   // distinct page numbers that have at least one indexed chunk
  indexedChunks: number;
  embeddingModel: string;
  embeddingDimensions: number;
  updatedAt: Date;
};

const queryEmbedCache = (globalThis as typeof globalThis & {
  __ragQueryEmbedCache?: Map<string, { vector: number[]; expires: number }>;
}).__ragQueryEmbedCache || ((globalThis as any).__ragQueryEmbedCache = new Map());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function chunkId(documentHash: string, chunkIndex: number) {
  return `${documentHash}:${chunkIndex}`;
}

export function contentFingerprint(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function detectSectionTitle(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 24)) {
    const md = line.match(/^#{1,6}\s+(.+)$/);
    if (md) return md[1].trim();
    if (/^(unit|chapter|section|module|part|lesson)\b/i.test(line) && line.length < 140) return line;
    if (/^\d+(\.\d+){0,4}\s+\S.{4,120}$/.test(line) && line.length < 140) return line;
    if (/^[A-Z][A-Za-z0-9 &/(),.-]{8,90}$/.test(line) && !/[.!?]$/.test(line)) return line;
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashFilter(hashes: string[]) {
  return { $or: [{ documentHash: { $in: hashes } }, { hash: { $in: hashes } }, { documentId: { $in: hashes } }] };
}

function rowToScored(row: Record<string, any>, cosine: number, lexical: number, phrase: number, metadata: number, score: number, factualField?: FactualField, fileNameByHash?: Map<string, string>): ScoredChunk {
  const documentHash = String(row.documentHash || row.hash || row.documentId || "");
  const text = String(row.text || row.content || "");
  const page = typeof row.pageNumber === "number" ? row.pageNumber : (row.metadata?.loc?.pageNumber ?? row.loc?.pageNumber ?? null);
  return {
    text,
    embedding: Array.isArray(row.embedding) ? row.embedding : [],
    cosine,
    lexical,
    phraseScore: phrase,
    metadataScore: metadata,
    score,
    pageNumber: typeof page === "number" ? page : null,
    chunkIndex: typeof row.chunkIndex === "number" ? row.chunkIndex : -1,
    documentId: String(row.documentId || documentHash),
    documentHash,
    // Legacy pre-migration rows (hash + content + loc.lines, no fileName) used
    // to fall back to an "Untitled document (hash)" placeholder. Resolve the
    // real uploaded filename from the document's manifest instead — the
    // manifest always has the correct fileName even when the chunk row doesn't.
    fileName: String(
      row.fileName || row.filename || row.metadata?.fileName ||
      fileNameByHash?.get(documentHash) ||
      `Untitled document (${documentHash.slice(0, 8) || "unknown"})`,
    ),
    section: typeof row.section === "string" ? row.section : undefined,
    factualField,
  };
}

/** Resolve real uploaded filenames for chunk rows whose fileName is missing
 *  (legacy pre-migration rows). Manifests always store the true fileName. */
async function fileNamesByHash(hashes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!hashes.length) return map;
  try {
    const col = await manifestsCollection();
    const rows = await withMongoRetry(
      () =>
        col
          .find(
            { $or: [{ _id: { $in: hashes as any[] } }, { documentHash: { $in: hashes } }, { hash: { $in: hashes } }] },
            { projection: { _id: 1, documentHash: 1, hash: 1, fileName: 1 } },
          )
          .toArray(),
      "fileNamesByHash",
    );
    for (const row of rows) {
      if (!row.fileName) continue;
      for (const key of [row._id, row.documentHash, row.hash]) {
        if (key) map.set(String(key), String(row.fileName));
      }
    }
  } catch (error) {
    console.warn("[rag] fileNamesByHash lookup failed:", error instanceof Error ? error.message : error);
  }
  return map;
}

export function enrichSplitChunks(
  chunks: Array<{ pageContent: string; metadata: Record<string, unknown> }>,
  extras: { documentId: string; fileName: string }
) {
  return chunks.map((chunk, chunkIndex) => {
    const meta = { ...(chunk.metadata || {}) } as ChunkMeta;
    const loc = (meta.loc && typeof meta.loc === "object") ? { ...meta.loc } : {};
    return {
      pageContent: chunk.pageContent,
      metadata: {
        ...meta,
        documentId: extras.documentId,
        documentHash: extras.documentId,
        fileName: extras.fileName,
        filename: extras.fileName,
        chunkIndex,
        loc,
        contentHash: contentFingerprint(chunk.pageContent),
      } as Record<string, unknown>,
    };
  });
}

export async function vectorsCollection() {
  const db = await getDb();
  return db.collection(RAG_COLLECTION);
}

export async function manifestsCollection() {
  const db = await getDb();
  return db.collection(MANIFEST_COLLECTION);
}

export async function ensureRagIndexes() {
  const vectors = await vectorsCollection();
  const manifests = await manifestsCollection();
  await vectors.createIndex({ documentHash: 1, chunkIndex: 1 }, { unique: true, sparse: true }).catch(() => undefined);
  await vectors.createIndex({ documentHash: 1, pageNumber: 1 }).catch(() => undefined);
  await vectors.createIndex({ hash: 1, chunkIndex: 1 }).catch(() => undefined);
  await vectors.createIndex({ contentHash: 1, documentHash: 1 }).catch(() => undefined);
  await vectors.createIndex({ text: "text", content: "text" }).catch(() => undefined);
  await manifests.createIndex({ documentHash: 1 }).catch(() => undefined);

  const g = globalThis as typeof globalThis & { __ragVectorSearchEnsured?: boolean };
  if (!g.__ragVectorSearchEnsured) {
    try {
      const existing = await vectors.listSearchIndexes().toArray();
      const found = existing.find((idx) => idx.name === VECTOR_SEARCH_INDEX);
      if (!found) {
        await vectors.createSearchIndex(VECTOR_SEARCH_INDEX_DEFINITION);
        console.log(`[rag] Created Atlas Vector Search index "${VECTOR_SEARCH_INDEX}" (${EMBEDDING_DIMENSIONS} dims)`);
      }
    } catch (error) {
      console.warn("[rag] Vector Search index ensure:", error instanceof Error ? error.message : error);
    }
    g.__ragVectorSearchEnsured = true;
  }
}

function retryMs(response: Response, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
  const rawReset = Number(response.headers.get("x-ratelimit-reset"));
  const reset = rawReset - Date.now();
  if (Number.isFinite(reset) && reset > 0) return Math.min(180_000, reset);
  return Math.min(180_000, 5_000 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 1_000);
}

export async function embedPassages(texts: string[], apiKey: string, inputType: "passage" | "query" = "passage"): Promise<number[][]> {
  if (!texts.length) return [];
  for (let attempt = 0; ; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
      
      const response = await fetch(EMBED_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: EMBED_MODEL,
          input: texts,
          encoding_format: "float",
          input_type: inputType,
          truncate: "NONE",
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (response.ok) {
        const data = await response.json() as { data?: { index: number; embedding: number[] }[] };
        const ordered = data.data?.slice().sort((a, b) => a.index - b.index);
        if (
          !ordered ||
          ordered.length !== texts.length ||
          ordered.some((item, i) => item.index !== i || !item.embedding?.length)
        ) {
          // Malformed API response — non-retryable, propagate immediately
          throw Object.assign(
            new Error(`Embedding API returned an incomplete batch (got ${ordered?.length ?? 0}/${texts.length})`),
            { nonRetryable: true },
          );
        }
        return ordered.map((item) => item.embedding);
      }
      const detail = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw Object.assign(
        new Error(`Embedding API error ${response.status}: ${detail}`),
        { nonRetryable: true },
      );
      const delay = retryMs(response, attempt);
      console.warn(`[embed] HTTP ${response.status}; pausing ${Math.ceil(delay / 1000)}s (attempt ${attempt + 1})`);
      await sleep(delay);
      if (attempt >= MAX_EMBED_RETRIES) {
        console.warn("[embed] Rate-limit window still active; waiting 60s and retrying the same batch");
        await sleep(60_000);
        attempt = Math.max(0, attempt - 4);
      }
    } catch (error) {
      // Propagate non-retryable errors (bad status codes, malformed response)
      if ((error as any)?.nonRetryable) throw error;
      if (attempt >= MAX_EMBED_RETRIES) {
        await sleep(60_000);
        attempt = Math.max(0, attempt - 4);
        continue;
      }
      const delay = Math.min(180_000, 2_000 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 1_000);
      console.warn(`[embed] network error (attempt ${attempt + 1}), retrying in ${Math.ceil(delay / 1000)}s:`, error instanceof Error ? error.message : error);
      await sleep(delay);
    }
  }
}

export async function embedQuery(text: string, apiKey: string): Promise<number[] | null> {
  const key = contentFingerprint(text);
  const cached = queryEmbedCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.vector;
  const [vector] = await embedPassages([text], apiKey, "query");
  if (vector) queryEmbedCache.set(key, { vector, expires: Date.now() + QUERY_EMBED_TTL_MS });
  return vector || null;
}

export function toMongoChunk(input: {
  documentHash: string;
  fileName: string;
  pageNumber: number | null;
  chunkIndex: number;
  section?: string;
  text: string;
  embedding: number[];
  contentHash?: string;
}): MongoChunk {
  return {
    _id: chunkId(input.documentHash, input.chunkIndex),
    documentId: input.documentHash,
    documentHash: input.documentHash,
    hash: input.documentHash,
    fileName: input.fileName,
    pageNumber: input.pageNumber,
    chunkIndex: input.chunkIndex,
    section: input.section || null,
    text: input.text,
    content: input.text,
    embedding: input.embedding,
    contentHash: input.contentHash || contentFingerprint(input.text),
    embeddingModel: EMBED_MODEL,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
    metadata: {
      documentId: input.documentHash,
      documentHash: input.documentHash,
      fileName: input.fileName,
      chunkIndex: input.chunkIndex,
      section: input.section,
      loc: { pageNumber: input.pageNumber ?? undefined },
    },
  };
}

export async function persistChunksToMongo(chunks: MongoChunk[]) {
  if (!chunks.length) return;
  // NOTE: ensureRagIndexes() must be called once by the caller (upload job
  // startup) — not here on every batch, which added a full round-trip per write.
  const col = await vectorsCollection();
  await withMongoRetry(
    () =>
      col.bulkWrite(
        chunks.map((doc) => {
          const { _id, ...rest } = doc;
          return {
            updateOne: {
              filter: { _id: _id as any },
              update: { $set: rest, $setOnInsert: { _id } },
              upsert: true,
            },
          };
        }),
        { ordered: false },
      ),
    "persistChunks",
  );
}

export async function upsertManifest(doc: Partial<DocumentManifest> & { documentHash: string; fileName: string }) {
  const col = await manifestsCollection();
  const documentHash = doc.documentHash;
  await withMongoRetry(
    () =>
      col.updateOne(
        { _id: documentHash as any },
        {
          $set: {
            _id: documentHash,
            documentHash,
            hash: documentHash,
            fileName: doc.fileName,
            status: doc.status || "indexing",
            totalChunks: doc.totalChunks ?? 0,
            totalPages: doc.totalPages,
            ...(doc.indexedPages !== undefined ? { indexedPages: doc.indexedPages } : {}),
            indexedChunks: doc.indexedChunks ?? 0,
            embeddingModel: EMBED_MODEL,
            embeddingDimensions: EMBEDDING_DIMENSIONS,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      ),
    "upsertManifest",
  );
}

export async function getIndexedChunkIds(documentHash: string): Promise<Set<string>> {
  const col = await vectorsCollection();
  const rows = await withMongoRetry(
    () =>
      col
        .find(
          { $and: [hashFilter([documentHash]), { "embedding.0": { $exists: true } }] },
          { projection: { _id: 1, chunkIndex: 1 } },
        )
        .toArray(),
    "getIndexedChunkIds",
  );
  return new Set(rows.map((row) => String(row._id ?? chunkId(documentHash, row.chunkIndex))));
}

export async function countIndexedChunks(documentHash: string) {
  const col = await vectorsCollection();
  return withMongoRetry(
    () =>
      col.countDocuments({ $and: [hashFilter([documentHash]), { "embedding.0": { $exists: true } }] }),
    "countIndexedChunks",
  );
}

/** Count distinct page numbers that have at least one indexed chunk */
export async function countIndexedPages(documentHash: string): Promise<number> {
  const col = await vectorsCollection();
  const result = await withMongoRetry(
    () =>
      col
        .aggregate([
          {
            $match: {
              $and: [
                hashFilter([documentHash]),
                { "embedding.0": { $exists: true } },
                { pageNumber: { $type: "number" } },
              ],
            },
          },
          { $group: { _id: "$pageNumber" } },
          { $count: "total" },
        ])
        .toArray(),
    "countIndexedPages",
  );
  return result[0]?.total ?? 0;
}

export async function isDocumentReady(documentHash: string) {
  const manifests = await manifestsCollection();
  const manifest = await withMongoRetry(
    () =>
      manifests.findOne({
        $or: [{ _id: documentHash as any }, { documentHash }, { hash: documentHash }],
      }),
    "isDocumentReady",
  );
  const indexed = await countIndexedChunks(documentHash);
  const total = Number(manifest?.totalChunks || 0);
  return Boolean(
    manifest &&
      (manifest.status === "ready" || manifest.status === "done") &&
      total > 0 &&
      indexed >= total,
  );
}

export async function checkDocumentsReady(hashes: string[]): Promise<string | null> {
  const col = await manifestsCollection();
  const docs = await withMongoRetry(
    () => col.find({
      $or: [
        { _id: { $in: hashes as any[] } },
        { documentHash: { $in: hashes } },
        { hash: { $in: hashes } }
      ]
    }).toArray(),
    "checkDocumentsReady"
  );
  for (const hash of hashes) {
    const m = docs.find(d => String(d._id) === hash || d.documentHash === hash || d.hash === hash);
    if (!m) return `Document not found in index.`;
    if (m.status === "error") return `Indexing failed for document ${m.fileName || hash}.`;
    if (m.status === "indexing") return `Document ${m.fileName || hash} is still indexing.`;
    
    // Fallback check against actual chunks just in case manifest says ready but chunks are missing
    const indexed = await countIndexedChunks(hash);
    if (m.totalChunks > 0 && indexed < m.totalChunks) {
       return `Document ${m.fileName || hash} is partially indexed.`;
    }
  }
  return null;
}

type FsVector = { content?: string; text?: string; embedding: number[]; metadata?: ChunkMeta };

export async function importFilesystemIndexIfNeeded(documentHash: string): Promise<boolean> {
  const directory = path.join(process.cwd(), INDEX_DIR, documentHash);
  const manifestFile = path.join(directory, "manifest.json");
  if (!fs.existsSync(manifestFile)) return false;
  const indexed = await countIndexedChunks(documentHash);
  const prior = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { fileName?: string; totalChunks?: number; totalBatches?: number; completedBatches?: number[] };
  if (indexed >= (prior.totalChunks || 0) && indexed > 0) return true;
  if ((prior.completedBatches?.length || 0) < (prior.totalBatches || 0)) return false;

  const imported: MongoChunk[] = [];
  let sequential = 0;
  for (let i = 0; i < (prior.totalBatches || 0); i++) {
    const batchFile = path.join(directory, `batch-${i}.json`);
    if (!fs.existsSync(batchFile)) return false;
    const batch = JSON.parse(fs.readFileSync(batchFile, "utf8")) as FsVector[];
    for (const vector of batch) {
      const text = String(vector.text || vector.content || "");
      const pageNumber = typeof vector.metadata?.loc?.pageNumber === "number" ? vector.metadata.loc.pageNumber : null;
      const chunkIndex = typeof vector.metadata?.chunkIndex === "number" ? vector.metadata.chunkIndex : sequential;
      sequential += 1;
      if (!text || !vector.embedding?.length) continue;
      imported.push(toMongoChunk({
        documentHash,
        fileName: String(vector.metadata?.fileName || vector.metadata?.filename || prior.fileName || "document"),
        pageNumber,
        chunkIndex,
        section: typeof vector.metadata?.section === "string" ? vector.metadata.section : undefined,
        text,
        embedding: vector.embedding,
      }));
    }
  }
  for (let i = 0; i < imported.length; i += 200) {
    await persistChunksToMongo(imported.slice(i, i + 200));
  }
  await upsertManifest({
    documentHash,
    fileName: prior.fileName || "document",
    status: "ready",
    totalChunks: imported.length,
    indexedChunks: imported.length,
  });
  console.log(`[rag] Migrated ${imported.length} local chunks into MongoDB for ${documentHash.slice(0, 8)}…`);
  return imported.length > 0;
}

// ---------------------------------------------------------------------------
// Page lookup — deterministic, never goes through vector search
// ---------------------------------------------------------------------------

/**
 * Fetch every chunk belonging to the requested pages, scoped to the given
 * document hashes.  Returns chunks sorted by pageNumber then chunkIndex.
 * Embeddings are excluded — they are not needed for page lookup answers.
 */
async function loadPagesFromMongo(
  hashes: string[],
  pages: number[],
): Promise<Record<string, any>[]> {
  const col = await vectorsCollection();
  return withMongoRetry(
    () =>
      col
        .find(
          {
            $and: [
              hashFilter(hashes),
              {
                $or: [
                  { pageNumber: { $in: pages } },
                  { "metadata.loc.pageNumber": { $in: pages } },
                  { "loc.pageNumber": { $in: pages } },
                ],
              },
            ],
          },
          { projection: { embedding: 0 } },
        )
        .sort({ pageNumber: 1, chunkIndex: 1 })
        .toArray(),
    "loadPages",
  );
}

async function isPageInDocumentRange(
  hashes: string[],
  page: number,
): Promise<boolean | null> {
  const col = await manifestsCollection();
  const manifests = await withMongoRetry(
    () =>
      col.find({
        $or: hashes.flatMap((h) => [
          { _id: h as any },
          { documentHash: h },
          { hash: h },
        ]),
      }).toArray(),
    "isPageInRange",
  );
  if (!manifests.length) return null;

  for (const manifest of manifests) {
    const totalPages = Number(manifest.totalPages ?? 0);
    if (totalPages && page >= 1 && page <= totalPages) return true;
  }

  if (manifests.some(m => !m.totalPages)) return null;
  return false;
}

async function loadOverviewAnchors(hashes: string[]) {
  const col = await vectorsCollection();
  const perDoc = await Promise.all(
    hashes.map(async (hash) => {
      const [intro, outro] = await Promise.all([
        withMongoRetry(
          () =>
            col
              .find(hashFilter([hash]), { projection: { embedding: 0 } })
              .sort({ pageNumber: 1, chunkIndex: 1 })
              .limit(2)
              .toArray(),
          "overviewIntro",
        ),
        withMongoRetry(
          () =>
            col
              .find(hashFilter([hash]), { projection: { embedding: 0 } })
              .sort({ pageNumber: -1, chunkIndex: -1 })
              .limit(1)
              .toArray(),
          "overviewOutro",
        ),
      ]);
      return [...intro, ...outro];
    }),
  );
  return perDoc.flat();
}

async function vectorSearchMongo(hashes: string[], queryVector: number[], type: string, limit?: number) {
  const col = await vectorsCollection();

  let numCandidates: number;
  let resultLimit: number;
  if (type === "page") {
    numCandidates = 50; resultLimit = limit || 20;
  } else if (type === "generic_reference" || type === "summary" || type === "broad") {
    numCandidates = BROAD_VECTOR_CANDIDATES; resultLimit = limit || BROAD_VECTOR_LIMIT;
  } else {
    numCandidates = VECTOR_NUM_CANDIDATES; resultLimit = limit || CANDIDATE_LIMIT;
  }

  const perDocLimit = Math.max(8, Math.ceil(resultLimit / hashes.length));
  const perDocCandidates = Math.max(40, Math.ceil(numCandidates / hashes.length));
  const perDoc = await Promise.all(
    hashes.map((hash) =>
      withMongoRetry(
        () =>
          col
            .aggregate([
              {
                $vectorSearch: {
                  index: VECTOR_SEARCH_INDEX,
                  path: "embedding",
                  queryVector,
                  numCandidates: perDocCandidates,
                  limit: perDocLimit,
                  // Equality per document — a single $in across all session
                  // hashes lets ANN spend the whole candidate budget on the
                  // largest / first-indexed file.
                  filter: {
                    $or: [{ documentHash: hash }, { hash: hash }],
                  },
                },
              },
              {
                $project: {
                  text: 1, content: 1, section: 1, fileName: 1, filename: 1,
                  pageNumber: 1, chunkIndex: 1, documentId: 1, documentHash: 1,
                  hash: 1, metadata: 1, loc: 1,
                  score: { $meta: "vectorSearchScore" },
                },
              },
            ])
            .toArray(),
        "vectorSearch",
      ),
    ),
  );
  return perDoc.flat().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
}

async function lexicalSearchMongo(hashes: string[], terms: string[], phraseTerms: string[]) {
  if (!terms.length) return [];
  const col = await vectorsCollection();
  const termClauses = expandedTerms(terms).map((term) => {
    const re = new RegExp(escapeRegex(term), "i");
    return { $or: [{ text: re }, { content: re }, { section: re }] };
  });
  const phrase = phraseTerms.length >= 2 ? phraseTerms.join(" ") : "";
  const query: Record<string, unknown> = {
    $and: [
      hashFilter(hashes),
      phrase
        ? {
            $or: [
              { text: new RegExp(escapeRegex(phrase), "i") },
              { content: new RegExp(escapeRegex(phrase), "i") },
              { section: new RegExp(escapeRegex(phrase), "i") },
              { $or: termClauses },
            ],
          }
        : { $or: termClauses },
    ],
  };
  const perDocLimit = Math.max(8, Math.ceil(CANDIDATE_LIMIT / hashes.length));
  const perDoc = await Promise.all(
    hashes.map((hash) => {
      const scoped: Record<string, unknown> = {
        $and: [hashFilter([hash]), (query.$and as unknown[])[1]],
      };
      return withMongoRetry(
        () => col.find(scoped, { projection: { embedding: 0 } }).limit(perDocLimit).toArray(),
        "lexicalSearch",
      );
    }),
  );
  return perDoc.flat();
}

const FACTUAL_FIELD_PATTERNS: Record<FactualField, RegExp> = {
  // A phone value is commonly stored without the word "phone" beside it.
  phone: /(?:\+?\d[\d\s().-]{6,}\d)/,
  email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  linkedin: /linkedin\.com/i,
  github: /github\.com/i,
  url: /https?:\/\/[^\s]+/i,
  address: /\b(?:address|location|based|relocation|[A-Za-z]+,\s*India)\b/i,
  name: /(?:^|\n)\s*#\s*[A-Z][A-Za-z .'-]{1,100}/m,
  education: /\b(?:education|b\.?tech|b\.?sc|university|college|degree)\b/i,
  experience: /\b(?:experience|intern|engineer|developer|employment)\b/i,
  account: /\b(?:account|acct|iban|swift)\s*(?:number|no\.?|#)?\s*[:.-]?\s*[A-Z0-9-]{6,20}\b/i,
  date: /\b(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4})\b/i,
  amount: /(?:\$|€|£|₹|Rs\.?|USD|EUR|GBP|INR)\s*\d+(?:,\d{3})*(?:\.\d{2})?(?:\s*[kKmMbB](?:illion|n)?)?|\b\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:dollars|euros|pounds|rupees)\b/i,
  id: /\b(?:id|identifier|uuid|guid)\s*[:.-]?\s*[A-Z0-9-]{6,40}\b/i,
};

/**
 * Deterministic field lookup complements vector search for values such as
 * phone numbers and profile URLs that often have little semantic signal.
 */
async function factualFieldSearchMongo(hashes: string[], field: FactualField) {
  const pattern = FACTUAL_FIELD_PATTERNS[field];
  const col = await vectorsCollection();
  const perDocLimit = Math.max(8, Math.ceil(CANDIDATE_LIMIT / hashes.length));
  const perDoc = await Promise.all(
    hashes.map((hash) =>
      withMongoRetry(
        () =>
          col.find({
            $and: [
              hashFilter([hash]),
              { $or: [{ text: pattern }, { content: pattern }] },
            ],
          }, { projection: { embedding: 0 } }).limit(perDocLimit).toArray(),
        "factualFieldSearch",
      ),
    ),
  );
  return perDoc.flat().filter((row) => factualFieldMatches(String(row.text || row.content || ""), field));
}

function factualFieldMatches(text: string, field: FactualField) {
  if (field !== "phone") return FACTUAL_FIELD_PATTERNS[field].test(text);
  // Reject dates and years that can superficially resemble a spaced number.
  return [...text.matchAll(/(?:\+?\d[\d\s().-]{6,}\d)/g)].some((match) => {
    const digitCount = match[0].replace(/\D/g, "").length;
    return digitCount >= 10 && digitCount <= 15;
  });
}

function diagnosticChunks(chunks: ScoredChunk[]) {
  return chunks.slice(0, 10).map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    pageNumber: chunk.pageNumber,
    doc: chunk.documentHash.slice(0, 8),
    file: chunk.fileName,
    cosine: Number(chunk.cosine.toFixed(4)),
    lexical: Number(chunk.lexical.toFixed(4)),
    phrase: Number(chunk.phraseScore.toFixed(4)),
    metadata: Number(chunk.metadataScore.toFixed(4)),
    score: Number(chunk.score.toFixed(4)),
    factualField: chunk.factualField,
    preview: chunk.text.replace(/\s+/g, " ").slice(0, 180),
  }));
}

function diagnosticRows(rows: Record<string, any>[]) {
  return rows.slice(0, 10).map((row) => ({
    chunkIndex: typeof row.chunkIndex === "number" ? row.chunkIndex : -1,
    pageNumber: typeof row.pageNumber === "number" ? row.pageNumber : (row.metadata?.loc?.pageNumber ?? row.loc?.pageNumber ?? null),
    doc: String(row.documentHash || row.hash || row.documentId || "").slice(0, 8) || "?",
    file: row.fileName || row.filename || row.metadata?.fileName || "?",
    vectorScore: typeof row.score === "number" ? Number(row.score.toFixed(4)) : undefined,
    preview: String(row.text || row.content || "").replace(/\s+/g, " ").slice(0, 180),
  }));
}

async function loadNeighbors(hits: ScoredChunk[]) {
  if (!hits.length) return [];
  const col = await vectorsCollection();
  const clauses = hits.flatMap((hit) => {
    if (hit.chunkIndex === undefined || hit.chunkIndex < 0) return [];
    const indexes: number[] = [];
    for (let d = -NEIGHBOR_RADIUS; d <= NEIGHBOR_RADIUS; d++) {
      if (!d) continue;
      const idx = hit.chunkIndex + d;
      if (idx >= 0) indexes.push(idx);
    }
    if (!indexes.length) return [];
    return [{ $and: [hashFilter([hit.documentHash]), { chunkIndex: { $in: indexes } }] }];
  });
  if (!clauses.length) return [];
  return withMongoRetry(
    () => col.find({ $or: clauses }, { projection: { embedding: 0 } }).toArray(),
    "loadNeighbors",
  );
}

export type RetrievalResult = {
  context: string;
  relevant: boolean;
  pageLookup: boolean;
  queryType: string;
  intent: QueryIntent;
  usedChunks: number;
  pageNumber?: number;        // set for PAGE_LOOKUP results
  emptyPage?: boolean;        // true when page exists but has no extractable text
  rewrittenQuery?: string;
  extractedTopic?: string;
  consideredHashes?: string[];
  chunks?: ScoredChunk[];
};

export type RetrievalDeps = {
  ensureIndexes?: () => Promise<void>;
  migrate?: (hash: string) => Promise<boolean>;
  loadPages?: (hashes: string[], pages: number[]) => Promise<Record<string, any>[]>;
  loadOverview?: (hashes: string[]) => Promise<Record<string, any>[]>;
  vectorSearch?: (hashes: string[], queryVector: number[], type: string, limit?: number) => Promise<Record<string, any>[]>;
  lexicalSearch?: (hashes: string[], terms: string[]) => Promise<Record<string, any>[]>;
  factualFieldSearch?: (hashes: string[], field: FactualField) => Promise<Record<string, any>[]>;
  loadNeighbors?: (hits: ScoredChunk[]) => Promise<Record<string, any>[]>;
  embedQuery?: (text: string, apiKey: string) => Promise<number[] | null>;
};

export async function retrieveForQuery(opts: {
  query: string;
  hashes: string[];
  apiKey: string;
  conversationContext?: ConversationContext;
}, deps: RetrievalDeps = {}): Promise<RetrievalResult> {
  const hashes = [...new Set(opts.hashes.filter(Boolean))];
  const empty: RetrievalResult = { context: "", relevant: false, pageLookup: false, queryType: "none", intent: "GENERAL", usedChunks: 0, consideredHashes: hashes, chunks: [] };
  if (!hashes.length) return empty;

  const fileNameByHash = await fileNamesByHash(hashes);

  console.log(`[rag] ============ QUERY(${hashes.length} doc): "${opts.query}" hashes=[${hashes.map((h) => h.slice(0, 8)).join(", ")}]`);

  try {
    await (deps.ensureIndexes || ensureRagIndexes)();
  } catch (error) {
    console.error("[rag] MongoDB index setup failed:", error instanceof Error ? error.message : error);
  }
  // NOTE: filesystem migration (importFilesystemIndexIfNeeded) is intentionally
  // NOT called here.  It belongs in the upload job only.  Running fs.existsSync
  // on every chat query added synchronous I/O to the retrieval hot-path and
  // caused silent re-migrations on every request.
  if (deps.migrate) {
    for (const hash of hashes) {
      try { await deps.migrate(hash); } catch (e) {
        console.warn("[rag] injected migrate skipped:", e instanceof Error ? e.message : e);
      }
    }
  }

  const classified = classifyQuery(opts.query, opts.conversationContext);
  const queryType = classified.type;
  const intent    = classified.intent;
  const terms     = classified.terms;
  const pages     = classified.pages;
  const rewrittenQuery = classified.rewrittenQuery;
  const factualField = classified.factualField;

  console.log(`[rag] queryType=${queryType} intent=${intent} terms=[${terms.join(",")}] pages=[${pages.join(",")}]${factualField ? ` factualField=${factualField}` : ""}${rewrittenQuery ? ` rewritten="${rewrittenQuery}"` : ""}`);

  // ── PAGE LOOKUP ─────────────────────────────────────────────────────────
  // Deterministic MongoDB query — NO embeddings, NO vector search, NO lexical
  // reranking.  Correct for any page 1–N in any document.
  if (queryType === "page" && pages.length) {
    const requestedPage = pages[0]; // primary page (range queries use first page)
    console.log(`[rag] query="${opts.query.slice(0, 80)}"`);
    console.log(`[rag] queryType=page_lookup`);
    console.log(`[rag] intent=PAGE_LOOKUP`);
    console.log(`[rag] pageNumber=${requestedPage}`);
    console.log(`[rag] pageLookup=true`);
    console.log(`[rag] documentHashes=${hashes.length}`);

    try {
      const rows = await (deps.loadPages || loadPagesFromMongo)(hashes, pages);
      console.log(`[rag] pageChunks=${rows.length}`);

      if (rows.length > 0) {
        // Normal case — page has text chunks
        const chunkLimit = INTENT_CHUNK_LIMIT["PAGE_LOOKUP"];
        const charBudget  = INTENT_CONTEXT_CHARS["PAGE_LOOKUP"];
        const scored = rows.map((row) => rowToScored(row, 1, 1, 1, 1, 1, undefined, fileNameByHash)).slice(0, chunkLimit);
        return {
          context: packContext(scored, charBudget, true),
          relevant: true,
          pageLookup: true,
          queryType,
          intent,
          usedChunks: scored.length,
          pageNumber: requestedPage,
          consideredHashes: hashes,
          chunks: scored,
        };
      }

      // No chunks found for this page — check if it's within the document range
      const inRange = await isPageInDocumentRange(hashes, requestedPage);

      if (inRange === false) {
        // Page number is outside the document's total page count
        return {
          context: `[PAGE_OUT_OF_RANGE:${requestedPage}]`,
          relevant: true,   // relevant=true so RAG_FOUND_SYSTEM is used and we can give a good answer
          pageLookup: true,
          queryType,
          intent,
          usedChunks: 0,
          pageNumber: requestedPage,
          emptyPage: false,
        };
      }

      // Page is within range (or range is unknown) but no text was indexed —
      // the page likely exists as an image, scanned page, or blank page.
      return {
        context: `[EMPTY_PAGE:${requestedPage}]`,
        relevant: true,   // use RAG_FOUND_SYSTEM so the model can explain gracefully
        pageLookup: true,
        queryType,
        intent,
        usedChunks: 0,
        pageNumber: requestedPage,
        emptyPage: true,
      };
    } catch (error) {
      console.error("[rag] page lookup failed:", error instanceof Error ? error.message : error);
      return { ...empty, pageLookup: true, queryType, intent, pageNumber: requestedPage };
    }
  }

  // Use rewritten query for embedding if available
  const queryForEmbedding = rewrittenQuery || opts.query;

  // QUERY EMBEDDING
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await (deps.embedQuery || embedQuery)(queryForEmbedding, opts.apiKey);
  } catch (error) {
    console.error("[rag] Query embedding failed:", error instanceof Error ? error.message : error);
  }

  // VECTOR SEARCH
  let vectorRows: Record<string, any>[] = [];
  if (queryEmbedding?.length === EMBEDDING_DIMENSIONS || (queryEmbedding && deps.vectorSearch)) {
    try {
      vectorRows = await (deps.vectorSearch || ((h, v, t) => vectorSearchMongo(h, v, t)))(hashes, queryEmbedding, queryType);
      console.log(`[rag] vectorCandidates=${vectorRows.length}`);
      console.log(`[rag] vectorCandidateScores=${JSON.stringify(diagnosticRows(vectorRows))}`);
    } catch (error) {
      console.error("[rag] MongoDB $vectorSearch failed:", error instanceof Error ? error.message : error);
    }
  } else if (queryEmbedding && queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    console.error(`[rag] Query embedding dimension ${queryEmbedding.length} != ${EMBEDDING_DIMENSIONS}`);
  }

  // LEXICAL SEARCH (for queries with distinctive terms)
  let lexicalRows: Record<string, any>[] = [];
  if (terms.length > 0 && (queryType === "specific" || queryType === "concept" || queryType === "factual" || queryType === "comparison")) {
    try {
      lexicalRows = await (deps.lexicalSearch || ((h, t) => lexicalSearchMongo(h, t, t)))(hashes, terms);
      console.log(`[rag] lexicalCandidates=${lexicalRows.length}`);
      console.log(`[rag] lexicalCandidateChunks=${JSON.stringify(diagnosticRows(lexicalRows))}`);
    } catch (error) {
      console.warn("[rag] lexical search failed:", error instanceof Error ? error.message : error);
    }
  }

  // FIELD KEYWORD FALLBACK — preserves vector retrieval and only supplements
  // it for explicitly requested factual/profile fields.
  let factualRows: Record<string, any>[] = [];
  if (factualField) {
    try {
      factualRows = await (deps.factualFieldSearch || factualFieldSearchMongo)(hashes, factualField);
      console.log(`[rag] factualFieldCandidates=${factualRows.length} field=${factualField}`);
      console.log(`[rag] factualFieldCandidateChunks=${JSON.stringify(diagnosticRows(factualRows))}`);
    } catch (error) {
      console.warn("[rag] factual field search failed:", error instanceof Error ? error.message : error);
    }
  }

  // OVERVIEW ANCHORS (for broad queries)
  let overviewRows: Record<string, any>[] = [];
  if (queryType === "broad" || queryType === "summary" || queryType === "generic_reference") {
    try {
      overviewRows = await (deps.loadOverview || loadOverviewAnchors)(hashes);
      console.log(`[rag] overviewAnchors=${overviewRows.length}`);
    } catch (error) {
      console.warn("[rag] overview anchors failed:", error instanceof Error ? error.message : error);
    }
  }

  // MERGE AND SCORE CANDIDATES
  const byKey = new Map<string, ScoredChunk>();
  const addRow = (row: Record<string, any>, cosine: number, matchedField?: FactualField, minScore = 0) => {
    const text = String(row.text || row.content || "");
    // Legacy chunks indexed before the OCR-placeholder fix (or any page OCR
    // still failed on) can hold pdf-oxide's "[OCR REQUIRED]" sentence as
    // their entire content. That is not evidence — never let it compete for
    // a slot (the overview-anchor floor below would otherwise guarantee it
    // one) or get shown to the model as a document's real content.
    if (/\[OCR REQUIRED/i.test(text)) return;
    const section = typeof row.section === "string" ? row.section : undefined;
    const lexical = lexicalScore(text, section, terms);
    const phrase = phraseScore(text, section, terms);
    
    // Create a temporary chunk for metadata scoring
    const page = typeof row.pageNumber === "number" ? row.pageNumber : (row.metadata?.loc?.pageNumber ?? row.loc?.pageNumber ?? null);
    const tempChunk: ScoredChunk = {
      text,
      embedding: [],
      cosine: 0,
      lexical: 0,
      phraseScore: 0,
      metadataScore: 0,
      score: 0,
      pageNumber: typeof page === "number" ? page : null,
      chunkIndex: typeof row.chunkIndex === "number" ? row.chunkIndex : -1,
      documentId: "",
      documentHash: String(row.documentHash || row.hash || ""),
      fileName: "",
      section,
    };
    
    const metadata = metadataScore(tempChunk, terms, pages);
    const score = Math.max(
      hybridScore(cosine, lexical, phrase, metadata, queryType),
      matchedField ? 0.70 : 0,
      minScore,
    );
    const chunk = rowToScored(row, cosine, lexical, phrase, metadata, score, matchedField, fileNameByHash);
    const key = `${chunk.documentHash}:${chunk.chunkIndex}:${chunk.pageNumber}:${contentFingerprint(chunk.text).slice(0, 12)}`;
    const prev = byKey.get(key);
    if (!prev || prev.score < chunk.score) {
      if (prev) {
        // The field match supplies deterministic relevance; retain the vector
        // and lexical evidence already collected for the same source chunk.
        chunk.cosine = Math.max(chunk.cosine, prev.cosine);
        chunk.lexical = Math.max(chunk.lexical, prev.lexical);
        chunk.phraseScore = Math.max(chunk.phraseScore, prev.phraseScore);
        chunk.metadataScore = Math.max(chunk.metadataScore, prev.metadataScore);
      }
      byKey.set(key, chunk);
    }
  };

  for (const row of vectorRows) addRow(row, typeof row.score === "number" ? row.score : 0);
  for (const row of lexicalRows) addRow(row, 0);
  for (const row of factualRows) addRow(row, 0, factualField);
  for (const row of overviewRows) {
    const baseCosine = typeof row.score === "number" ? row.score : 0;
    const isOverviewIntent = queryType === "broad" || queryType === "summary" || queryType === "generic_reference";
    // Overview anchors are each document's real intro/outro content — the
    // deterministic answer to "what is this document". They must outrank
    // coincidental vector-search noise from an unrelated, much larger
    // document (e.g. answer-key fragments that happen to cosine-match a
    // vague query), or diversifyByDocument picks that noise as the
    // document's representative chunk and the model gets garbage under a
    // correct-looking source label.
    addRow(row, baseCosine, undefined, isOverviewIntent ? 0.75 : 0);
  }

  console.log(`[rag] merged=${byKey.size}`);
  console.log(`[rag] mergedCandidates=${JSON.stringify(diagnosticChunks([...byKey.values()]))}`);

  // FILTER CANDIDATES
  const filtered = filterCandidates([...byKey.values()], queryType, terms);
  console.log(`[rag] filtered=${filtered.length}`);

  // DETERMINE FINAL LIMIT — driven by intent, not just query type
  const limit = INTENT_CHUNK_LIMIT[intent] ?? (
    queryType === "generic_reference" ? FINAL_CHUNK_LIMIT_GENERIC :
    queryType === "broad" || queryType === "summary" ? FINAL_CHUNK_LIMIT_BROAD :
    FINAL_CHUNK_LIMIT_SPECIFIC
  );

  // RANK AND DIVERSIFY
  // Multi-document chats must not let one file fill every final slot.
  const ranked = hashes.length > 1
    ? diversifyByDocument(filtered, limit)
    : (queryType === "broad" || queryType === "summary" || queryType === "generic_reference")
      ? diversifyByPage(filtered, limit, queryType)
      : filtered.sort((a, b) => b.score - a.score).slice(0, limit);

  if (!ranked.length) return { ...empty, queryType, intent, rewrittenQuery };
  console.log(`[rag] reranked=${ranked.length}`);
  console.log(`[rag] rerankedChunks=${JSON.stringify(diagnosticChunks(ranked))}`);

  // NEIGHBOR EXPANSION (for specific/concept/factual/comparison only — skip for broad intents)
  let selected = ranked;
  if (queryType === "specific" || queryType === "concept" || queryType === "factual" || queryType === "comparison") {
    try {
      const neighborRows = await (deps.loadNeighbors || loadNeighbors)(ranked);
      // Legacy rows may not have chunkIndex. Include content in the identity so
      // they cannot collapse into one arbitrary final chunk.
      const selectionKey = (documentHash: string, chunkIndex: number, text: string) =>
        `${documentHash}:${chunkIndex}:${contentFingerprint(text).slice(0, 12)}`;
      const merged = new Map(ranked.map((c) => [selectionKey(c.documentHash, c.chunkIndex, c.text), c]));
      for (const row of neighborRows) {
        const page = typeof row.pageNumber === "number" ? row.pageNumber : (row.metadata?.loc?.pageNumber ?? row.loc?.pageNumber ?? null);
        const chunkIndex = typeof row.chunkIndex === "number" ? row.chunkIndex : -1;
        const documentHash = String(row.documentHash || row.hash || row.documentId || "");
        const text = String(row.text || row.content || "");
        const key = selectionKey(documentHash, chunkIndex, text);
        if (!merged.has(key)) {
          const nearest = ranked.find((t) => t.documentHash === documentHash);
          if (nearest) {
            const samePage    = nearest.pageNumber !== null && page !== null && nearest.pageNumber === page;
            const adjacentPage = nearest.pageNumber !== null && page !== null && Math.abs(page - nearest.pageNumber) <= 1;
            const sameSection = nearest.section && typeof row.section === "string" && nearest.section === row.section;
            if (samePage || adjacentPage || sameSection) {
              const neighborScore = nearest.score * (samePage ? 0.95 : adjacentPage ? 0.88 : 0.82);
              merged.set(key, rowToScored(row, nearest.cosine * 0.9, nearest.lexical * 0.85, nearest.phraseScore * 0.85, nearest.metadataScore, neighborScore, undefined, fileNameByHash));
            }
          }
        }
      }
      // Cap at intent limit + small buffer so neighbors don't bloat context
      selected = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit + 2);
    } catch (error) {
      console.warn("[rag] neighbor expansion failed:", error instanceof Error ? error.message : error);
    }
  }

  const retrievedHashes = [...new Set(selected.map((chunk) => chunk.documentHash).filter(Boolean))];
  console.log(`[rag] consideredHashes=${hashes.length} retrievedHashes=${retrievedHashes.length} files=${[...new Set(selected.map((c) => c.fileName))].join(" | ")}`);
  console.log(`[rag] finalChunks=${selected.length} intent=${intent}`);
  console.log(`[rag] finalChunksSentToLlm=${JSON.stringify(diagnosticChunks(selected))}`);

  // PACK CONTEXT — use intent-specific character budget
  const charBudget = INTENT_CONTEXT_CHARS[intent] ?? 6_000;
  const context = packContext(selected, charBudget, queryType === "page" || intent === "PAGE_LOOKUP");
  if (!context.trim()) return { ...empty, queryType, intent, rewrittenQuery };

  // Extract topic for conversation context
  let extractedTopic: string | undefined;
  if (terms.length > 0) {
    extractedTopic = terms.slice(0, 3).join(" ");
  } else if (selected.length > 0 && selected[0].section) {
    extractedTopic = selected[0].section;
  }

  return {
    context,
    relevant: true,
    pageLookup: false,
    queryType,
    intent,
    usedChunks: selected.length,
    rewrittenQuery,
    extractedTopic,
    consideredHashes: hashes,
    chunks: selected,
  };
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

/**
 * Base persona used for every RAG-enabled answer.
 * Key rules deliberately written here so callers can compose onto it.
 */
const PERSONA = "You are Chatit, a document-aware AI assistant developed by Echos.";

const ANSWER_RULES = `
Rules:
- Answer the user's question directly. Put the answer in the first sentence.
- You MUST answer STRICTLY using only the provided document context. Do not invent, guess, or hallucinate facts.
- If the documents do not contain the answer, say EXACTLY: "I couldn't find that in the uploaded documents."
- Never say "I couldn't find it" if you haven't checked all provided sources.
- Cite the source document by name naturally (e.g. "According to the invoice..." or "In the Himanshu Resume...").
- Never mention "excerpts", "passages", "chunks", "embeddings", "vector search", "RAG", or any internal processing detail.
- Never say "based on the provided context" or "according to the retrieved passages".
- Do not mention page numbers unless the user explicitly asks what page a fact is on, or asks about a specific page.
- Do not summarise the whole document unless the user explicitly asks for a summary.`.trim();

export const RAG_FOUND_SYSTEM = `${PERSONA}

You have access to relevant sections from the user's uploaded documents. Use every provided source. If several files appear in the context, do not assume the first file is the subject of the question — answer from the source that actually contains the fact. If the question is ambiguous across files, briefly summarize what each document is about or distinguish the sources.

${ANSWER_RULES}`;

export const RAG_MISSING_SYSTEM = `${PERSONA}

The uploaded documents were searched but no relevant content was found for this question. Tell the user clearly: "I couldn't find that in the uploaded documents." You may suggest rephrasing or specifying a page number. Do not answer from general knowledge.`;

export const DEFAULT_SYSTEM = `${PERSONA}

Answer helpfully and concisely. If the user is asking about an uploaded document, focus your answer on the document. If no document context is available, use your general knowledge.`;
