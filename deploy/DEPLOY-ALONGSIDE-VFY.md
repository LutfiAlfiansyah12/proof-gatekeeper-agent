# Runbook (DARI NOL): Proof Gatekeeper di VPS yang sudah ada VFY-nya

Semua sebagai `root`, dijalankan lewat SSH. Setiap perintah aman dijalankan
ulang (idempotent). VFY yang sudah jalan **tidak disentuh sama sekali** —
satu-satunya perubahan pada VFY adalah SATU blok route di Caddyfile-nya
(opsi A) yang di-apply dengan hot-reload tanpa memutus koneksi.

```
VPS (Ubuntu, root)
├── [Docker — milik VFY, TIDAK DISENTUH]
│   ├── caddy (VFY)  ← pemilik :80/:443, pintu TLS satu-satunya
│   │     ├── route VFY lama → agent:3000        (tidak disentuh)
│   │     └── /gatekeeper/* → <gw-ip>:8081       (DITAMBAHKAN — langkah 6)
│   └── agent (VFY, :3000 internal)              (tidak disentuh)
└── gatekeeper (systemd, :8081)                  ← yang kita pasang (langkah 3-4)
```

## ⛔ 4 LARANGAN (pelanggaran = VFY putus)

1. Jangan `systemctl start/enable caddy` di HOST
2. Jangan `docker restart/down/up/stop` apapun
3. Jangan edit docker-compose.yml / image / env VFY
4. Jangan ubah baris lama di Caddyfile VFY — hanya TAMBAH satu blok

---

## Langkah 1 — SSH masuk (dari PowerShell laptop)

```powershell
ssh root@16.179.122.5
```

(Semua langkah berikutnya di dalam VPS, prompt `root@ip-...:~#`.)

## Langkah 2 — Install dependensi (aman diulang)

```bash
apt-get update
apt-get install -y curl git

# Node.js 22 (kalau `node -v` sudah >= 22, blok ini boleh dilewati)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

node -v    # harus >= 22
```

## Langkah 3 — Clone + build gatekeeper

```bash
cd /root
[ -d zkverify ] || git clone https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent.git zkverify
cd /root/zkverify
git pull
npm ci
npm run build
```

## Langkah 4 — .env gatekeeper

```bash
cd /root/zkverify
[ -f .env ] || cp .env.example .env
chmod 600 .env
nano /root/zkverify/.env
```

Pastikan nilai-nilai ini:

```ini
AGENT_GAMES_HMAC_SECRET=string-random-apa-saja-dulu
KURIER_API_KEY=
HOST=0.0.0.0
PORT=8081
AGENT_PATH=/agent
LOG_LEVEL=info
APPROVAL_REQUIRE_FINALIZED=false
```

> `HOST=0.0.0.0` itu wajib di setup ini: traffic dari container docker Caddy
> milik VFY masuk lewat bridge interface, bukan loopback. Tetap tidak bisa
> diakses internet karena AWS SG hanya membuka 22/80/443.
> Secret asli diisi di langkah 10 (Rotate Secret).

## Langkah 5 — Service systemd + verifikasi lokal

```bash
cp /root/zkverify/deploy/gatekeeper.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gatekeeper

systemctl is-active gatekeeper          # → active
curl -s http://127.0.0.1:8081/health    # → {"ok":true}
```

## Langkah 6 — Pasang route di Caddy milik VFY (satu-satunya sentuhan ke VFY)

**6a. Cari Caddyfile VFY + IP gateway docker:**

```bash
find /root/steal-the-vfy-agent -name "Caddyfile" -not -path "*/node_modules/*"

docker network inspect "$(
  docker inspect steal-the-vfy-agent-caddy-1 \
    --format '{{range $k,$_ := .NetworkSettings.Networks}}{{$k}}{{end}}'
)" --format '{{(index .IPAM.Config 0).Gateway}}'
```

Catat: **path Caddyfile** (mis. `/root/steal-the-vfy-agent/caddy/Caddyfile`)
dan **IP gateway** (mis. `172.18.0.1`).

