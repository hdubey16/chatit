# RAG Pipeline Developer Guide

## Quick Reference

### Query Type Classification

The system now automatically classifies queries into these types:

| Query Type | Example | Retrieval Strategy |
|------------|---------|-------------------|
| `page` | "What is on page 558?" | Direct page lookup |
| `generic_reference` | "What is this?" | Rewrite from context + broad retrieval |
| `concept` | "What is partitioning clustering?" | Balanced semantic + lexical |
| `factual` | "Who is the author?" | Lexical-heavy |
| `summary` | "Summarize this document" | Semantic-heavy, diverse pages |
| `comparison` | "Compare K-means and Q-learning" | Balanced with multi-term matching |
| `broad` | "What topics are covered?" | Semantic-heavy, diverse pages |
| `specific` | Default for specific questions | Balanced with neighbor expansion |

### Scoring Weights by Query Type

```typescript
// Page queries
30% semantic + 20% lexical + 50% metadata

// Generic reference / Summary / Broad
75% semantic + 10% lexical + 5% phrase + 10% metadata

// Concept / Comparison
45% semantic + 35% lexical + 12% phrase + 8% metadata

// Factual / Specific
35% semantic + 45% lexical + 12% phrase + 8% metadata
```

### Threshold Values

```typescript
// Minimum cosine similarity thresholds
MIN_COSINE_BROAD = 0.10
MIN_COSINE_SPECIFIC = 0.18
MIN_COSINE_GENERIC = 0.08
MIN_COSINE_NO_TERMS = 0.45

// Hybrid score thresholds
MIN_HYBRID_SPECIFIC = 0.22
MIN_HYBRID_GENERIC = 0.12

// Strong lexical match
STRONG_LEXICAL = 0.48
```

### Retrieval Pipeline Flow

```
1. Query Classification
   ↓
2. Query Rewriting (if generic reference)
   ↓
3. Query Embedding (NVIDIA)
   ↓
4. Parallel Retrieval:
   - Vector Search (MongoDB Atlas)
   - Lexical Search (if terms present)
   - Overview Anchors (if broad query)
   ↓
5. Merge & Score Candidates
   ↓
6. Filter by Query Type
   ↓
7. Rank & Diversify
   ↓
8. Neighbor Expansion (if specific query)
   ↓
9. Pack Context
   ↓
10. Return to Sarvam AI
```

## Conversation Context

The system tracks:

```typescript
{
  lastQuery?: string;        // Previous meaningful query
  lastRetrievedContext?: string; // Snippet of last response
  lastPage?: number;         // Last mentioned page
  lastSection?: string;      // Last discussed section
  lastTopic?: string;        // Extracted topic
}
```

### How It Works

1. **Extraction**: Parse last 6 messages (3 exchanges)
2. **Resolution**: Generic references use context
3. **Caching**: In-memory (production: use Redis)

### Example

```javascript
// First query
User: "What is partitioning clustering?"
→ Context: { lastQuery: "What is partitioning clustering?", lastTopic: "partitioning clustering" }

// Follow-up query
User: "What about this?"
→ Rewritten to: "partitioning clustering"
→ Context: Updated with new topic if extracted
```

## MongoDB Schema

### Vectors Collection (`deepdoc.vectors`)

```javascript
{
  _id: "hash:chunkIndex",
  documentId: "hash",
  documentHash: "hash",
  hash: "hash",
  fileName: "document.pdf",
  pageNumber: 140,
  chunkIndex: 123,
  section: "Partitioning Clustering",
  text: "chunk content...",
  content: "chunk content...",
  embedding: [0.123, -0.456, ...], // 2048 dimensions
  contentHash: "sha256",
  embeddingModel: "nvidia/nemotron-3-embed-1b",
  embeddingDimensions: 2048,
  metadata: {
    documentId: "hash",
    documentHash: "hash",
    fileName: "document.pdf",
    chunkIndex: 123,
    section: "Partitioning Clustering",
    loc: { pageNumber: 140 }
  }
}
```

### Manifests Collection (`deepdoc.manifests`)

