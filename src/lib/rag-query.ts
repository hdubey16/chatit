export type QueryType = "page" | "generic_reference" | "concept" | "factual" | "summary" | "comparison" | "broad" | "specific";

/** A document field that can be retrieved deterministically when embeddings are weak. */
export type FactualField =
  | "phone"
  | "email"
  | "linkedin"
  | "github"
  | "address"
  | "name"
  | "education"
  | "experience"
  | "url"
  | "account"
  | "date"
  | "amount"
  | "id";

/**
 * Intent is the user-facing answer-shaping layer on top of QueryType.
 * It controls:
 *  - how many final chunks to send to Sarvam
 *  - the context character budget
 *  - which system-prompt variant to use
 *  - verbosity hint injected into the user message
 */
export type QueryIntent =
  | "DOCUMENT_OVERVIEW"   // "what is this?", "what does this cover?"
  | "SUMMARY"             // "summarize this", "give me a summary"
  | "DEFINITION"          // "what is K-Means?", "define partitioning clustering"
  | "SIMPLE_FACT"         // "who is the author?", "how many chapters?"
  | "PAGE_LOOKUP"         // "what is on page 558?"
  | "SPECIFIC_TOPIC"      // "explain backpropagation", "tell me about clustering"
  | "COMPARISON"          // "compare K-Means and Q-learning"
  | "MULTI_PART"          // "explain X and Y and also Z"
  | "GENERAL";            // everything else

/** Maximum chunks to pass to Sarvam per intent — keep context small */
export const INTENT_CHUNK_LIMIT: Record<QueryIntent, number> = {
  DOCUMENT_OVERVIEW:  6,
  SUMMARY:            8,
  DEFINITION:         4,
  SIMPLE_FACT:        3,
  PAGE_LOOKUP:        6,
  SPECIFIC_TOPIC:     6,
  COMPARISON:         8,
  MULTI_PART:         8,
  GENERAL:            5,
};

/** Maximum context characters per intent — prevents Sarvam overload */
export const INTENT_CONTEXT_CHARS: Record<QueryIntent, number> = {
  DOCUMENT_OVERVIEW:  5_000,
  SUMMARY:            8_000,
  DEFINITION:         3_000,
  SIMPLE_FACT:        2_000,
  PAGE_LOOKUP:        6_000,
  SPECIFIC_TOPIC:     5_000,
  COMPARISON:         7_000,
  MULTI_PART:         8_000,
  GENERAL:            4_000,
};

/** One-line verbosity hint appended to the user question so Sarvam knows how much to write */
export const INTENT_VERBOSITY_HINT: Record<QueryIntent, string> = {
  DOCUMENT_OVERVIEW:  "Answer in 1–2 sentences.",
  SUMMARY:            "Answer in 5–8 bullet points unless asked for more.",
  DEFINITION:         "Give the definition in 2–3 sentences, then 1 supporting detail if useful.",
  SIMPLE_FACT:        "Answer in one sentence.",
  PAGE_LOOKUP:        "Report what the page contains.",
  SPECIFIC_TOPIC:     "Answer in 3–5 sentences.",
  COMPARISON:         "Use a short table or 3–5 bullet points.",
  MULTI_PART:         "Address each part briefly.",
  GENERAL:            "Be concise.",
};

export type ScoredChunk = {
  text: string;
  embedding: number[];
  score: number;
  cosine: number;
  lexical: number;
  phraseScore: number;
  metadataScore: number;
  pageNumber: number | null;
  chunkIndex: number;
  documentId: string;
  documentHash: string;
  fileName: string;
  section?: string;
  factualField?: FactualField;
};

export type ConversationContext = {
  lastQuery?: string;
  lastRetrievedContext?: string;
  lastPage?: number;
  lastSection?: string;
  lastTopic?: string;
};

export const FINAL_CHUNK_LIMIT_SPECIFIC = 6;  // kept for compatibility — prefer INTENT_CHUNK_LIMIT
export const FINAL_CHUNK_LIMIT_BROAD    = 8;
export const FINAL_CHUNK_LIMIT_GENERIC  = 6;
export const MAX_CONTEXT_CHARS = 8_000;       // default; overridden per-intent in packContext

