/**
 * Local end-to-end harness.
 *
 * Boots the agent server in-process (with KURIER disabled so proofs answer
 * immediately), signs the sample envelopes with a local test secret, replays
 * them against the live HTTP handler, verifies the response signature over the
 * raw body, and asserts decisions + reason codes.
 *
 * Usage: node dist/test/harness.js [--port 8080]
 */
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

// ── Environment must be configured BEFORE any module reads it ────────────────
process.env.AGENT_GAMES_HMAC_SECRET =
  process.env.AGENT_GAMES_HMAC_SECRET_FOR_HARNESS ??
  'local-harness-test-secret-do-not-use-in-production';
process.env.KURIER_API_KEY = ''; // pure-local run: skip on-chain finalization
process.env.APPROVAL_REQUIRE_FINALIZED = 'false';
process.env.REUSE_STORE_PATH = './data/harness-reuse.json';
process.env.LOG_LEVEL = process.env.HARNESS_LOG_LEVEL ?? 'warn';

const portArg = process.argv.indexOf('--port') >= 0 ? process.argv[process.argv.indexOf('--port') + 1] : undefined;
const port = Number(portArg ?? 8080);
if (!Number.isFinite(port) || port <= 0) throw new Error(`bad --port: ${portArg}`);
process.env.PORT = String(port);
process.env.HOST = '127.0.0.1';

const { SAMPLES, TEST_SECRET } = await import('./samples.js');
const { startServer } = await import('../src/server.js');
const { computeHmac } = await import('../src/hmac.js');

// Fresh reuse store per run
try { fs.rmSync('./data/harness-reuse.json', { force: true }); } catch { /* ignore */ }

startServer();
await new Promise((r) => setTimeout(r, 300));

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

function post(path: string, rawBody: Buffer, sigOverBody?: Buffer): Promise<{ status: number; raw: Buffer; sig: string | undefined }> {
  return new Promise((resolve, reject) => {
    const digest = computeHmac(sigOverBody ?? rawBody, TEST_SECRET).toString('hex');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-games-signature': `sha256=${digest}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            raw: Buffer.concat(chunks),
            sig: res.headers['x-agent-games-signature'] as string | undefined,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(rawBody);
  });
}

function postNoSig(path: string, rawBody: Buffer): Promise<{ status: number; raw: Buffer; sig: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            raw: Buffer.concat(chunks),
            sig: res.headers['x-agent-games-signature'] as string | undefined,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(rawBody);
  });
}

function verifyResponseSig(raw: Buffer, sig: string | undefined): boolean {
  if (!sig) return false;
  const hex = sig.toLowerCase().replace(/^sha256=/, '').replace(/^v1=/, '');
  return crypto.timingSafeEqual(Buffer.from(hex), Buffer.from(computeHmac(raw, TEST_SECRET).toString('hex')));
}

const results: Result[] = [];
let sawProof = false;

for (const sample of SAMPLES) {
  const pristine = Buffer.from(JSON.stringify(sample.build()), 'utf8');
  // Send the tampered body but keep the signature computed over the pristine
  // body — simulating a body modified after signing.
  const sendBody = sample.tamperSignature
    ? Buffer.from(JSON.stringify({ ...JSON.parse(pristine.toString('utf8')), mode: 'tampered' }), 'utf8')
    : pristine;
  const signBody = sample.tamperSignature ? pristine : pristine;

  try {
    const res = sample.omitSignature
      ? await postNoSig('/agent', sendBody)
      : await post('/agent', sendBody, signBody);
    const sigOk = !sample.omitSignature ? verifyResponseSig(res.raw, res.sig) : true;

    if (sample.tamperSignature || sample.omitSignature) {
      const ok = res.status === 401 && sigOk;
      results.push({ name: sample.name, ok, detail: `status=${res.status}` });
      continue;
    }

    const body = JSON.parse(res.raw.toString('utf8'));

    if (sample.name === 'preflight') {
      const ok = res.status === 200 && body.ok === true && body.protocolVersion === 'v1' && sigOk;
      results.push({ name: sample.name, ok, detail: JSON.stringify(body) });
      continue;
    }

    const decisionOk = body.decision === sample.expectDecision;
    const reasonOk = sample.expectReason ? body.reason_code === sample.expectReason : true;
    const proofOk =
      body.decision === 'REJECT' ||
      (body.proof && body.public_signals && Array.isArray(body.public_signals));
    if (body.proof) sawProof = true;

    // Public-signal sanity for approvals: decision signal must be 1.
    let decisionSignalOk = true;
    if (body.decision === 'APPROVE' && Array.isArray(body.public_signals)) {
      decisionSignalOk = body.public_signals[11] === '1';
    }

    const ok = res.status === 200 && sigOk && decisionOk && reasonOk && proofOk && decisionSignalOk;
    results.push({
      name: sample.name,
      ok,
      detail: `decision=${body.decision} reason=${body.reason_code} proof=${body.proof ? 'yes' : 'no'} sig=${sigOk ? 'valid' : 'INVALID'}${decisionSignalOk ? '' : ' DECISION-SIGNAL-BAD'}`,
    });
  } catch (e) {
    results.push({ name: sample.name, ok: false, detail: String((e as Error).message) });
  }
}

// Reuse test: replay the valid task with the SAME proof_tx — must be rejected.
{
  const samples = SAMPLES.find((s) => s.name.startsWith('valid transfer'));
  const env = samples!.build() as { task_id: string };
  env.task_id = 'gk_valid_02_replay';
  const res = await post('/agent', Buffer.from(JSON.stringify(env)));
  const body = JSON.parse(res.raw.toString('utf8'));
  const ok = body.decision === 'REJECT' && body.reason_code === 'PROOF_REUSED';
  results.push({ name: 'proof reuse replay — expect REJECT', ok, detail: `decision=${body.decision} reason=${body.reason_code}` });
}

// Unknown path unsigned 404 check
{
  const res = await post('/nope', Buffer.from('{}'));
  const ok = res.status === 404 && verifyResponseSig(res.raw, res.sig);
  results.push({ name: 'unknown path returns signed 404', ok, detail: `status=${res.status}` });
}

console.log('\n════════ Harness results ════════');
let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}  —  ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} passed. Proof was generated: ${sawProof ? 'yes' : 'NO'}`);
if (!sawProof) console.log('⚠️  no proof was generated in the whole run — investigate');
process.exit(pass === results.length && sawProof ? 0 : 1);
