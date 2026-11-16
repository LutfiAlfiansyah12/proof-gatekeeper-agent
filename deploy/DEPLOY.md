# Runbook DARI NOL — VPS BARU khusus Proof Gatekeeper (standalone)

VPS baru = bersih. Tidak ada Docker VFY, tidak ada konflik port. Caddy
menjadi satu-satunya pemilik port 80/443. Gatekeeper di `127.0.0.1:8080`.

```
Platform → https://<subdomain>.duckdns.org/agent
              │ Caddy :443 (TLS otomatis)
              └── 127.0.0.1:8080 (gatekeeper, systemd)
```

> ⚠️ **Domain:** buat SUBDOMAIN BARU di duckdns.org (misal `0xmurasaki-gk`)
> dan arahkan ke IP VPS baru. Jangan pindahkan subdomain yang sedang dipakai
> VFY di VPS lama. Di runbook ini dipakai `0xmurasaki-gk.duckdns.org` —
> ganti konsisten dengan milikmu.

---

## Langkah 0 — AWS Console (sekali)

1. Instance EC2 Ubuntu (t2.small/t3.small disarankan, 1 vCPU cukup)
2. Security Group inbound:

| Type | Port | Source |
|---|---|---|
| SSH | 22 | IP kamu |
| HTTP | 80 | 0.0.0.0/0 |
| HTTPS | 443 | 0.0.0.0/0 |

3. Catat **Public IPv4**.

## Langkah 1 — DuckDNS (dari browser, sekali)

1. Login duckdns.org → buat subdomain baru (misal `0xmurasaki-gk`)
2. Isi IP-nya dengan Public IPv4 VPS baru

Verifikasi (PowerShell):
```powershell
Resolve-DnsName 0xmurasaki-gk.duckdns.org   # harus = IP VPS baru
```

## Langkah 2 — SSH masuk

```powershell
ssh root@<IP-VPS-BARU>
# kalau instance hanya mengizinkan user ubuntu:
#   ssh ubuntu@<IP> lalu `sudo -i`
```

Semua langkah berikutnya **di VPS sebagai root**.

## Langkah 3 — Install Node.js 22 + git + Caddy

```bash
apt-get update
apt-get install -y curl git

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

node -v    # harus >= 22
```

## Langkah 4 — Clone + build

```bash
cd /root
git clone https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent.git zkverify
cd /root/zkverify
npm ci
npm run build
```

(`artifacts/` wasm+zkey ikut di repo — tidak perlu download ulang.)

## Langkah 5 — .env

```bash
cp .env.example .env
chmod 600 .env
nano /root/zkverify/.env
```

```ini
AGENT_GAMES_HMAC_SECRET=string-random-apa-saja-dulu
KURIER_API_KEY=

HOST=127.0.0.1
PORT=8080
AGENT_PATH=/agent
LOG_LEVEL=info

APPROVAL_REQUIRE_FINALIZED=false
```

> `AGENT_GAMES_HMAC_SECRET` wajib ada isinya supaya service bisa start.
> Nilai asli diisi di Langkah 9 setelah Rotate Secret.
> `APPROVAL_REQUIRE_FINALIZED=false` dulu selama practice; ganti `true`
> setelah `KURIER_API_KEY` terisi dan pipeline terbukti jalan.

## Langkah 6 — Service systemd

```bash
cp /root/zkverify/deploy/gatekeeper.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gatekeeper

systemctl is-active gatekeeper          # → active
curl -s http://127.0.0.1:8080/health    # → {"ok":true}
```

(Unit otomatis membuat `/root/zkverify/data` untuk proof-reuse store.)

## Langkah 7 — Caddy (pintu TLS)

```bash
cp /root/zkverify/deploy/Caddyfile-standalone /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile     # pastikan domain = subdomain kamu
systemctl enable --now caddy

journalctl -u caddy -n 20 --no-pager   # cari: certificate obtained successfully
curl -s http://127.0.0.1/health -H "Host: 0xmurasaki-gk.duckdns.org"   # {"ok":true}
```

## Langkah 8 — Verifikasi publik (PowerShell laptop)

```powershell
curl.exe -i https://0xmurasaki-gk.duckdns.org/health
# HTTP 200 {"ok":true} dengan sertifikat valid

curl.exe -i https://0xmurasaki-gk.duckdns.org/agent
# HTTP 401 {"error":"invalid signature"} ← TEPAT! HMAC guard aktif
```

Kalau keduanya sesuai → endpoint siap.

## Langkah 9 — Registrasi + Rotate Secret + preflight

1. Dashboard Agent Games → My Agents → daftarkan endpoint **lengkap**:
   ```
   https://0xmurasaki-gk.duckdns.org/agent
   ```
2. Link repo GitHub:
   `https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent`
3. Pilih event **Proof Gatekeeper**.
4. **Rotate Secret** → salin (tampil sekali) → di VPS:
   ```bash
   nano /root/zkverify/.env    # ganti AGENT_GAMES_HMAC_SECRET
   systemctl restart gatekeeper
   ```
5. Trigger **preflight** dari dashboard; pantau:
   ```bash
   journalctl -u gatekeeper -f   # muncul: preflight received
   ```
   Status agent di dashboard jadi **active**.

## Langkah 10 — Practice mode (WAJIB sebelum ronda skor)

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

| Gejala | Cek |
|---|---|
| `npm ci` gagal | Node versi (`node -v` ≥ 22) → ulangi Langkah 3 |
| Service `activating` terus | `journalctl -u gatekeeper -n 30 --no-pager`; `.env` ada? |
| `status=226/NAMESPACE` | `mkdir -p /root/zkverify/data` → restart |
| Caddy gagal bind | Tidak boleh ada proses lain di 80/443 → `ss -tlnp \| grep -E ':443 \|:80 '` |
| Sertifikat gagal terbit | Port 80 terbuka? DNS benar? → `journalctl -u caddy -n 50` |
| `/health` OK di VPS, gagal dari laptop | SG port 443; DNS DuckDNS; `systemctl status caddy` |
| Preflight 404 | Endpoint registrasi harus persis `/agent` |
| Preflight signature error | Secret ≠ dashboard → Rotate ulang → restart |
| REJECT semua `CIRCUIT_MISMATCH` | `EXPECTED_VK_HASH` di `.env` jangan diubah dari default |
