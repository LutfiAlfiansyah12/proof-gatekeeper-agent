# Runbook: Pasang Proof Gatekeeper TANPA MENYENTUH VFY

Kondisi VPS: VFY sudah jalan (compose `/root/steal-the-vfy-agent`, caddy
docker-nya pegang port 80/443). Runbook ini **additive-only**: gatekeeper
menumpang di belakang Caddy milik VFY.

```
Docker Caddy milik VFY (TIDAK DISENTUH, tetap pemilik :80/:443)
├── route VFY lama → agent:3000                (tidak disentuh)
└── /gatekeeper/* → <gateway-ip>:8081          (SATU-SATUNYA yang ditambahkan)
                       │
                       └── gatekeeper (systemd, di host)
```

## ⛔ ATURAN EMAS — jangan pernah lakukan ini

1. **Jangan** `systemctl start/enable caddy` di HOST (bentrok dengan caddy docker)
2. **Jangan** stop/rm/restart container docker apapun (`docker compose down/up`, `docker restart`)
3. **Jangan** edit `docker-compose.yml` VFY, image, volume, atau environment VFY
4. **Jangan** edit bagian lain Caddyfile VFY — hanya **menambah** satu blok route

Pelanggaran #2/#3 = VFY putus sesaat dan bisa gagal preflight. Cukup langkah
di bawah — semuanya tidak menyentuh VFY kecuali satu blok teks di Caddyfile-nya
yang di-reload **tanpa memutus koneksi**.

---

## Langkah 1 — SSH (dari PowerShell laptop)

```powershell
ssh root@16.179.122.5
```

## Langkah 2 — Update kode gatekeeper

```bash
cd /root/zkverify
git pull
npm ci && npm run build
```

## Langkah 3 — .env gatekeeper: PORT 8081, HOST 0.0.0.0

```bash
nano /root/zkverify/.env
```

Pastikan nilai ini (baris lain boleh tetap):

```ini
AGENT_GAMES_HMAC_SECRET=string-random-apa-saja-dulu
HOST=0.0.0.0
PORT=8081
AGENT_PATH=/agent
APPROVAL_REQUIRE_FINALIZED=false
```

> Kenapa `0.0.0.0`: traffic dari container docker masuk lewat interface
> bridge, bukan loopback — kalau bind 127.0.0.1, Caddy VFY tidak akan bisa
> mencapai gatekeeper. Tetap aman dari internet karena AWS Security Group
> hanya membuka 22/80/443.

## Langkah 4 — Jalankan & verifikasi gatekeeper (lokal)

```bash
systemctl daemon-reload
systemctl restart gatekeeper
systemctl is-active gatekeeper          # → active
curl -s http://127.0.0.1:8081/health    # → {"ok":true}
```

## Langkah 5 — Cari Caddyfile VFY + IP gateway docker

```bash
find /root/steal-the-vfy-agent -name "Caddyfile" -not -path "*/node_modules/*"

docker network inspect "$(
  docker inspect steal-the-vfy-agent-caddy-1 \
    --format '{{range $k,$_ := .NetworkSettings.Networks}}{{$k}}{{end}}'
)" --format '{{(index .IPAM.Config 0).Gateway}}'
```

Catat dua hal: **path Caddyfile** (mis. `/root/steal-the-vfy-agent/caddy/Caddyfile`)
dan **IP gateway** (mis. `172.18.0.1`).

## Langkah 6 — Tambah SATU blok route di Caddyfile VFY

```bash
nano <path-Caddyfile-dari-langkah-5>
```

Di **dalam blok site yang berisi domain `0xmurasaki.duckdns.org`**, tambahkan
(satu blok ini saja — jangan sentuh baris lain; indentasi pakai tab sama
seperti blok di sekitarnya):

```caddyfile
	handle_path /gatekeeper/* {
		reverse_proxy 172.18.0.1:8081
	}
```

Ganti `172.18.0.1` dengan IP gateway hasil langkah 5.

## Langkah 7 — Hot-reload Caddy VFY (TANPA restart container!)

```bash
docker exec steal-the-vfy-agent-caddy-1 \
  caddy reload --config /etc/caddy/Caddyfile
```

> `reload` = graceful, koneksi aktif tidak diputus — VFY tidak terganggu.
> Kalau error "file not found", cek config mana yang di-mount:
> `docker inspect steal-the-vfy-agent-caddy-1 --format '{{json .Mounts}}'`
> lalu gunakan path source-nya sebagai `--config`.
> **Jangan** pakai `docker restart` / `compose restart` sebagai gantinya.

## Langkah 8 — Verifikasi

Di VPS:
```bash
docker exec steal-the-vfy-agent-caddy-1 \
  wget -qO- --header "Host: 0xmurasaki.duckdns.org" http://127.0.0.1:8080/gatekeeper/agent || true
# yang penting: ada RESPONSE (401/404 juga bagus) — berarti route hidup
```

Dari PowerShell laptop:
```powershell
curl.exe -i https://0xmurasaki.duckdns.org/gatekeeper/agent
# HTTP 401 {"error":"invalid signature"}  ← TEPAT! berarti sampai ke HMAC gate
curl.exe -i https://0xmurasaki.duckdns.org/health
# {"ok":true} — gatekeeper via pintu VFY
```

## Langkah 9 — Registrasi di dashboard

1. My Agents → daftarkan endpoint **lengkap**:
   `https://0xmurasaki.duckdns.org/gatekeeper/agent`
2. Link repo GitHub: `https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent`
3. Pilih event **Proof Gatekeeper**.

## Langkah 10 — Rotate Secret (baru nilai asli masuk)

1. Dashboard → Rotate Secret → salin (tampil sekali)
2. VPS:
   ```bash
   nano /root/zkverify/.env        # ganti AGENT_GAMES_HMAC_SECRET
   systemctl restart gatekeeper
   ```
3. Trigger **preflight** dari dashboard, pantau:
   ```bash
   journalctl -u gatekeeper -f     # harus muncul: preflight received
   ```

## Langkah 11 — Practice mode

Jalankan task practice sambil `journalctl -u gatekeeper -f`. Kalau bukti
dinilai invalid → `.env` → `TASKID_FIELD_MODE=digits` (atau `numeric`) →
restart → coba lagi. Setelah `KURIER_API_KEY` ada dan practice mulus:
`.env` → `APPROVAL_REQUIRE_FINALIZED=true` → restart.

## Update saat kompetisi

```bash
cd /root/zkverify && git pull && npm ci && npm run build \
  && systemctl restart gatekeeper
```

## Troubleshooting

| Gejala | Solusi |
|---|---|
| Caddy reload error "file not found" | Gunakan path mount asli (lihat langkah 7) |
| `curl /gatekeeper/agent` timeout | Gateway IP salah → ulangi langkah 5; atau gatekeeper mati → langkah 4 |
| 502 di `/gatekeeper/*` | Gatekeeper bind salah — pastikan `HOST=0.0.0.0` |
| Preflight signature error | Secret `.env` ≠ dashboard → Rotate ulang → restart |
| 404 dari route VFY | Blok belum di dalam site block yang benar / indentasi salah |
