/**
 * The agent's public HTTPS endpoint.
 *
 * Request lifecycle (hard 60s platform deadline — we answer before it):
 *   1. Collect the RAW body (never streaming-parse JSON).
 *   2. Verify HMAC over the raw body BEFORE parsing JSON. Reject on mismatch.
 *   3. Route: preflight -> {ok:true, protocolVersion:"v1"}; gatekeeper task ->
 *      engine -> (APPROVE ? Kurier finalization gate) -> snarkjs proof ->
 *      signed response { decision, reason_code, proof, public_signals }.
 *   4. Every response is signed over the raw response body bytes.
 *
 * Fail closed: any error/timeout => signed REJECT.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import { config } from './config.js';
import { log, setLogLevel } from './log.js';
import { verifyHmac, computeHmac, encodeHeader, type SigStyle } from './hmac.js';
import {
  isGatekeeperEnvelope,
  isPreflightEnvelope,
  ReasonCode,
  type Decision,
  type GatekeeperResponse,
  type PreflightResponse,
} from './types.js';
import { evaluate } from './engine.js';
import { ReuseStore } from './reuse.js';
import { proveDecision, type ProofArtifacts } from './prover.js';
import { submitAndAwaitFinalization } from './kurier.js';

const reuse = new ReuseStore();
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — envelopes are tiny

// ─── helpers ──────────────────────────────────────────────────────────────────

interface RawRequest {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  style: SigStyle;
}

function collectRawBody(req: http.IncomingMessage, onDone: (err: Error | null, body?: Buffer) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c: Buffer) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      onDone(new Error('body too large'));
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (!aborted) onDone(null, Buffer.concat(chunks));
  });
  req.on('error', (e) => {
    if (!aborted) onDone(e);
  });
}

function signResponse(res: http.ServerResponse, rawBody: Buffer, style: SigStyle): void {
  const digest = computeHmac(rawBody, config.hmacSecret);
  res.setHeader('x-agent-games-signature', encodeHeader(digest, style));
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', String(rawBody.length));
  res.end(rawBody);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, style: SigStyle): void {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  signResponse(res, raw, style);
}

function rejectResponse(
  reasonCode: ReasonCode,
  taskId: string | null,
  artifacts?: ProofArtifacts,
): GatekeeperResponse {
  const out: GatekeeperResponse = { decision: 'REJECT', reason_code: reasonCode };
  if (taskId) (out as { task_id?: string }).task_id = taskId;
  if (artifacts) {
    out.proof = artifacts.proof;
    out.public_signals = artifacts.publicSignals;
  }
  return out;
}

// ─── gatekeeper task pipeline ─────────────────────────────────────────────────

interface TaskOutcome {
  status: number;
  payload: GatekeeperResponse;
}

async function handleGatekeeperTask(
  env: ReturnType<typeof JSON.parse>,
  raw: RawRequest,
  startedAt: number,
): Promise<TaskOutcome> {
  const taskId: string = typeof env.task_id === 'string' ? env.task_id : '(unknown)';
  const deadline = new Promise<'timeout'>((resolve) => {
    const ms = Math.max(1000, config.behaviour.internalDeadlineMs - (Date.now() - startedAt));
    setTimeout(() => resolve('timeout'), ms).unref();
  });

  const work = processTask(env, raw, startedAt, taskId);
  const result = await Promise.race([work, deadline]);

  if (result === 'timeout') {
    log.error('task pipeline hit internal deadline — failing closed', { task_id: taskId });
    return { status: 200, payload: rejectResponse(ReasonCode.TIMEOUT_FALLBACK, taskId) };
  }
  return result;
}

async function processTask(
  env: ReturnType<typeof JSON.parse>,
  raw: RawRequest,
  startedAt: number,
  taskId: string,
): Promise<TaskOutcome> {
  // Checklist #6 — schema + signature validity before any work.
  if (!isGatekeeperEnvelope(env)) {
    return { status: 200, payload: rejectResponse(ReasonCode.UNSUPPORTED_TASK_TYPE, taskId) };
  }

  const engineOutcome = evaluate(env, { signatureValid: true, now: new Date() }, reuse);
  log.info('engine decision', {
    task_id: taskId,
    decision: engineOutcome.decision,
    reason_code: engineOutcome.reasonCode,
  });

  let parsed = engineOutcome.parsed;
  let decision: Decision = engineOutcome.decision;
  let reasonCode = engineOutcome.reasonCode;
  let artifacts: ProofArtifacts | undefined;
  let proofTxReference: string | undefined;

  // We need parsed values even for engine-failures that occurred after the
  // structural parse; for earlier failures parsed is undefined and no proof
  // attempt is possible.
  if (!parsed) {
    return { status: 200, payload: rejectResponse(reasonCode, taskId) };
  }

  try {
    // ── Proof generation (circuit is the referee) ──
    const proveOutcome = await proveDecision(parsed, decision);
    if (proveOutcome.witnessedDecision === 'APPROVE' && proveOutcome.artifacts) {
      artifacts = proveOutcome.artifacts;

      // Checklist #5 — finalized BEFORE approval.
      if (config.approvalRequireFinalized) {
        const budget = Math.max(0, Math.min(config.kurier.finalizeTimeoutMs, config.behaviour.internalDeadlineMs - (Date.now() - startedAt)));
        const kurier = await submitAndAwaitFinalization(
          artifacts.proof as unknown as Record<string, unknown>,
          artifacts.publicSignals,
          budget,
          startedAt,
        );
        if (kurier.finalized) {
          proofTxReference = kurier.reference;
        } else if (decision === 'APPROVE') {
          // Fail closed: no finalization -> no approval.
          log.warn('approval blocked: verification not finalized', { task_id: taskId });
          decision = 'REJECT';
          reasonCode = ReasonCode.VERIFICATION_NOT_FINALIZED;
          artifacts = undefined;
        }
      }
      markProofConsumed(env, taskId);
    } else if (proveOutcome.witnessedDecision === 'REJECT' && proveOutcome.artifacts) {
      artifacts = proveOutcome.artifacts;
      if (decision === 'APPROVE') {
        // Circuit refuted the approval -> correct decision is REJECT.
        decision = 'REJECT';
        reasonCode = ReasonCode.CIRCUIT_REFUTED;
      }
      markProofConsumed(env, taskId);
    } else {
      // No witnessable decision (off-circuit rejection, or refuted-approve
      // without a provable reject). Respond without proof.
      if (decision === 'APPROVE') {
        decision = 'REJECT';
        reasonCode = ReasonCode.CIRCUIT_REFUTED;
      }
      markProofConsumed(env, taskId);
    }
  } catch (e) {
    log.error('task pipeline error — failing closed', {
      task_id: taskId,
      error: String((e as Error).message).slice(0, 200),
    });
    decision = 'REJECT';
    reasonCode = ReasonCode.INTERNAL_ERROR;
    artifacts = undefined;
  }

  const payload: GatekeeperResponse = {
    decision,
    reason_code: reasonCode,
    ...(artifacts
      ? { proof: artifacts.proof, public_signals: artifacts.publicSignals }
      : {}),
    ...(proofTxReference ? { proof_tx: proofTxReference } : {}),
  };
  return { status: 200, payload };
}

/** Checklist #4: consume the task's proof reference exactly once. */
function markProofConsumed(env: { input?: { proof_tx?: unknown } }, taskId: string): void {
  const proofTxKey = String(env?.input?.proof_tx ?? '').trim().toLowerCase();
  if (proofTxKey) reuse.record(proofTxKey, taskId);
}

