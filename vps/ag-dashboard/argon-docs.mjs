const H = { "User-Agent": "Mozilla/5.0" };
const clean = (h) =>
  h
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/\s+/g, " ");

(async () => {
  const r = await fetch("https://ai.google.dev/gemini-api/docs/models/gemini-4-argon?hl=en", { headers: H, signal: AbortSignal.timeout(30000) });
  const t = clean(await r.text());
  const i = t.indexOf("flagship reasoning model");
  console.log(t.slice(i - 60, i + 2600));
})().catch((e) => console.log("ERR", e.message));
