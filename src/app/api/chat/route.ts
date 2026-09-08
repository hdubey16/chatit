import { NextResponse } from "next/server";
import { createHash } from "crypto";
import {
  DEFAULT_SYSTEM,
  RAG_FOUND_SYSTEM,
  RAG_MISSING_SYSTEM,
  retrieveForQuery,
  checkDocumentsReady,
  type ConversationContext,
} from "@/lib/rag";
import { INTENT_VERBOSITY_HINT, type QueryIntent } from "@/lib/rag-query";

function extractConversationContext(messages: any[]): ConversationContext {
  const context: ConversationContext = {};
  
  // Look at recent messages to extract context
  const recentMessages = messages.slice(-6); // Last 3 exchanges
  
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const msg = recentMessages[i];
    if (msg.role === "user" && msg.content) {
      const content = String(msg.content);
      
      // Extract page references
      const pageMatch = content.match(/page\s*(\d+)/i);
      if (pageMatch && !context.lastPage) {
        context.lastPage = parseInt(pageMatch[1], 10);
      }
      
      // Extract last meaningful query (skip generic ones)
      if (!context.lastQuery && content.length > 15 && !/^(what|this|that|it)\b/i.test(content)) {
        context.lastQuery = content;
      }
    }
    
    // Extract from assistant responses that included RAG context
    if (msg.role === "assistant" && msg.content) {
      const content = String(msg.content);
      
      // Try to extract mentioned sections
      const sectionMatch = content.match(/(?:section|topic|chapter):\s*([^\n\]]+)/i);
      if (sectionMatch && !context.lastSection) {
        context.lastSection = sectionMatch[1].trim();
      }
      
      // Store a snippet of retrieved context
      if (content.length > 50 && !context.lastRetrievedContext) {
        context.lastRetrievedContext = content.slice(0, 500);
      }
    }
  }
  
  return context;
}

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") || "";
    let messages: any[] = [];
    let model: string = "max";
    let temperature: number = 0.2;
    let top_p: number = 1;
    let max_tokens: number = 2000;
    let useRAG = false;
    let hashes: string[] = [];

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const payloadString = formData.get("payload") as string;
      const payload = JSON.parse(payloadString);
      
      messages = payload.messages;
      model = payload.model;
      temperature = payload.temperature ?? 0.2;
      top_p = payload.top_p ?? 1;
      max_tokens = payload.max_tokens ?? 2000;
      useRAG = payload.useRAG === true;
      hashes = payload.documentHashes || [];

      const files = formData.getAll("files") as File[];
      for (const file of files) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const hash = createHash("sha256").update(buffer).digest("hex");
        hashes.push(hash);
      }
    } else {
      const body = await req.json();
      ({ messages, model, temperature = 0.2, top_p = 1, max_tokens = 2000, useRAG = false, documentHashes: hashes = [] } = body);
    }

    // Safety truncation to avoid exceeding 32k token limit (approx 120,000 chars)
    if (messages && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === "user" && lastMsg.content && lastMsg.content.length > 100000) {
        lastMsg.content = lastMsg.content.substring(0, 100000) + "\n\n[...TEXT TRUNCATED DUE TO CONTEXT LIMIT...]\n\n";
      }
    }

    hashes = [...new Set(hashes.filter(Boolean))];

    if (useRAG && hashes.length > 0) {
      const notReadyReason = await checkDocumentsReady(hashes);
      if (notReadyReason) {
        return NextResponse.json({ error: notReadyReason }, { status: 400 });
      }
    }

    let ragSystemPrompt: string | null = null;

    // --- Retrieve from Vector Store ---
    if (useRAG && hashes.length > 0) {
      try {
        const nvidiaKey = process.env.NVIDIA_API_KEY;
        if (!nvidiaKey) {
          ragSystemPrompt = RAG_MISSING_SYSTEM;
        } else {
          const lastUserMessage = messages[messages.length - 1];
          if (lastUserMessage && lastUserMessage.role === "user") {
            let queryForEmbedding = lastUserMessage.content.trim();
            if (!queryForEmbedding) {
              queryForEmbedding = "Please summarize this document.";
              lastUserMessage.content = queryForEmbedding;
            }

            // Extract conversation context
            const conversationContext = extractConversationContext(messages);

            // retrieveForQuery has no internal time bound — its embedding
            // call retries indefinitely against transient NVIDIA API errors
            // (rate limits, 5xx). Without this race, a persistent embedding
            // outage hangs the whole chat request forever with no error and
            // no fallback, even though the LLM call below is already
            // guarded by a 60s abort. The timeout sentinel falls through to
            // RAG_MISSING_SYSTEM below so the user still gets an answer.
            const RAG_TIMEOUT = Symbol("rag-timeout");
            const retrievalResult = await Promise.race([
              retrieveForQuery({
                query: queryForEmbedding,
                hashes,
                apiKey: nvidiaKey,
                conversationContext,
              }),
              new Promise<typeof RAG_TIMEOUT>((resolve) =>
                setTimeout(() => resolve(RAG_TIMEOUT), 45000),
              ),
            ]);

            if (retrievalResult === RAG_TIMEOUT) {
              console.error("[rag] retrieval timed out after 45s — answering without document context");
            }
            const retrieval = retrievalResult === RAG_TIMEOUT
              ? { context: "", relevant: false, pageLookup: false, queryType: "none" as const, intent: "GENERAL" as const, usedChunks: 0, consideredHashes: hashes, chunks: [] }
              : retrievalResult;

            const retrievedFiles = [...new Set((retrieval.chunks || []).map((c) => c.fileName).filter(Boolean))];
            console.log(`[rag] sessionDocuments=${hashes.length} retrievedDocuments=${retrieval.chunks ? new Set(retrieval.chunks.map((c) => c.documentHash)).size : 0} files=${retrievedFiles.join(" | ")}`);

            // ── Log line ──────────────────────────────────────────────────
            if (retrieval.pageLookup) {
              console.log(`[rag] pageLookup=true pageNumber=${retrieval.pageNumber ?? "?"} pageChunks=${retrieval.usedChunks} emptyPage=${retrieval.emptyPage ?? false}`);
            } else {
              console.log(`[rag] intent=${retrieval.intent} queryType=${retrieval.queryType} relevant=${retrieval.relevant} chunks=${retrieval.usedChunks}${retrieval.rewrittenQuery ? ` rewritten="${retrieval.rewrittenQuery}"` : ""}${retrieval.extractedTopic ? ` topic="${retrieval.extractedTopic}"` : ""}`);
            }

            if (retrieval.relevant) {
              ragSystemPrompt = RAG_FOUND_SYSTEM;

              // ── PAGE LOOKUP — three sub-cases ────────────────────────────
              if (retrieval.pageLookup) {
                const pn = retrieval.pageNumber ?? "?";

                if (retrieval.emptyPage) {
                  // Page exists in document range but no text was indexed
                  lastUserMessage.content =
                    `The user asked about page ${pn} of the document.\n\n` +
                    `Page ${pn} was found in the document but no readable text could be extracted from it. ` +
                    `It is likely an image, scanned page, diagram, or blank page.\n\n` +
                    `Tell the user: "Page ${pn} exists in the document, but no readable text was found on it — it may be image-only or scanned." ` +
                    `Do not invent content.`;
                } else if (retrieval.context.startsWith("[PAGE_OUT_OF_RANGE:")) {
                  // Page number exceeds document length
                  lastUserMessage.content =
                    `The user asked about page ${pn} of the document.\n\n` +
                    `Page ${pn} does not exist — it is beyond the total number of pages in this document.\n\n` +
                    `Tell the user: "Page ${pn} doesn't exist in this document." ` +
                    `Do not invent content.`;
                } else {
                  // Normal page lookup — structured context block per spec §12
                  // Extract fileName from the first scored chunk (packed into context header)
                  const fileNameMatch = retrieval.context.match(/\[Source:\s*([^\]|]+)/);
                  const fileName = fileNameMatch ? fileNameMatch[1].trim() : "document";
                  const verbosityHint = INTENT_VERBOSITY_HINT["PAGE_LOOKUP"];

                  lastUserMessage.content =
                    `[DOCUMENT: ${fileName}]\n` +
                    `[PAGE: ${pn}]\n\n` +
                    `${retrieval.context}\n\n` +
                    `Question: ${queryForEmbedding}\n\n` +
                    `(${verbosityHint} Answer only from the content of page ${pn} shown above. ` +
                    `Mention the page number naturally once. Do not use content from other pages.)`;
                }

              // ── NORMAL SEMANTIC RETRIEVAL ─────────────────────────────────
              } else {
                const effectiveQuestion = retrieval.rewrittenQuery || queryForEmbedding;
                const verbosityHint = INTENT_VERBOSITY_HINT[retrieval.intent as QueryIntent] ?? "Be concise.";

                lastUserMessage.content =
                  (hashes.length > 1
                    ? `Relevant content from ${hashes.length} uploaded documents. Use every source; do not assume the first file is the topic of the question.\n\n`
                    : `Relevant document content:\n\n`) +
                  `${retrieval.context}\n\n` +
                  `Question: ${effectiveQuestion}\n\n` +
                  `(${verbosityHint})`;
              }

            } else {
              ragSystemPrompt = RAG_MISSING_SYSTEM;
            }
          }
        }
      } catch (e) {
        console.error("Vector retrieval failed:", e);
        ragSystemPrompt = RAG_MISSING_SYSTEM;
      }
    }
    // ----------------------------------

    // Use environment variable for Sarvam API Key
    const apiKey = process.env.SARVAM_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "SARVAM_API_KEY is not set in environment variables." },
        { status: 500 }
      );
    }

    let sarvamModel = "sarvam-105b-conversations";
    if (model === "pro" || model === "flash") {
      sarvamModel = "sarvam-105b-conversations";
    }

    // Safety Barrier removed: Nemotron Content Safety was falsely flagging PII queries (e.g. phone numbers) 
    // and breaking the SSE stream by returning raw JSON. Valid RAG queries should be handled by the LLM.

    const sanitizedMessages = messages.map((m: any) => ({
      role: m.role,
      content: m.content?.trim() || "Please summarize this document."
    }));

    const payload = {
      model: sarvamModel,
      messages: [
        {
          role: "system",
          content: ragSystemPrompt || DEFAULT_SYSTEM
        },
        ...sanitizedMessages
      ],
      temperature,
      top_p,
      max_tokens,
      stream: true,
    };

    let response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

      response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Sarvam API Error:", response.status, errorText);
        return NextResponse.json(
          { error: `Sarvam API error: ${response.statusText}`, details: errorText },
          { status: response.status }
        );
      }
    } catch (e: any) {
      if (e.name === "AbortError") {
        console.error("Sarvam API timeout");
        return NextResponse.json({ error: "LLM request timed out." }, { status: 504 });
      }
      throw e;
    }

    // Stream the Sarvam response directly to the client
    const stream = new ReadableStream({
      async start(controller) {
        if (!response.body) {
          controller.close();
          return;
        }
        
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
            if (line.trim() === "" || !line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") {
              continue;
            }
            try {
              const parsed = JSON.parse(dataStr);
              const text = parsed.choices?.[0]?.delta?.content;
              if (text) {
                // Forward the text as a simple SSE event
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ text })}\n\n`));
              }
            } catch (e) {
              console.error("Error parsing streaming chunk:", e, dataStr);
            }
          }
        }
        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no"
      }
    });
  } catch (error: any) {
    console.error("Server Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error", details: error.message },
      { status: 500 }
    );
  }
}
