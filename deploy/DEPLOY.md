# Deploy VPS AWS (Ubuntu) — Proof Gatekeeper Agent

**Semua dijalankan sebagai `root` di `/root/zkverify`.** Tidak ada scp — source
ditarik langsung dari GitHub.

| Item | Nilai |
|---|---|
| Repo | https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent |
| Domain | `0xmurasaki.duckdns.org` (DuckDNS) |
| VPS | EC2 Ubuntu, SSH sebagai `root` |
| Agent | `127.0.0.1:8080` di belakang Caddy (:443) |

```
Platform → https://0xmurasaki.duckdns.org/gatekeeper/agent
              │ Caddy :443 (TLS otomatis, routing by path)
              ├── /gatekeeper/* → 127.0.0.1:8080  (agent ini)
              └── /vfy/*        → 127.0.0.1:8081  (slot agent VFY, nanti)
```

Prasyarat yang sudah ✅: Security Group buka 80/443, DuckDNS mengarah ke IP
EC2, port 80+443 `TcpTestSucceeded : True` dari laptop.

---

## Langkah 0 — SSH masuk (dari PowerShell laptop)

```powershell
ssh root@16.179.122.5
# atau: ssh -i C:\path\to\keypair.pem root@16.179.122.5
```

Kalau EC2 kamu hanya mengizinkan login `ubuntu`, masuk pakai
`ssh ubuntu@16.179.122.5` lalu `sudo -i` untuk jadi root. Semua perintah di
bawah tetap sama.

Sisa langkah **semuanya di dalam VPS sebagai root** (prompt `root@ip-...:~#`).

## Langkah 1 — Install Node.js 22 + git + Caddy

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git

apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

node -v    # harus >= 22
```

## Langkah 2 — Clone repo & build

```bash
cd /root
git clone https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent.git zkverify
cd zkverify
npm ci
npm run build
```

`artifacts/` (wasm + zkey) ikut di repo — tidak perlu download ulang.
Folder `data/` akan dibuat otomatis oleh service (langkah 5).

## Langkah 3 — Buat .env (secrets HANYA di sini, tidak pernah di git)

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Isi seperti ini (secret beneran diisi setelah Rotate Secret — langkah 8):

```ini
AGENT_GAMES_HMAC_SECRET=sementara-isi-string-random-apa-saja
KURIER_API_KEY=

HOST=127.0.0.1
PORT=8080
AGENT_PATH=/agent
LOG_LEVEL=info

APPROVAL_REQUIRE_FINALIZED=false
```

> `AGENT_GAMES_HMAC_SECRET` wajib ada isinya (nilai apapun) supaya service
> bisa start. Nilai asli diisi di langkah 8.
> `APPROVAL_REQUIRE_FINALIZED=false` dulu selama fase practice — setelah
> `KURIER_API_KEY` terisi dan pipeline terbukti jalan, ganti ke `true`.

## Langkah 4 — Pasang service systemd

```bash
cp /root/zkverify/deploy/gatekeeper.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gatekeeper
```

Verifikasi:

```bash
systemctl is-active gatekeeper        # harus: active
curl -s http://127.0.0.1:8080/health  # harus: {"ok":true}
journalctl -u gatekeeper -n 15 --no-pager
```

> Service otomatis membuat `/root/zkverify/data` (proof-reuse store) sebelum
> start. Kalau status `activating/auto-restart`, lihat
> `journalctl -u gatekeeper -n 30 --no-pager`.

## Langkah 5 — Caddy (HTTPS otomatis + routing dual-agent)

```bash
cp /root/zkverify/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

Domain di Caddyfile sudah benar (`0xmurasaki.duckdns.org`). Caddy otomatis
menerbitkan sertifikat Let's Encrypt (butuh port 80 — sudah terbuka). Slot
`/vfy/*` boleh aktif sekarang; selama :8081 kosong, request ke sana hanya 502
dan gatekeeper tidak terpengaruh.

Verifikasi di VPS:

```bash
curl -s http://127.0.0.1/health -H "Host: 0xmurasaki.duckdns.org"   # {"ok":true}
journalctl -u caddy -n 20 --no-pager     # cari "certificate obtained"
```

## Langkah 6 — Verifikasi publik (dari PowerShell laptop)

```powershell
curl.exe -i https://0xmurasaki.duckdns.org/health
```

Harap: `HTTP/2 200` + `{"ok":true}`, tanpa warning TLS. Kalau ini hijau,
endpoint publik kamu siap.

## Langkah 7 — Registrasi di dashboard Agent Games

1. Dashboard → My Agents → daftarkan endpoint **lengkap persis**:
   ```
   https://0xmurasaki.duckdns.org/gatekeeper/agent
   ```
2. Isi link repo GitHub:
   `https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent`
3. Pilih event **Proof Gatekeeper**.

> Mekanisme: `handle_path /gatekeeper/*` membuang prefix, jadi POST platform ke
> `/gatekeeper/agent` tiba di agent sebagai `/agent` — cocok dengan
> `AGENT_PATH=/agent`. Jangan pernah daftarkan `/gatekeeper` saja.

## Langkah 8 — Rotate Secret & pasang

1. Dashboard → My Agents → **Rotate Secret** → salin nilainya (sekali tampil).
2. Di VPS:
   ```bash
   nano /root/zkverify/.env      # ganti AGENT_GAMES_HMAC_SECRET dengan nilai asli
   systemctl restart gatekeeper
   ```
3. Trigger **preflight** dari dashboard → `journalctl -u gatekeeper -f` harus
   menampilkan `preflight received`, dan status agent di dashboard jadi
   **active**.

## Langkah 9 — Practice mode (WAJIB sebelum ronda skor)

Jalankan beberapa task practice sambil memantau:

```bash
journalctl -u gatekeeper -f
```

Cek tiga hal yang belum dikonfirmasi dokumen resmi:

| Gejala | Penyebab | Perbaikan |
|---|---|---|
| Bukti dinilai invalid / decision salah | Derivasi `task_id` → field beda dari asumsi | `.env` → `TASKID_FIELD_MODE=digits` (atau `numeric` / `zero`) → restart |
| Kurier gagal / finalisasi macet | Job-status endpoint beda bentuk | Sesuaikan `src/kurier.ts` |
| Semua task `PROOF_REUSED` | Store reuse basi dari testing | `rm /root/zkverify/data/seen-proof-tx.json` → restart |

Setelah practice mulus dan `KURIER_API_KEY` terisi: `.env` →
`APPROVAL_REQUIRE_FINALIZED=true` → restart.

## Update saat kompetisi

```bash
cd /root/zkverify
git pull
npm ci && npm run build
systemctl restart gatekeeper
```

## Troubleshooting cepat

| Gejala | Cek |
|---|---|
| `activating` terus (restart loop) | `journalctl -u gatekeeper -n 30 --no-pager` |
| `Failed to load environment files` | `.env` belum ada → langkah 3 |
| `status=226/NAMESPACE` | Folder data hilang → `mkdir -p /root/zkverify/data` → restart |
| `/health` OK di VPS, gagal dari laptop | `systemctl status caddy`; SG port 443; DNS DuckDNS |
| Sertifikat gagal terbit | Port 80 terbuka? DNS benar? `journalctl -u caddy -n 50` |
| Preflight 404 | Endpoint harus `/gatekeeper/agent` (dengan prefix) |
| Preflight signature error | Secret `.env` ≠ dashboard → Rotate lagi → update → restart |
| REJECT semua `CIRCUIT_MISMATCH` | `EXPECTED_VK_HASH` di `.env` jangan diubah dari default |
