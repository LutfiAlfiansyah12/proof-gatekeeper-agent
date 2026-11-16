/**
 * zkVerify submission via Kurier (REST), per the /build page:
 *
 *   POST {KURIER_URL}/api/v1/submit-proof/{KURIER_API_KEY}
 *   {
 *     proofType: "groth16",
 *     vkRegistered: true,
 *     proofOptions: { library: "snarkjs", curve: "bn128" },
 *     proofData: { proof, publicSignals, vk: <registered vk hash> }
 *   }
 *
 * Job states: Submitted -> IncludedInBlock -> Finalized.
 * Checklist #5: we only treat a proof as confirmed once it is Finalized.
 */
import { config } from './config.js';
import { log } from './log.js';

export interface KurierResult {
  finalized: boolean;
  /** On-chain audit pointer (job id / tx reference), when available. */
  reference?: string;
}

const JOB_TERMINAL = new Set(['Finalized', 'Failed', 'Rejected']);

interface SubmitResponse {
  jobId?: string;
  jobID?: string;
  uid?: string;
  status?: string;
  [k: string]: unknown;
}

interface StatusResponse {
  status?: string;
  state?: string;
  txHash?: string;
  tx_hash?: string;
  jobId?: string;
  [k: string]: unknown;
}

function extractJobId(body: SubmitResponse): string | undefined {
  return body.jobId ?? body.jobID ?? body.uid ?? (typeof body.job === 'string' ? body.job : undefined);
}

function extractStatus(body: StatusResponse): string | undefined {
  return body.status ?? body.state;
}

function extractTxRef(body: StatusResponse, jobId?: string): string | undefined {
  const tx = body.txHash ?? body.tx_hash;
  return tx ?? jobId;
}

export async function submitAndAwaitFinalization(
  proof: Record<string, unknown>,
  publicSignals: string[],
  budgetMs: number,
  startedAt: number,
): Promise<KurierResult> {
  const apiKey = config.kurier.apiKey;
  if (!apiKey) {
    log.warn('KURIER_API_KEY not set — skipping on-chain submission');
    return { finalized: false };
  }

  const remaining = () => budgetMs - (Date.now() - startedAt);
  if (remaining() <= 2000) return { finalized: false };

  const url = `${config.kurier.url}/api/v1/submit-proof/${encodeURIComponent(apiKey)}`;
  const body = {
    proofType: 'groth16',
    vkRegistered: true,
    proofOptions: { library: 'snarkjs', curve: 'bn128' },
    proofData: {
      proof,
      publicSignals,
      vk: config.circuit.expectedVkHash,
    },
  };

  let jobId: string | undefined;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(remaining() - 500, 15000)),
    });
    if (!res.ok) {
      log.warn('kurier submit failed', { status: res.status });
      return { finalized: false };
    }
    const json = (await res.json()) as SubmitResponse;
    jobId = extractJobId(json);
    log.info('kurier job submitted', { jobId });
  } catch (e) {
    log.warn('kurier submit error', { error: String((e as Error).message).slice(0, 120) });
    return { finalized: false };
  }

  // Poll until Finalized or budget exhausted.
  while (remaining() > 1000) {
    await new Promise((r) => setTimeout(r, config.kurier.pollIntervalMs));
    try {
      const statusUrl = `${config.kurier.url}/api/v1/jobs/${encodeURIComponent(jobId ?? '')}`;
      const res = await fetch(statusUrl, {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(Math.min(remaining() - 500, 10000)),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as StatusResponse;
      const status = extractStatus(json);
      if (status && JOB_TERMINAL.has(status)) {
        if (status === 'Finalized') {
          log.info('kurier job finalized', { jobId });
          return { finalized: true, reference: extractTxRef(json, jobId) };
        }
        log.warn('kurier job reached terminal failure', { jobId, status });
        return { finalized: false, reference: jobId };
      }
    } catch {
      // Transient network error — keep polling until budget exhausted.
    }
  }
  log.warn('kurier finalization budget exhausted', { jobId });
  return { finalized: false, reference: jobId };
}
