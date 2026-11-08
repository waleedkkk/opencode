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
  // 1) changelog in English
  const rc = await fetch("https://ai.google.dev/gemini-api/docs/changelog?hl=en", { headers: H, signal: AbortSignal.timeout(30000) });
  const t = clean(await rc.text());
  const re = /(\d{4}-\d{2}-\d{2})/g;
  let m;
  const seen = new Set();
  console.log("===== CHANGELOG (Sep+ Oct 2026) =====");
  while ((m = re.exec(t))) {
    if (m[1] < "2026-09-01") continue;
    if (seen.has(m[1] + Math.floor(m.index))) continue;
    seen.add(m[1] + Math.floor(m.index));
    console.log("•", t.slice(m.index, m.index + 320).slice(0, 320));
    console.log("-");
  }

  // 2) context around key new ids on models page
  const rm = await fetch("https://ai.google.dev/gemini-api/docs/models?hl=en", { headers: H, signal: AbortSignal.timeout(30000) });
  const html = await rm.text();
  console.log("\n===== CONTEXT gemini-4-argon =====");
  for (const needle of ["gemini-4-argon", "gemini-4", "gemini-3.1-pro-preview", "nano-banana-2.1", "gemini-3-pro-image"]) {
    let idx = html.indexOf(needle);
    let n = 0;
    while (idx >= 0 && n < 2) {
      const ctx = clean(html.slice(Math.max(0, idx - 200), idx + 500));
      console.log("[" + needle + "] …" + ctx.slice(0, 560) + "…\n");
      idx = html.indexOf(needle, idx + 1);
      n++;
    }
  }
})().catch((e) => console.log("ERR", e.message));
