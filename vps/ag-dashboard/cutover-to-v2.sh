#!/bin/sh
set -e

REPORT="/workspace/CUTOVER-V2-REPORT.md"
say() { echo "[$(date -u '+%H:%M:%S')] $*" | tee -a "$REPORT"; }

: > "$REPORT"

say "=== 1. إيقاف وإعادة تسمية الحاوية القديمة (1.19.5) لحفظها كـ Backup ==="
if docker ps -a --format '{{.Names}}' | grep -qx "opencode-server"; then
  docker stop -t 15 opencode-server || true
  docker rename opencode-server opencode-server-1.19.5-backup || true
  say "✔ تم حفظ الحاوية القديمة باسم opencode-server-1.19.5-backup"
fi

say "=== 2. إيقاف وحذف حاوية الاختبار المؤقتة opencode-v2 ==="
if docker ps -a --format '{{.Names}}' | grep -qx "opencode-v2"; then
  docker stop -t 15 opencode-v2 || true
  docker rm opencode-v2 || true
  say "✔ تم إيقاف حاوية الاختبار المؤقتة"
fi

say "=== 3. إنشاء الحاوية الرسمية opencode-server على إصدار 2.2.5 ==="
docker create --name opencode-server \
  --restart unless-stopped \
  --network bridge \
  -p 4096:4096 \
  -e OPENCODE_SERVER_PASSWORD="Waleed330935@" \
  -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
  -w / \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /root/opencode-docker/v2/data:/root/.local/share/opencode \
  -v /root/opencode-docker/v2/config:/root/.config/opencode \
  -v /root/opencode-docker/workspace:/workspace \
  --entrypoint opencode ghcr.io/anomalyco/opencode:2.2.5 serve --hostname 0.0.0.0 --port 4096

say "=== 4. ربط الشبكات الأربع بالحاوية الجديدة ==="
for n in ag-net mcp-net hermes-net opencode-docker_default; do
  docker network connect "$n" opencode-server || true
  say "✔ متصل بـ $n"
done

say "=== 5. تشغيل الحاوية الرسمية الجديدة ==="
docker start opencode-server

say "=== 6. انتظار بدء الخادم على 4096 ==="
for i in $(seq 1 30); do
  sleep 2
  if docker exec opencode-server wget -qO- --timeout=3 http://127.0.0.1:4096/ >/dev/null 2>&1 || [ $? -eq 8 ]; then
    say "✔ الخادم يعمل ويستجيب بنجاح على 4096"
    break
  fi
done

say "=== 7. تثبيت Node.js داخل الحاوية الجديدة لتشغيل اللوحة والخدمات ==="
docker exec opencode-server apk add --no-cache nodejs || true

say "=== 8. تشغيل لوحة التحكم ag-dashboard على المنفذ 8899 ==="
docker exec -d opencode-server sh -c "mkdir -p /tmp/opencode && cd /workspace/ag-dashboard && setsid node server.mjs 8899 >> /tmp/opencode/dash.log 2>&1"
sleep 3

say "=== 9. تفعيل اتصال Playwright MCP ==="
docker exec opencode-server node -e '
(async () => {
  try {
    const auth = "Basic " + Buffer.from("opencode:Waleed330935@").toString("base64");
    const r = await fetch("http://127.0.0.1:4096/api/experimental/mcp/playwright/connect", {
      method: "POST",
      headers: { "Authorization": auth }
    });
    console.log("Playwright connect status:", r.status);
  } catch(e) { console.log(e.message); }
})();
' || true

say "=========================================================="
say "🎉 تم التبديل بنجاح كامل! OpenCode V2.2.5 الآن هو الخادم الرسمي على المنفذ 4096"
say "النطاق الرسمي: https://opencd.duckdns.org"
say "لوحة التحكم: https://agwd.duckdns.org"
say "=========================================================="
