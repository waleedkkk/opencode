(async () => {
  const r = await fetch("https://ai.google.dev/gemini-api/docs/changelog", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30000),
  });
  const html = await r.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/\s+/g, " ");
  const re = /\d{4}-\d{2}-\d{2}/g;
  let m;
  const seen = new Set();
  const items = [];
  while ((m = re.exec(text))) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    items.push(m[0] + " :: " + text.slice(m.index, m.index + 400));
  }
  console.log(items.slice(0, 15).join("\n\n---\n\n"));
})().catch((e) => console.log("ERR", e.message));
