# Deploy ke VPS AWS (Ubuntu) — Proof Gatekeeper Agent

Target: EC2 Ubuntu + Caddy (HTTPS otomatis) + systemd (auto-restart).
Domain contoh: `namakamu.duckdns.org` — ganti dengan domainmu.

## 0. Persiapan di AWS Console

1. Catat **Public IPv4** instance EC2.
2. **Security Group** instance → Edit inbound rules, tambahkan:

| Type | Port | Source |
|---|---|---|
| HTTP | 80 | 0.0.0.0/0 (wajib — challenge Let's Encrypt) |
| HTTPS | 443 | 0.0.0.0/0 |
| SSH | 22 | IP kamu saja |

## 1. Domain (DuckDNS — gratis)

1. Login [duckdns.org](https://www.duckdns.org) pakai GitHub/Google.
2. Buat subdomain, misal `namakamu` → jadi `namakamu.duckdns.org`.
3. Isi IP-nya dengan Public IPv4 EC2.

Verifikasi dari laptop:
```bash
ping namakamu.duckdns.org   # harus menjawab IP EC2
```

## 2. Kirim project ke VPS

Dari Windows (Git Bash), via scp — **JANGAN kirim .env, node_modules, dist**:
```bash
cd /d/ZCode/zkVerify
ssh ubuntu@<IP-EC2> "mkdir -p ~/zkverify"
scp -r src test deploy artifacts package.json package-lock.json tsconfig.json .gitignore .env.example \
  ubuntu@<IP-EC2>:~/zkverify/
```

(Alternatif: push ke private GitHub repo, lalu `git clone` di VPS.)

## 3. Setup di VPS (SSH ke EC2)

```bash
ssh ubuntu@<IP-EC2>

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Caddy
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# Build project
cd ~/zkverify
npm ci
npm run build
```

## 4. Secrets di VPS

```bash
cd ~/zkverify
cp .env.example .env
chmod 600 .env
nano .env   # isi AGENT_GAMES_HMAC_SECRET (Rotate Secret di dashboard) + KURIER_API_KEY
```

Ganti juga di `.env`:
```
HOST=127.0.0.1        # Cukup localhost — publiknya lewat Caddy
PORT=8080
AGENT_PATH=/agent     # HARUS sama dengan yang diregistrasi di dashboard
```

> ⚠️ Secret ditempel langsung di VPS via nano — jangan pernah lewat chat/email/screenshot.

## 5. Jalankan sebagai service (auto-restart)

```bash
sudo cp ~/zkverify/deploy/gatekeeper.service /etc/systemd/system/
# sesuaikan path jika perlu: sudo nano /etc/systemd/system/gatekeeper.service
sudo systemctl daemon-reload
sudo systemctl enable --now gatekeeper
journalctl -u gatekeeper -f        # lihat log live (Ctrl+C untuk keluar)
```

## 6. Caddy (HTTPS otomatis)

```bash
sudo cp ~/zkverify/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # ganti namakamu.duckdns.org dengan domainmu
sudo systemctl reload caddy
```

Caddy otomatis dapat sertifikat Let's Encrypt dalam beberapa detik.

## 7. Verifikasi dari laptop

```bash
# Health check (tanpa signature — hanya untuk ops)
curl https://namakamu.duckdns.org/health
# harus jawab: {"ok":true}

# Preflight sungguhan ditrigger dari dashboard (langkah 8)
```

## 8. Registrasi & preflight

1. Dashboard → My Agents → daftarkan endpoint **lengkap**:
   `https://namakamu.duckdns.org/agent`
2. **Rotate Secret** → salin nilainya → paste ke `.env` di VPS →
   `sudo systemctl restart gatekeeper`
3. Trigger **preflight** dari dashboard → cek log:
   `journalctl -u gatekeeper -f` harus menampilkan `preflight received`.
4. Masuk **practice mode** dan jalankan beberapa task sebelum ronda skor.

## 9. Cek pasca-practice (penting)

Perhatikan di log setiap task practice:
- `engine decision` — cocokkan reason_code dengan ekspektasi
- Jika platform menandai bukti tidak valid → kemungkinan `TASKID_FIELD_MODE`
  perlu diganti (`.env` → `digits` / `numeric` / `zero`, lalu restart)

## Troubleshooting cepat

| Gejala | Cek |
|---|---|
| `curl /health` gagal | `sudo systemctl status caddy`, security group port 443 |
| Sertifikat gagal | Port 80 harus terbuka; DNS mengarah ke IP EC2 |
| Preflight signature error | Secret di `.env` ≠ dashboard (Rotate lagi, restart service) |
| Agent tidak jalan | `journalctl -u gatekeeper -n 50`, cek Node versi (`node -v` ≥ 20) |
| REJECT semua task | `CIRCUIT_MISMATCH` → `EXPECTED_VK_HASH` salah; `PROOF_REUSED` salah-salah → hapus `data/seen-proof-tx.json` |

## Patch saat kompetisi

```bash
cd ~/zkverify
# taruh file baru / git pull
npm ci && npm run build
sudo systemctl restart gatekeeper
```