// Adaptive thresholds based on query type
export const MIN_COSINE_BROAD = 0.10;
export const MIN_COSINE_SPECIFIC = 0.18;
export const MIN_COSINE_GENERIC = 0.08;
export const MIN_COSINE_NO_TERMS = 0.45;
export const MIN_HYBRID_SPECIFIC = 0.22;
export const MIN_HYBRID_GENERIC = 0.12;
export const STRONG_LEXICAL = 0.48;

const STOPWORDS = new Set([
  "what", "whats", "is", "are", "was", "were", "the", "a", "an", "of", "in", "on", "for",
  "to", "and", "or", "how", "does", "do", "did", "please", "explain", "define", "tell",
  "me", "about", "from", "which", "who", "when", "where", "why", "with",
  "can", "you", "give", "brief", "short", "describe", "meaning", "mean",
  "say", "says", "show", "shown", "discuss",
  // page-query words — must never become semantic search terms
  "page", "pages", "number", "num", "okay", "ok", "so", "just", "now",
  "hey", "hi", "well", "alright", "right", "sure", "please", "kindly",
]);

const GENERIC_DOC_TERMS = new Set([
  "document", "documents", "pdf", "file", "files", "notes", "note", "content", "contents",
  "topic", "topics", "overview", "summarize", "summarise", "chapter", "chapters",
  "section", "sections", "material", "materials", "book", "paper", "text", "uploaded",
  "attached", "cover", "covered", "covers", "contain", "contains", "containing",
]);

// Patterns for generic reference queries
const GENERIC_REFERENCE_PATTERNS = [
  /^(what|who) (is|are|does|about) (this|that|it|these|those)(\?|\s|$)/i,
  /^(explain|describe|tell me about|summarize|summary of) (this|that|it|these|those)(\?|\s|$)/i,
  /^(this|that|it)(\?|\s|$)/i,
  /^(what|who)('s| is| are| does) (it|this|that|these|those)(\?|\s|$)/i,
  /^can you (explain|describe|tell me about|summarize) (this|that|it)(\?|\s|$)/i,
];

const BROAD_INTENT = /\b(summar(y|ize|ise)|overview|topics?|covered|contents?|about this|tell me about|(what|who) (is|are|does) this|explain this|introduce|introduction|main (idea|ideas|points)|(what|who) is (the )?(pdf|document|file|notes))\b/i;

export const TOPIC_EXPAND: Record<string, string[]> = {
  clustering: ["k-means", "kmeans", "centroid", "partitioning", "hierarchical", "dbscan"],
  partitioning: ["clustering", "k-means", "kmeans", "centroid"],
  "k-means": ["clustering", "kmeans", "centroid", "partitioning"],
  kmeans: ["clustering", "k-means", "centroid", "partitioning"],
  "machine learning": ["ml", "ai", "artificial intelligence", "neural network"],
  ml: ["machine learning", "ai", "model", "training"],
  "neural network": ["deep learning", "cnn", "rnn", "lstm", "backpropagation"],
  reinforcement: ["q-learning", "reward", "policy", "agent"],
  supervised: ["classification", "regression", "labeled", "training"],
  unsupervised: ["clustering", "dimensionality", "pca", "unlabeled"],
};

export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)) {
    // Skip: too short, stopword, already seen, or a pure integer (page numbers, IDs)
    if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw) || /^\d+$/.test(raw)) continue;
    seen.add(raw);
    terms.push(raw);
  }
  return terms;
}

export function distinctiveTerms(terms: string[]): string[] {
  return terms.filter((term) => !GENERIC_DOC_TERMS.has(term));
}

export function expandedTerms(terms: string[]) {
  const seen = new Set(terms);
  const out = [...terms];
  for (const term of terms) {
    for (const extra of TOPIC_EXPAND[term] || []) {
      if (!seen.has(extra)) {
        seen.add(extra);
        out.push(extra);
      }
    }
  }
  return out;
}