**6b. Edit Caddyfile-nya:**

```bash
nano <path-Caddyfile>
```

Di **dalam blok site** yang berisi domain `0xmurasaki.duckdns.org`, TAMBAHKAN
(jangan ubah baris lain; indentasi tab, konsisten dengan blok sekitarnya):

```caddyfile
	handle_path /gatekeeper/* {
		reverse_proxy 172.18.0.1:8081
	}
```

(ganti `172.18.0.1` dengan IP gateway yang tadi dicatat)

## Langkah 7 — Hot-reload Caddy VFY (graceful, TANPA restart container)

```bash
docker exec steal-the-vfy-agent-caddy-1 \
  caddy reload --config /etc/caddy/Caddyfile
```

> Kalau error "file not found", cek mount aslinya:
> `docker inspect steal-the-vfy-agent-caddy-1 --format '{{json .Mounts}}'`
> lalu pakai path source sebagai `--config`.
> **Jangan pakai docker restart / compose restart sebagai gantinya.**

## Langkah 8 — Verifikasi

Di VPS:
```bash
curl -s http://127.0.0.1:8081/health    # {"ok":true} (gatekeeper hidup)
```

Dari PowerShell laptop:
```powershell
curl.exe -i https://0xmurasaki.duckdns.org/health
# {"ok":true} — gatekeeper terpapar publik lewat pintu VFY

curl.exe -i https://0xmurasaki.duckdns.org/gatekeeper/agent
# HTTP 401 {"error":"invalid signature"} ← TEPAT, HMAC guard aktif

# dan VFY tetap normal:
curl.exe -i https://0xmurasaki.duckdns.org/vfy/<path-vfy>
```

## Langkah 9 — Registrasi dashboard

1. My Agents → daftarkan endpoint **lengkap**:
   `https://0xmurasaki.duckdns.org/gatekeeper/agent`
2. Link repo: `https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent`
3. Pilih event Proof Gatekeeper.

## Langkah 10 — Rotate Secret → preflight

1. Dashboard → Rotate Secret → salin (tampil sekali)
2. VPS:
   ```bash
   nano /root/zkverify/.env     # ganti AGENT_GAMES_HMAC_SECRET nilai asli
   systemctl restart gatekeeper
   ```
3. Trigger preflight dari dashboard; pantau:
   ```bash
   journalctl -u gatekeeper -f  # muncul: preflight received
   ```
   Status agent di dashboard jadi **active**.

## Langkah 11 — Practice mode (WAJIB sebelum ronda skor)

Jalankan task practice sambil `journalctl -u gatekeeper -f`.

| Gejala | Perbaikan |
|---|---|
| Bukti invalid / decision salah | `.env` → `TASKID_FIELD_MODE=digits` (atau `numeric`/`zero`) → restart → coba lagi |
| Semua `PROOF_REUSED` | `rm /root/zkverify/data/seen-proof-tx.json` → restart |
| Kurier macet | Isi `KURIER_API_KEY`; setelah practice mulus: `APPROVAL_REQUIRE_FINALIZED=true` → restart |

## Update saat kompetisi

```bash
cd /root/zkverify && git pull && npm ci && npm run build \
  && systemctl restart gatekeeper
```

## Troubleshooting

| Gejala | Solusi |
|---|---|
| `npm ci` gagal | Node belum versi 22 → ulangi langkah 2 |
| Service `activating` terus | `journalctl -u gatekeeper -n 30 --no-pager`; cek `.env` ada |
| `status=226/NAMESPACE` | `mkdir -p /root/zkverify/data` → restart (unit baru sudah auto) |
| Caddy reload "file not found" | Path config salah → lihat `docker inspect ... Mounts` (langkah 7) |
| `/gatekeeper/*` timeout/502 | Gateway IP salah (ulangi 6a) atau gatekeeper mati (ulangi 5) |
| Preflight signature error | Secret ≠ dashboard → Rotate ulang → restart (langkah 10) |
| Preflight 404 | Endpoint harus `/gatekeeper/agent` (dengan prefix) |