```javascript
{
  _id: "hash",
  documentHash: "hash",
  hash: "hash",
  fileName: "document.pdf",
  status: "ready", // "indexing" | "ready" | "error"
  totalChunks: 450,
  totalPages: 100,
  indexedChunks: 450,
  embeddingModel: "nvidia/nemotron-3-embed-1b",
  embeddingDimensions: 2048,
  updatedAt: ISODate("2026-09-04T...")
}
```

### Vector Search Index

```javascript
{
  name: "vector_index",
  type: "vectorSearch",
  definition: {
    fields: [
      {
        type: "vector",
        path: "embedding",
        numDimensions: 2048,
        similarity: "cosine"
      },
      { type: "filter", path: "documentHash" },
      { type: "filter", path: "hash" },
      { type: "filter", path: "pageNumber" }
    ]
  }
}
```

## API Integration

### NVIDIA Embeddings

```bash
curl -X POST https://integrate.api.nvidia.com/v1/embeddings \
  -H "Authorization: Bearer $NVIDIA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/nemotron-3-embed-1b",
    "input": ["text to embed"],
    "encoding_format": "float",
    "input_type": "query",
    "truncate": "NONE"
  }'
```

**Response**: 2048-dimensional vector

**Rate Limits**: Handled with exponential backoff + Retry-After

### MongoDB Atlas Vector Search

```javascript
collection.aggregate([
  {
    $vectorSearch: {
      index: "vector_index",
      path: "embedding",
      queryVector: [0.123, -0.456, ...],
      numCandidates: 100,
      limit: 50,
      filter: {
        $or: [
          { documentHash: { $in: ["hash1", "hash2"] } },
          { hash: { $in: ["hash1", "hash2"] } }
        ]
      }
    }
  },
  {
    $project: {
      text: 1,
      section: 1,
      pageNumber: 1,
      chunkIndex: 1,
      score: { $meta: "vectorSearchScore" }
    }
  }
])
```

### Sarvam AI Generation

```bash
curl -X POST https://api.sarvam.ai/v1/chat/completions \
  -H "api-subscription-key: $SARVAM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sarvam-105b-conversations",
    "messages": [...],
    "stream": true
  }'
```

## Tuning Parameters

### Retrieval Candidates

```typescript
// src/lib/rag.ts

// Lexical search limit
CANDIDATE_LIMIT = 50

// Vector search candidates
VECTOR_NUM_CANDIDATES = 100      // Specific queries
BROAD_VECTOR_CANDIDATES = 200    // Broad queries

// Vector search results
CANDIDATE_LIMIT = 50              // Specific queries
BROAD_VECTOR_LIMIT = 60          // Broad queries

// Neighbor expansion
NEIGHBOR_RADIUS = 2              // ±2 chunks
```

### Final Limits

```typescript
// src/lib/rag-query.ts

FINAL_CHUNK_LIMIT_SPECIFIC = 10   // Specific queries
FINAL_CHUNK_LIMIT_BROAD = 14      // Broad queries
FINAL_CHUNK_LIMIT_GENERIC = 12    // Generic references

MAX_CONTEXT_CHARS = 14_000        // ~3,500 tokens
```

### Chunking

```typescript
// src/app/api/upload/route.ts

chunkSize: 1000
chunkOverlap: 200
```

## Debugging

### Enable Detailed Logging

The system logs at key points:

```javascript
// Query classification
console.log(`[rag] Query type: ${queryType}, Terms: [${terms.join(", ")}]`)

// Candidate counts
console.log(`[rag] Vector search returned ${vectorRows.length} candidates`)
console.log(`[rag] Lexical search returned ${lexicalRows.length} candidates`)
console.log(`[rag] Total unique candidates: ${byKey.size}`)
console.log(`[rag] After filtering: ${filtered.length} candidates`)

// Final result
console.log(`[rag] Final ranked chunks: ${ranked.length}`)
```

### Inspect Retrieved Context

Check the console logs in the chat API:

```javascript
console.log(`[rag] hashes=${hashes.length} type=${retrieval.queryType} relevant=${retrieval.relevant} chunks=${retrieval.usedChunks}`)
```

### Test Queries

**Good test queries:**

1. Page lookup: `"What is on page 558?"`
2. Generic reference: `"What is this?"` (after a previous query)
3. Concept: `"What is partitioning clustering?"`
4. Broad: `"Summarize this document"`
5. Comparison: `"Compare K-means and hierarchical clustering"`

