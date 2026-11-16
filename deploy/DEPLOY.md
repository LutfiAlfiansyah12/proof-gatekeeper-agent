# Deploy VPS AWS (Ubuntu) — Proof Gatekeeper Agent (+ slot agent VFY)

**Semua dijalankan sebagai `root` di `/root/zkverify`.** Source dari GitHub,
tidak ada scp.

| Item | Nilai |
|---|---|
| Repo | https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent |
| Domain | `0xmurasaki.duckdns.org` (DuckDNS) |
| Gatekeeper | systemd, `127.0.0.1:8081` |
| Agent VFY | docker, `127.0.0.1:8080` |
| Pintu depan | **Caddy** — satu-satunya pemilik port `:80` + `:443` |

```
Platform → https://0xmurasaki.duckdns.org/<event>/agent
              │ Caddy :443 (TLS otomatis, routing by path)
              ├── /gatekeeper/* → 127.0.0.1:8081
              └── /vfy/*        → 127.0.0.1:8080
```

> ⚠️ **Aturan emas: tidak boleh ada proses lain yang mempublish port 80/443
> di host.** Container Docker VFY yang meng-bind `0.0.0.0:80`/`:443` harus
> digeser (Langkah 4). Kalau Docker menyita 80/443, Caddy tidak bisa start
> (`bind: address already in use`).

---

## Langkah 0 — SSH masuk (dari PowerShell laptop)

```powershell
ssh root@16.179.122.5
```

Semua perintah berikutnya **di dalam VPS sebagai root**.

## Langkah 1 — Install Node.js 22 + git + Caddy

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git

apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

node -v    # >= 22
```

## Langkah 2 — Clone repo & build gatekeeper

```bash
cd /root
git clone https://github.com/LutfiAlfiansyah12/proof-gatekeeper-agent.git zkverify
cd zkverify
npm ci
npm run build
```

## Langkah 3 — .env gatekeeper (PORT = 8081!)

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

```ini
AGENT_GAMES_HMAC_SECRET=isi-string-random-dulu-ganti-setelah-rotate-secret
KURIER_API_KEY=

HOST=127.0.0.1
PORT=8081
AGENT_PATH=/agent
LOG_LEVEL=info

APPROVAL_REQUIRE_FINALIZED=false
```

## Langkah 4 — Geser Docker VFY dari port 80/443 (sekali saja)

Container VFY tidak boleh lagi mempublish 80/443 ke host. Dia cukup
terpublikasi sebagai `127.0.0.1:8080`.

**Kalau pakai docker compose** — cari file `docker-compose.yml` container VFY
(`docker inspect <nama-container> | grep -A5 Compose` kalau ragu), ubah
bagian `ports:`:

```yaml
ports:
  - "127.0.0.1:8080:8080"   # host:container — sesuaikan angka kanan
                            # dengan port internal container VFY
```

lalu:

```bash
cd <folder-compose-vfy>
docker compose up -d
```

**Kalau docker run manual** — stop container, jalankan ulang dengan mapping
baru (contoh, sesuaikan image + port internal):

```bash
docker stop <container-vfy> && docker rm <container-vfy>
docker run -d --name <container-vfy> --restart unless-stopped \
  -p 127.0.0.1:8080:8080 <image-vfy> <args-sebelumnya>
```

Verifikasi tidak ada lagi yang megang 80/443:

```bash
ss -tlnp | grep -E ":443 |:80 "    # output harus KOSONG
docker ps                          # VFY jalan dengan -p 127.0.0.1:8080:...
```

## Langkah 5 — Service systemd gatekeeper

```bash
cp /root/zkverify/deploy/gatekeeper.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gatekeeper

systemctl is-active gatekeeper        # → active
curl -s http://127.0.0.1:8081/health  # → {"ok":true}
```

## Langkah 6 — Caddy (pintu depan TLS)

```bash
cp /root/zkverify/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl enable --now caddy
journalctl -u caddy -n 20 --no-pager  # cari: certificate obtained successfully
```

Verifikasi routing di VPS:

```bash
curl -s http://127.0.0.1/health -H "Host: 0xmurasaki.duckdns.org"   # gatekeeper {"ok":true}
curl -s http://127.0.0.1/vfy/<path-vfy> -H "Host: 0xmurasaki.duckdns.org"   # sampai ke docker VFY
```

## Langkah 7 — Verifikasi publik (PowerShell laptop)

```powershell
curl.exe -i https://0xmurasaki.duckdns.org/health          # gatekeeper → {"ok":true}
curl.exe -i https://0xmurasaki.duckdns.org/vfy/<path-vfy>  # VFY
```

## Langkah 8 — Registrasi dashboard (per event)

| Event | Endpoint yang didaftarkan |
|---|---|
| Proof Gatekeeper | `https://0xmurasaki.duckdns.org/gatekeeper/agent` |
| Steal the VFY | `https://0xmurasaki.duckdns.org/vfy/<path-vfy-agent>` |

> `handle_path` membuang prefix: `/gatekeeper/agent` tiba di agent sebagai
> `/agent` (sesuai `AGENT_PATH=/agent`). Sama polanya untuk VFY.
> Isi link repo GitHub sesuai repo masing-masing agent.

## Langkah 9 — Rotate Secret (per agent!)

Tiap agent punya secret sendiri:

1. Dashboard → My Agents → pilih agent → **Rotate Secret** → salin (tampil sekali)
2. Gatekeeper: `nano /root/zkverify/.env` → ganti `AGENT_GAMES_HMAC_SECRET` →
   `systemctl restart gatekeeper`
3. VFY: update secret di `.env`/config container-nya → `docker compose up -d`
   (atau restart container)
4. Trigger **preflight** kedua agent dari dashboard; pantau:
   ```bash
   journalctl -u gatekeeper -f        # harus muncul: preflight received
   docker logs -f <container-vfy>     # idem untuk VFY
   ```

## Langkah 10 — Practice mode (WAJIB sebelum ronda skor)

| Gejala | Perbaikan |
|---|---|
| Bukti invalid / decision salah (gatekeeper) | `.env` → `TASKID_FIELD_MODE=digits` (atau `numeric`/`zero`) → restart |
| Semua `PROOF_REUSED` | `rm /root/zkverify/data/seen-proof-tx.json` → restart |
| Kurier macet | Set `KURIER_API_KEY` + `APPROVAL_REQUIRE_FINALIZED=true` setelah practice mulus |

## Update saat kompetisi

```bash
cd /root/zkverify && git pull && npm ci && npm run build && systemctl restart gatekeeper
```

## Troubleshooting cepat

| Gejala | Penyebab → solusi |
|---|---|
| Caddy `bind: address already in use` | Ada proses lain (biasanya docker-proxy) megang 80/443 → Langkah 4 |
| `ss` menunjukkan docker-proxy di 80/443 | Container VFY publish host port → hapus mapping 80/443-nya |
| gatekeeper `activating` terus | `journalctl -u gatekeeper -n 30 --no-pager`; cek `.env` ada & `PORT` tidak bentrok |
| `Failed to load environment files` | `.env` belum ada di `/root/zkverify/.env` |
| Preflight 404 | Endpoint registrasi harus **dengan prefix** (`/gatekeeper/agent`) |
| Preflight signature error | Secret ≠ dashboard → Rotate ulang → restart service |
| 502 pada `/vfy/*` | Container VFY tidak jalan / salah port internal |
