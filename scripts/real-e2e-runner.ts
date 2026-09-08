const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

const DOCS = [
  {
    name: "Loan_Notice.txt",
    content: "Loan Account Number: 8492-331-55. The insurance settlement amount is $55,400.25. The claim date is Oct 12, 2024. The policy holder is Alice Jenkins. This notice confirms the financial transactions. Sent by grievance department."
  },
  {
    name: "Certificate.txt",
    content: "Certificate of Completion for Data Science Basics. Notes: The course covers clustering and partitioning. This document certifies completion."
  },
  {
    name: "Himanshu_Resume.txt",
    content: "Himanshu's Resume. Email: himanshu@example.com. Phone: +1-555-0198. Projects: Worked on Echo-s.ai using Next.js, MongoDB, and TypeScript. Also worked on Graphify for knowledge graphs. Technologies used: Next.js, MongoDB."
  }
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(BASE_URL + "/");
      if (res.ok) return true;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Server did not start");
}

async function uploadFile(doc: typeof DOCS[0]) {
  const form = new FormData();
  form.append("files", new File([doc.content], doc.name, { type: "text/plain" }));
  
  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: "POST",
    body: form
  });
  
  if (!res.ok) throw new Error("Upload failed: " + await res.text());
  
  // Parse the SSE stream to wait for "done"
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let hash = "";
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const dataStr = line.slice(6).trim();
        if (dataStr && dataStr !== "[DONE]") {
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.type === "done") {
              hash = parsed.hash;
              reader.cancel();
              return hash;
            }
            if (parsed.type === "error") {
              throw new Error("Indexing failed: " + parsed.error);
            }
          } catch {}
        }
      }
    }
  }
  return hash;
}

async function chat(query: string, hashes: string[]) {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: query }],
      useRAG: true,
      documentHashes: hashes
    })
  });

  if (!res.ok) {
    return { error: true, status: res.status, err: await res.text() };
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const dataStr = line.slice(6).trim();
        if (dataStr && dataStr !== "[DONE]") {
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.text) fullText += parsed.text;
          } catch {}
        }
      }
    }
  }
  return { error: false, text: fullText };
}

async function runTests(orderName: string, order: number[]) {
  console.log(`\n=== Running Order: ${orderName} ===`);
  const hashes = [];
  
  for (const idx of order) {
    const doc = DOCS[idx];
    console.log(`Uploading ${doc.name}...`);
    const hash = await uploadFile(doc);
    console.log(` -> Indexed as ${hash}`);
    hashes.push(hash);
  }

  // The chat API expects the full context list. 
  // We don't sort the hashes array, keeping it in upload order.
  
  const matrix = [
    { name: "A. Who is this document about?", query: "Who is this document about?", check: (t: string) => /Alice|Himanshu/i.test(t) },
    { name: "B. Projects worked on?", query: "What projects has Himanshu worked on?", check: (t: string) => /Echo-s\.ai/i.test(t) },
    { name: "C. Insurance settlement amount?", query: "What is the insurance settlement amount?", check: (t: string) => /55,400/.test(t) },
    { name: "D. Cross-document topics?", query: "What are the main topics across the uploaded documents?", check: (t: string) => /loan|insurance/i.test(t) && /resume/i.test(t) },
    { name: "E. Negative: Passport number?", query: "What is Himanshu's passport number?", check: (t: string) => /couldn't find|not found|does not contain/i.test(t) }
  ];

  let passCount = 0;
  for (const test of matrix) {
    const res = await chat(test.query, hashes);
    if (res.error) {
      console.log(`[FAIL] ${test.name} -> HTTP ${res.status} ${res.err}`);
    } else {
      const text = res.text ?? "";
      const pass = test.check(text);
      console.log(`[${pass ? "PASS" : "FAIL"}] ${test.name} -> ${text.replace(/\n/g, " ")}`);
      if (pass) passCount++;
    }
  }
  return passCount === matrix.length;
}

async function main() {
  console.log("Using existing Next.js server on port 3000...");
  
  try {
    await waitForServer();
    console.log("Server is up!");

    // Test matrix combinations
    const o1 = await runTests("A -> B -> C", [0, 1, 2]);
    const o2 = await runTests("C -> B -> A", [2, 1, 0]);
    const o3 = await runTests("B -> C -> A", [1, 2, 0]);

    console.log(`\nFinal result: ${o1 && o2 && o3 ? "ALL PASSED" : "SOME FAILED"}`);
  } finally {
    process.exit(0);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