// ─── routing ──────────────────────────────────────────────────────────────────

function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: RawRequest,
  rawBody: Buffer,
  startedAt: number,
): void {
  // Parse JSON only AFTER the HMAC check has passed.
  let env: unknown;
  try {
    env = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'invalid json' }, raw.style);
    return;
  }

  // Preflight handshake — may arrive on any path; must be answered signed.
  if (isPreflightEnvelope(env)) {
    log.info('preflight received', { agent_id: (env as { agent_id?: string }).agent_id });
    const payload: PreflightResponse = { ok: true, protocolVersion: 'v1' };
    sendJson(res, 200, payload, raw.style);
    return;
  }

  const path = (req.url ?? '/').split('?')[0];
  if (path !== config.server.agentPath) {
    sendJson(res, 404, { error: 'not found' }, raw.style);
    return;
  }

  if (isGatekeeperEnvelope(env)) {
    handleGatekeeperTask(env, raw, startedAt).then((outcome) => {
      sendJson(res, outcome.status, outcome.payload, raw.style);
    }).catch((e) => {
      log.error('unhandled task error', { error: String((e as Error).message).slice(0, 200) });
      sendJson(res, 200, rejectResponse(ReasonCode.INTERNAL_ERROR, null), raw.style);
    });
    return;
  }

  // Signed, well-formed request of an unknown type — reject deterministically.
  sendJson(res, 200, rejectResponse(ReasonCode.UNSUPPORTED_TASK_TYPE, null), raw.style);
}

