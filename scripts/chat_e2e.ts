// End-to-end test: hit /api/chat with the originally-failing query
// against the case that has the four uploaded test docs. Streams the
// model response to stdout.

const CASE_ID = "ea68b684-8f5b-4afa-b4e1-684b48b27707";
const QUERY = "I received a rejection where the examiner cites US 9,123,456 alone for §102 and alternatively combines US 9,123,456 with US 8,765,432 under §103. Break down which claim elements are fully anticipated vs only partially disclosed. Then explain whether this is a proper §102 rejection or should be §103 instead.";

async function main() {
  const res = await fetch("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      caseId: CASE_ID,
      messages: [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: QUERY }],
        },
      ],
    }),
  });
  if (!res.ok || !res.body) {
    console.error("HTTP", res.status, await res.text());
    process.exit(1);
  }

  // Drain the SSE stream and pluck text deltas.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by blank lines; each `data:` line is JSON.
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          if (typeof obj.delta === "string") process.stdout.write(obj.delta);
          else if (obj.type === "text-delta" && obj.delta) process.stdout.write(obj.delta);
        } catch {
          // ignore frames we don't understand (start/end markers)
        }
      }
    }
  }
  process.stdout.write("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