**Expected behaviors:**

- Page queries → Direct page retrieval
- Generic references → Rewritten from context
- Concept queries → Balanced semantic + lexical
- Broad queries → Semantic-heavy + diverse pages

## Common Issues & Solutions

### Issue: "Information not found" for valid questions

**Cause**: Thresholds too strict or lexical gate too aggressive

**Solution**: Already fixed - check query type and verify filtering logic

### Issue: Wrong pages retrieved

**Cause**: Vector search confusion or missing page metadata

**Solution**: Verify `pageNumber` field in MongoDB, check vector search filter

### Issue: Generic references fail

**Cause**: No conversation context or rewriting disabled

**Solution**: Ensure `extractConversationContext()` is called in chat API

### Issue: Slow retrieval

**Cause**: Too many vector candidates or MongoDB Atlas index not ready

**Solution**: 
1. Verify vector search index exists: `collection.listSearchIndexes()`
2. Reduce `VECTOR_NUM_CANDIDATES` if needed
3. Check MongoDB Atlas cluster performance

### Issue: Embedding failures

**Cause**: NVIDIA API rate limits or network issues

**Solution**: Already handled with retry logic - check API key and quota

## Performance Tuning

### Reduce Latency

1. **Lower candidate counts**: Reduce `VECTOR_NUM_CANDIDATES` to 50-80
2. **Skip lexical search**: For broad queries (already optimized)
3. **Reduce neighbor radius**: Change `NEIGHBOR_RADIUS` to 1
4. **Smaller final limits**: Reduce `FINAL_CHUNK_LIMIT_*` values

### Improve Quality

1. **Increase candidate counts**: Raise `VECTOR_NUM_CANDIDATES` to 150-200
2. **Expand neighbors**: Increase `NEIGHBOR_RADIUS` to 3
3. **Larger final limits**: Increase `FINAL_CHUNK_LIMIT_*` values
4. **Lower thresholds**: Reduce `MIN_COSINE_*` values

### Balance Both

The current configuration is already balanced for production use.

## Testing

### Unit Tests (Recommended)

```typescript
// Test query classification
import { classifyQuery } from '@/lib/rag-query';

test('page query detection', () => {
  const result = classifyQuery("What is on page 558?");
  expect(result.type).toBe("page");
  expect(result.pages).toContain(558);
});

test('generic reference detection', () => {
  const result = classifyQuery("What is this?");
  expect(result.type).toBe("generic_reference");
});

// Test query rewriting
import { rewriteQuery } from '@/lib/rag-query';

test('generic reference rewriting', () => {
  const context = { lastTopic: "partitioning clustering" };
  const result = rewriteQuery("What about this?", context);
  expect(result.rewritten).toBe("partitioning clustering");
  expect(result.isReference).toBe(true);
});
```

### Integration Tests (Recommended)

Test the full retrieval pipeline with known documents and queries.

## Maintenance

### Monitor These Metrics

1. **Retrieval latency**: Should be <2 seconds typically
2. **Relevance rate**: % of queries returning relevant context (target: >85%)
3. **Generic reference resolution rate**: % successfully rewritten (target: >90%)
4. **MongoDB Atlas index health**: Check Atlas dashboard
5. **NVIDIA API quota usage**: Monitor daily quota
6. **Conversation cache size**: In-memory (clear periodically)

### Regular Tasks

1. **Weekly**: Review logs for retrieval failures
2. **Monthly**: Analyze query patterns and adjust thresholds
3. **Quarterly**: Re-evaluate embedding model and scoring weights
4. **As needed**: Clear conversation cache (restart service)

## Support

For issues or questions about the RAG pipeline:

1. Check logs for `[rag]` prefixed messages
2. Verify MongoDB Atlas index status
3. Test with known good queries
4. Review `RAG_PRODUCTION_FIX_SUMMARY.md` for architecture details

## References

- MongoDB Atlas Vector Search: https://www.mongodb.com/docs/atlas/atlas-vector-search/
- NVIDIA NIM Embeddings: https://build.nvidia.com/explore/discover
- Sarvam AI: https://www.sarvam.ai/
- pdf-oxide: https://github.com/simlay/pdf-oxide
- LangChain Text Splitters: https://js.langchain.com/docs/modules/data_connection/document_transformers/
