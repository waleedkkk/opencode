const CID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CS = (process.env.ANTIGRAVITY_CLIENT_SECRET || "");
const H = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform: "LINUX_AMD64", pluginType: "GEMINI" }),
};

(async () => {
  const store = JSON.parse((await (await import("node:fs")).promises.readFile("/root/.config/opencode/antigravity-accounts.json", "utf8")));
  const acc = store.accounts.find((x) => x.email === "walleed372@gmail.com");
  console.log("walleed372 rateLimitResetTimes:", JSON.stringify(acc.rateLimitResetTimes || {}).slice(0, 300));
  const j = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: acc.refreshToken.split("|")[0], client_id: CID, client_secret: CS }),
  }).then((r) => r.json());

  const models = ["gemini-2.5-flash", "gemini-3-flash", "gemini-3.8-flash-tiered", "gemini-4-argon"];
  for (const model of models) {
    for (const withProj of [true, false]) {
      try {
        const g = await fetch("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", {
          method: "POST",
          headers: {
            ...H,
            Authorization: "Bearer " + j.access_token,
            ...(withProj ? { "x-goog-user-project": acc.projectId || "aicode-consumers" } : {}),
          },
          body: JSON.stringify({
            model,
            request: { model, contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1, temperature: 0 } },
          }),
          signal: AbortSignal.timeout(30000),
        });
        const t = (await g.text()).replace(/\s+/g, " ");
        let note = "";
        if (!g.ok) {
          try { const e = JSON.parse(t); note = (e.error.details && e.error.details[0] && e.error.details[0].reason) || e.error.message || ""; } catch (_) { note = t.slice(0, 70); }
        } else note = "✅";
        console.log(model.padEnd(22), withProj ? "[proj] " : "[no-proj]", "→", g.status, g.ok ? "✅" : "❌", String(note).slice(0, 60));
      } catch (e) { console.log(model.padEnd(22), "EXC", e.message.slice(0, 60)); }
      await new Promise((r) => setTimeout(r, 900));
    }
  }
})().catch((e) => console.log("ERR", e.message));
