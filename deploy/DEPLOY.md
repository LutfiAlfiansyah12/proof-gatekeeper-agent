# Deploy ke VPS AWS (Ubuntu) — Proof Gatekeeper Agent

Semua langkah dijalankan **langsung di VPS via SSH** — tidak perlu scp dari
laptop. Source diambil dari GitHub.

- **Repo:** https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent
- **Domain:** `0xmurasaki.duckdns.org` (DuckDNS, gratis)
- **Arsitektur:** Caddy (HTTPS otomatis, :443) → agent (127.0.0.1:8080)
  Slot `/vfy/*` → :8081 sudah disiapkan untuk agent Steal the VFY nanti.

```
Platform (HTTPS, signed) → https://0xmurasaki.duckdns.org/gatekeeper/agent
                              │ Caddy (TLS, routing by path)
                              ├── /gatekeeper/* → 127.0.0.1:8080  (agent ini)
                              └── /vfy/*        → 127.0.0.1:8081  (slot reserved)
```

> Verifikasi dari laptop yang sudah lulus: DNS resolve benar, port 80 & 443
> `TcpTestSucceeded : True`. (ICMP/ping memang diblok AWS — abaikan.)

## 0. AWS Security Group (sekali saja, dari Console)

Inbound rules instance EC2:

| Type | Port | Source |
|---|---|---|
| HTTP | 80 | 0.0.0.0/0 (wajib — challenge Let's Encrypt) |
| HTTPS | 443 | 0.0.0.0/0 |
| SSH | 22 | IP kamu saja |

✅ **Sudah dilakukan** (port 80/443 sudah `TcpTestSucceeded : True`).

## 1. SSH masuk ke VPS (dari PowerShell laptop)

```powershell
ssh ubuntu@16.179.122.5
# kalau key pair bukan default:
# ssh -i C:\path\to\keypair.pem ubuntu@16.179.122.5
```

Sisa langkah di bawah ini **semuanya di dalam VPS** (prompt `ubuntu@ip-...:~$`).

## 2. Install Node.js 22 + Caddy

```bash
# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Caddy
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

## 3. Clone repo & build

```bash
cd ~
git clone https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent.git zkverify
cd zkverify
npm ci
npm run build          # menghasilkan dist/ (dist tidak di-commit)
```

> `artifacts/` (wasm + zkey) sudah ikut di repo — tidak perlu download ulang.

## 4. Buat .env langsung di VPS (secrets TIDAK lewat git)

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Isi/tambahkan nilai-nilai ini:

```ini
AGENT_GAMES_HMAC_SECRET=<dari dashboard Rotate Secret — tempel di sini>
KURIER_API_KEY=<kalau sudah ada; boleh dikosongkan dulu>

HOST=127.0.0.1          # penting: cukup localhost, publiknya lewat Caddy
PORT=8080
AGENT_PATH=/agent       # HARUS persis; jangan diubah
LOG_LEVEL=info
```

> ⚠️ Secret ditempel langsung via nano di VPS — jangan lewat chat, email,
> screenshot, atau commit.

## 5. Jalankan sebagai service (auto-restart)

```bash
sudo cp ~/zkverify/deploy/gatekeeper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gatekeeper
journalctl -u gatekeeper -f        # log live (Ctrl+C keluar)
```

Cek lokal di VPS:
```bash
curl -s http://127.0.0.1:8080/health    # harus: {"ok":true}
```

## 6. Caddy (HTTPS otomatis + routing dual-agent)

```bash
sudo cp ~/zkverify/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # pastikan domain 0xmurasaki.duckdns.org
sudo systemctl reload caddy
```

Caddy otomatis minta sertifikat Let's Encrypt (butuh port 80 terbuka — sudah).

> Slot `/vfy/*` di Caddyfile boleh aktif sekarang. Kalau port 8081 belum ada
> yang listen, request ke sana hanya 502 — gatekeeper tidak terpengaruh.

## 7. Verifikasi dari laptop (PowerShell)

```powershell
curl.exe -i https://0xmurasaki.duckdns.org/health
# Harap: HTTP/2 200 + {"ok":true} dengan sertifikat valid (tanpa warning TLS)
```

## 8. Registrasi agent & preflight (dashboard Agent Games)

1. Dashboard → My Agents → daftarkan endpoint **lengkap**:
   ```
   https://0xmurasaki.duckdns.org/gatekeeper/agent
   ```
   (`handle_path` di Caddy membuang prefix `/gatekeeper`, jadi sampai ke agent
   sebagai `/agent` — cocok dengan `AGENT_PATH`.)
2. Isi link repo GitHub: `https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent`
3. **Rotate Secret** → salin → paste ke `.env` di VPS (langkah 4) →
   ```bash
   sudo systemctl restart gatekeeper
   ```
   (Kalau secret sudah diisi sebelum start, lewati restart.)
4. Trigger **preflight** dari dashboard → log harus menampilkan
   `preflight received` dan agent jadi **active**.
5. Jalankan beberapa task di **practice mode** SEBELUM ronda skor.

## 9. Checklist pasca-practice (penting!)

Perhatikan log (`journalctl -u gatekeeper -f`) untuk tiga hal yang belum
dikonfirmasi dokumen resmi:

| Gejala | Kemungkinan penyebab | Perbaikan |
|---|---|---|
| Bukti dinilai invalid / decision salah | Derivasi `task_id` → field beda dari asumsi | `.env` → `TASKID_FIELD_MODE=digits` / `numeric` / `zero`, restart |
| Preflight signature error | Secret `.env` ≠ dashboard | Rotate lagi → update `.env` → restart |
| Semua task `PROOF_REUSED` | Store reuse basi dari testing | `rm ~/zkverify/data/seen-proof-tx.json` → restart |

## Patch saat kompetisi

```bash
cd ~/zkverify
git pull
npm ci && npm run build
sudo systemctl restart gatekeeper
```

## Troubleshooting cepat

| Gejala | Cek |
|---|---|
| `curl /health` gagal di laptop tapi OK di VPS | `sudo systemctl status caddy`; security group 443; DNS |
| Sertifikat gagal terbit | Port 80 terbuka? DNS mengarah IP EC2? `sudo journalctl -u caddy -n 50` |
| Preflight 404 | Endpoint registrasi ≠ path aktual — ingat `handle_path` membuang `/gatekeeper` |
| Service mati terus | `journalctl -u gatekeeper -n 50`; `node -v` ≥ 20? `.env` lengkap? |
| Semua REJECT `CIRCUIT_MISMATCH` | `EXPECTED_VK_HASH` di `.env` salah — default sudah benar dari repo |