export function parsePageQuery(query: string): { pages: number[]; pageLookupOnly: boolean } {
  const pages = new Set<number>();

  // ── Stage 1: strip filler prefix so it never confuses the patterns ──────
  // e.g. "okay so", "can you", "please", "tell me", "show me", etc.
  const FILLER_PREFIX = /^[\s,.]*(okay|ok|sure|alright|right|so|hey|hi|well|now|please|kindly|can you|could you|would you|will you|tell me|show me|let me know|give me|i want to know|i would like to know|i need to know|what about|how about)\s+/i;
  const q = query.replace(FILLER_PREFIX, "").replace(FILLER_PREFIX, "").trim(); // run twice for "okay so can you"

  // ── Stage 2: explicit range  "pages 10 to 15" / "pages 10-15" ──────────
  const rangeMatch = q.match(/\b(?:pages?|pg\.?)\s+(\d+)\s*(?:to|[-–])\s*(\d+)\b/i);
  if (rangeMatch) {
    const a = parseInt(rangeMatch[1], 10);
    const b = parseInt(rangeMatch[2], 10);
    const from = Math.min(a, b);
    const to   = Math.min(from + 4, Math.max(a, b)); // cap at 5-page range
    for (let p = from; p <= to; p++) pages.add(p);
  }

  // ── Stage 3: "page number N" / "page no N" / "page no. N" ───────────────
  // This is the variant that was previously broken.
  const pageNumberMatch = q.match(/\bpage\s+(?:number|no\.?|num\.?|#)\s*(\d+)\b/i);
  if (pageNumberMatch) pages.add(parseInt(pageNumberMatch[1], 10));

  // ── Stage 4: standard "page N" / "pg. N" / "p. N" / "pg N" ─────────────
  const stdRe = /\b(?:pages?|pg\.?|p\.)\s*(\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = stdRe.exec(q))) pages.add(parseInt(m[1], 10));

  // ── Stage 5: bare digit when the stripped query is ONLY the number ───────
  // e.g. user types "596" or "596?" after a document is loaded
  const bareDigit = q.replace(/[^0-9]/g, "").trim();
  const nonDigit  = q.replace(/\d/g, "").replace(/[^a-z]/gi, "").trim();
  if (bareDigit && !nonDigit && bareDigit.length <= 4) {
    pages.add(parseInt(bareDigit, 10));
  }

  if (pages.size === 0) return { pages: [], pageLookupOnly: false };

  // ── Stage 6: decide if this is a pure page-lookup or a hybrid ────────────
  // Strip every page-reference token out of the remaining query text, then
  // check whether any *distinctive* non-filler words remain.
  const stripped = q
    // remove "page number N", "page no N"
    .replace(/\bpage\s+(?:number|no\.?|num\.?|#)\s*\d+\b/gi, " ")
    // remove "page N" / "pg N" / "p. N"
    .replace(/\b(?:pages?|pg\.?|p\.)\s*\d+\b/gi, " ")
    // remove range
    .replace(/\b\d+\s*(?:to|[-–])\s*\d+\b/gi, " ")
    // remove bare numbers
    .replace(/\b\d+\b/g, " ");

  const residualTerms = distinctiveTerms(queryTerms(stripped));

  // Pure page-lookup cues — phrases whose only job is to introduce the page number
  const lookupCue = /\b(what(?:'s| is| are| does)?\s+(?:on|in|at)|show|display|list|give|fetch|get|read|open|go\s+to|jump\s+to|take\s+me\s+to|explain\s+(?:page|pg)|on\s+page|from\s+page|of\s+page)\b/i.test(query);

  // It's a pure page lookup when:
  //   • no meaningful content terms remain after stripping page references, OR
  //   • the query contains a clear "show me page N" cue
  const pageLookupOnly = residualTerms.length === 0 || lookupCue;

  return { pages: [...pages], pageLookupOnly };
}

function isGenericReference(query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  for (const pattern of GENERIC_REFERENCE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  // Very short queries with references
  if (trimmed.length < 30 && /\b(this|that|it|these|those)\b/i.test(trimmed)) {
    const words = trimmed.split(/\s+/).filter(w => w.length > 0);
    if (words.length <= 5) return true;
  }
  return false;
}

export function rewriteQuery(query: string, context: ConversationContext): { rewritten: string; isReference: boolean } {
  const trimmed = query.trim();
  
  // Check if it's a generic reference query
  if (!isGenericReference(trimmed)) {
    return { rewritten: trimmed, isReference: false };
  }

  // Try to resolve reference from conversation context
  let rewritten = trimmed;
  
  // If we have a recent topic, use it
  if (context.lastTopic) {
    rewritten = context.lastTopic;
  }
  // If we have a recent query, use it
  else if (context.lastQuery) {
    // Extract meaningful terms from last query
    const lastTerms = distinctiveTerms(queryTerms(context.lastQuery));
    if (lastTerms.length > 0) {
      rewritten = lastTerms.join(" ");
    }
  }
  // If we have a recent section, use it
  else if (context.lastSection) {
    rewritten = context.lastSection;
  }
  
  return { 
    rewritten: rewritten !== trimmed ? rewritten : trimmed, 
    isReference: rewritten !== trimmed 
  };
}

/** Derive the user-facing intent from a classified query */
export function detectIntent(
  query: string,
  type: QueryType,
  distinctive: string[]
): QueryIntent {
  // Explicit page lookup
  if (type === "page") return "PAGE_LOOKUP";

  // Explicit summary request
  if (/\b(summar(ize|ise|y)|tldr|tl;dr|in brief|brief overview|key points|main points|overview)\b/i.test(query)) {
    return "SUMMARY";
  }

  // Document overview — generic "what is this / what does this cover"
  if (
    type === "generic_reference" ||
    type === "broad" ||
    /\b(what is this|what is this (pdf|document|file|about)|what (does|do) this (cover|contain|include|discuss)|what('s| is) this about|about this (document|pdf|file)?)\b/i.test(query)
  ) {
    return "DOCUMENT_OVERVIEW";
  }

  // Comparison
  if (type === "comparison" || /\b(compar|difference|vs\.?|versus|contrast|similar|unlike|both)\b/i.test(query)) {
    return "COMPARISON";
  }

  // Multi-part: contains "and" with multiple distinct terms
  if (distinctive.length >= 3 && /\band\b/i.test(query)) {
    return "MULTI_PART";
  }

  // Simple fact — who/when/where/how many/which
  if (/^(who|when|where|how many|how much|which)\b/i.test(query) && distinctive.length <= 2) {
    return "SIMPLE_FACT";
  }

  // Definition — "what is X", "define X", "explain X" for a single concept
  if (
    type === "concept" ||
    ((/^(what is|what are|define|meaning of|what does .* mean)\b/i.test(query)) && distinctive.length <= 3)
  ) {
    return "DEFINITION";
  }

  // Specific topic — "explain", "tell me about", "describe", "how does X work"
  if (/\b(explain|describe|tell me about|how does|how do|walk me through|teach me)\b/i.test(query)) {
    return "SPECIFIC_TOPIC";
  }

  // Fallback based on type
  if (type === "summary") return "SUMMARY";
  if (type === "factual") return "SIMPLE_FACT";
  if (type === "specific") return "SPECIFIC_TOPIC";

  return "GENERAL";
}

export function classifyQuery(query: string, context?: ConversationContext): {
  type: QueryType;
  intent: QueryIntent;
  pages: number[];
  terms: string[];
  factualField?: FactualField;
  rewrittenQuery?: string;
} {
  const { pages, pageLookupOnly } = parsePageQuery(query);
  const factualField = detectFactualField(query);

  // Page query takes highest priority — bypass all semantic/lexical paths
  if (pageLookupOnly && pages.length) {
    return { type: "page", intent: "PAGE_LOOKUP", pages, terms: [] };
  }

  // Check for generic reference and rewrite if needed
  let effectiveQuery = query;
  let isReference = false;
  if (context) {
    const { rewritten, isReference: isRef } = rewriteQuery(query, context);
    effectiveQuery = rewritten;
    isReference = isRef;
  }

  const terms = queryTerms(effectiveQuery);
  const distinctive = distinctiveTerms(terms);

  // Generic reference query (could not be resolved or successfully rewritten)
  if (isGenericReference(query) && !isReference) {
    const intent = detectIntent(query, "generic_reference", distinctive);
    return { type: "generic_reference", intent, pages, terms, rewrittenQuery: effectiveQuery };
  }

  if (isReference) {
    const intent = detectIntent(effectiveQuery, "generic_reference", distinctive);
    return { type: "generic_reference", intent, pages, terms: distinctive, rewrittenQuery: effectiveQuery };
  }

  // Summary/overview query
  if (BROAD_INTENT.test(query) || /^(summar|overview|tell me about|what is this)/i.test(query)) {
    const intent = detectIntent(query, "summary", distinctive);
    return { type: "summary", intent, pages, terms: distinctive };
  }

  // Comparison query
  if (/\b(compar|difference|versus|vs\.?|between)\b/i.test(query) && distinctive.length >= 2) {
    return { type: "comparison", intent: "COMPARISON", pages, terms: distinctive };
  }

  // Factual query (who, when, where, which, how many)
  if (/^(who|when|where|which|how many)\b/i.test(query)) {
    return { type: "factual", intent: "SIMPLE_FACT", pages, terms: distinctive, factualField };
  }

  // Contact/profile field questions should not be treated as definitions just
  // because they begin with "What is". Their source values are often URLs or
  // numbers, which semantic and literal-term search can miss.
  if (factualField) {
    return { type: "factual", intent: "SIMPLE_FACT", pages, terms: distinctive, factualField };
  }

  // Concept query (what is, define, explain a specific term)
  if (/^(what is|what are|define|explain|describe)\b/i.test(query) && distinctive.length >= 1) {
    const intent = detectIntent(query, "concept", distinctive);
    return { type: "concept", intent, pages, terms: distinctive };
  }

  // Broad query (no distinctive terms)
  if (distinctive.length === 0) {
    const intent = detectIntent(query, "broad", distinctive);
    return { type: "broad", intent, pages, terms };
  }

  // Default to specific
  const intent = detectIntent(query, "specific", distinctive);
  return { type: "specific", intent, pages, terms: distinctive };
}

export function detectFactualField(query: string): FactualField | undefined {
  const q = query.toLowerCase();
  if (/\b(phone|mobile|telephone|tel\.?|contact\s+(?:number|details?|info))\b/.test(q)) return "phone";
  if (/\b(e-?mail|email)\b/.test(q)) return "email";
  if (/\blinkedin\b/.test(q)) return "linkedin";
  if (/\bgithub\b/.test(q)) return "github";
  if (/\b(url|website|link|site)\b/.test(q)) return "url";
  if (/\b(address|location|based|city|residence)\b/.test(q)) return "address";
  if (/\b(full\s+name|name)\b/.test(q)) return "name";
  if (/\b(education|degree|university|college|school)\b/.test(q)) return "education";
  if (/\b(experience|employment|work history|career)\b/.test(q)) return "experience";
  if (/\b(account|acct|iban|swift)\b/.test(q)) return "account";
  if (/\b(date|when|timeline)\b/.test(q)) return "date";
  if (/\b(amount|price|cost|salary|pay|fee|currency|usd|eur|gbp|inr)\b/.test(q)) return "amount";
  if (/\b(id|identifier|uuid)\b/.test(q)) return "id";
}

export function lexicalScore(content: string, section: string | undefined, terms: string[]): number {
  if (!terms.length) return 0;
  const text = content.toLowerCase();
  const head = (section || "").toLowerCase();
  
  let hits = 0;
  let weighted = 0;

  for (const term of terms) {
    const termRegex = new RegExp(`\\b${term}\\b`, 'i');
    if (termRegex.test(text)) {
      hits += 1;
      weighted += 1;
    } else if (text.includes(term)) {
      hits += 0.7;
      weighted += 0.7;
    }
    
    if (termRegex.test(head)) {
      weighted += 0.4;
    } else if (head.includes(term)) {
      weighted += 0.25;
    }
  }
  
  const coverage = hits / terms.length;
  
  // Phrase matching
  let phrase = 0;
  for (let i = 0; i < terms.length - 1; i++) {
    const pair = `${terms[i]} ${terms[i + 1]}`;
    if (text.includes(pair)) phrase += 0.35;
    if (head.includes(pair)) phrase += 0.2;
  }
  
  // Multi-word phrase bonus
  if (terms.length >= 3) {
    const triple = terms.slice(0, 3).join(" ");
    if (text.includes(triple)) phrase += 0.45;
  }
  
  return Math.min(1, coverage * 0.50 + (weighted / (terms.length * 1.4)) * 0.25 + Math.min(phrase, 0.25));
}

export function phraseScore(content: string, section: string | undefined, terms: string[]): number {
  if (terms.length < 2) return 0;
  
  const text = content.toLowerCase();
  const head = (section || "").toLowerCase();
  let score = 0;
  
  // Consecutive term pairs
  for (let i = 0; i < terms.length - 1; i++) {
    const pair = `${terms[i]} ${terms[i + 1]}`;
    if (text.includes(pair)) score += 0.4;
    if (head.includes(pair)) score += 0.2;
  }
  
  // Full phrase
  if (terms.length >= 2) {
    const fullPhrase = terms.join(" ");
    if (text.includes(fullPhrase)) score += 0.6;
    if (head.includes(fullPhrase)) score += 0.3;
  }
  
  return Math.min(1, score);
}

export function metadataScore(chunk: ScoredChunk, terms: string[], pages: number[]): number {
  let score = 0;
  
  // Section matching
  if (chunk.section && terms.length) {
    const sectionLower = chunk.section.toLowerCase();
    for (const term of terms) {
      if (sectionLower.includes(term)) {
        score += 0.15;
      }
    }
  }
  
  // Page matching
  if (pages.length && chunk.pageNumber !== null && pages.includes(chunk.pageNumber)) {
    score += 0.25;
  }
  
  return Math.min(0.5, score);
}

export function hybridScore(
  cosine: number, 
  lexical: number, 
  phrase: number,
  metadata: number,
  type: QueryType
): number {
  // Adaptive weighting based on query type
  switch (type) {
    case "page":
      // Page queries rely on exact page match
      return cosine * 0.3 + lexical * 0.2 + metadata * 0.5;
      
    case "generic_reference":
    case "summary":
    case "broad":
      // Semantic similarity dominates for broad queries
      return cosine * 0.75 + lexical * 0.10 + phrase * 0.05 + metadata * 0.10;
      
    case "concept":
    case "comparison":
      // Balance between semantic and lexical for concept queries
      return cosine * 0.45 + lexical * 0.35 + phrase * 0.12 + metadata * 0.08;
      
    case "factual":
      // Lexical matching is important for factual queries
      return cosine * 0.35 + lexical * 0.45 + phrase * 0.12 + metadata * 0.08;
      
    case "specific":
    default:
      // Lexical matching gets higher weight for specific queries
      return cosine * 0.35 + lexical * 0.45 + phrase * 0.12 + metadata * 0.08;
  }
}

export function filterCandidates(chunks: ScoredChunk[], type: QueryType, terms: string[]): ScoredChunk[] {
  if (!chunks.length) return [];

  // A deterministic field match is sufficient evidence for an explicitly
  // requested profile/contact value, even when the value has no query words.
  if (chunks.some((chunk) => chunk.factualField)) {
    chunks = chunks.filter((chunk) => chunk.factualField || type === "page" || chunk.score >= MIN_HYBRID_SPECIFIC);
  }
  
  // For page queries, don't filter - return all chunks from the requested page
  if (type === "page") {
    return chunks;
  }
  
  // For generic reference queries, be very permissive
  if (type === "generic_reference") {
    return chunks.filter((chunk) => 
      chunk.cosine >= MIN_COSINE_GENERIC || chunk.score >= MIN_HYBRID_GENERIC
    );
  }
  
  // For broad/summary queries, use semantic similarity primarily
  if (type === "broad" || type === "summary") {
    return chunks.filter((chunk) => 
      chunk.cosine >= MIN_COSINE_BROAD || chunk.score >= MIN_COSINE_BROAD
    );
  }

  // For specific/concept/factual/comparison queries with distinctive terms
  if (terms.length === 0) {
    // No distinctive terms - rely on semantic similarity
    return chunks.filter((chunk) => 
      chunk.cosine >= MIN_COSINE_NO_TERMS || chunk.score >= 0.5
    );
  }

  // Check if any chunks have strong lexical matches
  const hasStrongKeyword = chunks.some((chunk) => chunk.lexical >= STRONG_LEXICAL);
  
  return chunks.filter((chunk) => {
    // Always keep chunks with strong lexical matches
    if (chunk.lexical >= STRONG_LEXICAL) return true;
    
    // Keep chunks with strong overall scores
    if (chunk.score >= MIN_HYBRID_SPECIFIC) return true;
    
    // For chunks without strong lexical matches
    if (chunk.lexical === 0) {
      // If we have strong keyword chunks elsewhere, be more strict
      if (hasStrongKeyword) {
        return chunk.cosine >= 0.58;
      }
      // Otherwise, allow semantic matches
      return chunk.cosine >= 0.45;
    }
    
    // Keep chunks with decent lexical + semantic combination
    if (chunk.cosine >= MIN_COSINE_SPECIFIC && chunk.lexical > 0) return true;
    
    // Keep high semantic similarity even with weak lexical
    if (chunk.cosine >= 0.50) return true;
    
    return false;
  });
}

/**
 * When several documents are in the same chat, score-slicing alone lets one
 * large file occupy every final slot. Take the best chunk from each document
 * first, then fill the remaining budget by score.
 */
export function diversifyByDocument(chunks: ScoredChunk[], limit: number): ScoredChunk[] {
  if (limit <= 0 || !chunks.length) return [];
  
  const picked: ScoredChunk[] = [];
  const byDoc = new Map<string, ScoredChunk[]>();
  
  for (const chunk of chunks) {
    const doc = chunk.documentHash || chunk.documentId;
    if (!doc) continue;
    if (!byDoc.has(doc)) byDoc.set(doc, []);
    byDoc.get(doc)!.push(chunk);
  }
  
  for (const list of byDoc.values()) {
    list.sort((a, b) => b.score - a.score || b.cosine - a.cosine);
  }
  
  let added = true;
  while (added && picked.length < limit) {
    added = false;
    const availableDocs = [...byDoc.keys()].filter(d => byDoc.get(d)!.length > 0);
    availableDocs.sort((a, b) => byDoc.get(b)![0].score - byDoc.get(a)![0].score);
    
    for (const doc of availableDocs) {
      if (picked.length >= limit) break;
      const chunk = byDoc.get(doc)!.shift()!;
      if (!picked.some((item) => item.documentHash === chunk.documentHash && item.chunkIndex === chunk.chunkIndex && item.text === chunk.text)) {
        picked.push(chunk);
        added = true;
      }
    }
  }
  
  return picked;
}

export function diversifyByPage(chunks: ScoredChunk[], limit: number, type: QueryType): ScoredChunk[] {
  const sorted = [...chunks].sort((a, b) => b.score - a.score || b.cosine - a.cosine);
  const picked: ScoredChunk[] = [];
  const pageCounts = new Map<number | string, number>();
  
  // Adjust diversity based on query type
  let maxPerPage: number;
  if (type === "generic_reference" || type === "summary" || type === "broad") {
    maxPerPage = 2; // More diversity for broad queries
  } else if (type === "concept" || type === "factual") {
    maxPerPage = 3; // Allow clustering for specific concepts
  } else {
    maxPerPage = 2;
  }

  const tryAdd = (chunk: ScoredChunk, cap: number) => {
    const key = chunk.pageNumber !== null ? `${chunk.documentHash}:${chunk.pageNumber}` : `${chunk.documentHash}:idx:${chunk.chunkIndex}`;
    const count = pageCounts.get(key) || 0;
    if (count >= cap) return false;
    if (picked.some((item) => item.documentHash === chunk.documentHash && item.chunkIndex === chunk.chunkIndex && item.text === chunk.text)) return false;
    picked.push(chunk);
    pageCounts.set(key, count + 1);
    return true;
  };

  // First pass: respect page limits
  for (const chunk of sorted) {
    tryAdd(chunk, maxPerPage);
    if (picked.length >= limit) return picked;
  }
  
  // Second pass: allow more per page if needed
  for (const chunk of sorted) {
    tryAdd(chunk, maxPerPage + 2);
    if (picked.length >= limit) return picked;
  }
  
  return picked;
}

/** includePage: only true for an explicit page-lookup query — otherwise the
 *  source tag omits "Page N" so the model doesn't cite page numbers the user
 *  never asked for. */
export function packContext(chunks: ScoredChunk[], maxChars = MAX_CONTEXT_CHARS, includePage = false): string {
  const selected: ScoredChunk[] = [];
  let used = 0;

  const sourceTag = (chunk: ScoredChunk) => {
    const section = chunk.section ? ` | Section: ${chunk.section}` : "";
    const page = includePage ? ` | Page ${chunk.pageNumber !== null ? chunk.pageNumber : "?"}` : "";
    return `[Source: ${chunk.fileName}${page}${section}]\n${chunk.text.trim()}`;
  };

  for (const chunk of chunks) {
    const block = sourceTag(chunk);

    if (used + block.length > maxChars && selected.length > 0) break;

    selected.push(chunk);
    used += block.length + 8; // 8 chars for the separator
  }

  const ordered = selected.sort((a, b) => {
    if (a.documentHash !== b.documentHash) return a.documentHash.localeCompare(b.documentHash);
    const pa = a.pageNumber ?? 999999;
    const pb = b.pageNumber ?? 999999;
    if (pa !== pb) return pa - pb;
    return a.chunkIndex - b.chunkIndex;
  });

  return ordered.map(sourceTag).join("\n\n---\n\n");
}

export function chunkKey(chunk: Pick<ScoredChunk, "documentHash" | "chunkIndex" | "pageNumber" | "text">) {
  return `${chunk.documentHash}:${chunk.chunkIndex}:${chunk.pageNumber}:${chunk.text.slice(0, 24)}`;
}