function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const startedAt = Date.now();

  // Hard response guard: never let a request hang past the internal deadline.
  const hardTimer = setTimeout(() => {
    if (!res.writableEnded) {
      log.error('hard deadline hit — sending timeout fallback', {});
      const payload = rejectResponse(ReasonCode.TIMEOUT_FALLBACK, null);
      try {
        sendJson(res, 200, payload, 'sha256');
      } catch { /* socket may be gone */ }
    }
  }, config.behaviour.internalDeadlineMs + 2000);
  hardTimer.unref();
  res.on('finish', () => clearTimeout(hardTimer));

  if (req.method !== 'POST') {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    res.statusCode = 405;
    res.end();
    return;
  }

  collectRawBody(req, (err, rawBody) => {
    if (err || !rawBody) {
      sendJson(res, 400, { error: 'bad request' }, 'sha256');
      return;
    }

    // Checklist: HMAC over RAW body BEFORE parsing JSON. Reject on mismatch.
    const sigHeader = req.headers['x-agent-games-signature'];
    const verify = verifyHmac(rawBody, Array.isArray(sigHeader) ? sigHeader[0] : sigHeader, config.hmacSecret);
    if (!verify.valid) {
      // The signature header VALUE is not a secret — log it to diagnose
      // format mismatches with the platform (hex vs base64 vs prefix).
      log.warn('signature verification FAILED — rejecting', {
        path: req.url,
        bytes: rawBody.length,
        receivedHeader: Array.isArray(sigHeader) ? sigHeader[0] : sigHeader,
        secretLength: config.hmacSecret.length,
      });
      res.statusCode = 401;
      signResponse(res, Buffer.from(JSON.stringify({ error: 'invalid signature' }), 'utf8'), 'sha256');
      return;
    }
    const raw: RawRequest = { rawBody, signatureHeader: undefined, style: verify.style ?? 'sha256' };
    route(req, res, raw, rawBody, startedAt);
  });
}

export function startServer(): void {
  setLogLevel(config.behaviour.logLevel);
  log.info('starting proof-gatekeeper agent', {
    agentPath: config.server.agentPath,
    expectedVkHash: config.circuit.expectedVkHash.slice(0, 12) + '…',
    requireFinalized: config.approvalRequireFinalized,
    kurierConfigured: Boolean(config.kurier.apiKey),
    taskIdFieldMode: config.taskIdFieldMode,
  });

  const useTls = Boolean(config.server.tlsCertPath && config.server.tlsKeyPath);
  const server = useTls
    ? https.createServer(
        {
          cert: fs.readFileSync(config.server.tlsCertPath!),
          key: fs.readFileSync(config.server.tlsKeyPath!),
        },
        onRequest,
      )
    : http.createServer(onRequest);

  server.requestTimeout = config.behaviour.taskDeadlineMs + 10000;
  server.headersTimeout = 20000;
  server.listen(config.server.port, config.server.host, () => {
    log.info('listening', {
      scheme: useTls ? 'https' : 'http',
      host: config.server.host,
      port: config.server.port,
    });
    if (!useTls) {
      log.warn('plain HTTP listener — put a TLS-terminating proxy in front for production', {});
    }
  });
}
