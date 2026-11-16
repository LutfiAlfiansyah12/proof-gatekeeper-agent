/**
 * The deterministic decision engine — the final safety decision is made HERE,
 * in plain deterministic code, never by a language model.
 *
 * It implements the /build Security checklist:
 *  1. The verification key matches the key registered for this condition.
 *  2. The circuit and proof system are the ones the task expects.
 *  3. Public inputs prove the required threshold, recipient, and action.
 *  4. The proof reference has not already been used for another task.
 *  5. The verification reached a finalized state before approval.
 *  6. The task signature and timestamp are valid before any work begins.
 *  7. Every response is signed with x-agent-games-signature (server layer).
 *  8. The HMAC secret matches Rotate Secret (config layer).
 *
 * Rules are evaluated in a fixed order; the FIRST failing rule determines the
 * reason_code. Anything unexpected => REJECT (fail closed).
 */
import { config } from './config.js';
import { parseInput, type ParsedInput } from './fields.js';
import { ReasonCode, type Decision, type TaskEnvelope } from './types.js';
import type { ReuseStore } from './reuse.js';

export interface EngineContext {
  /** HMAC over the raw body already verified by the server layer. */
  signatureValid: boolean;
  now: Date;
}

export interface EngineOutcome {
  decision: Decision;
  reasonCode: ReasonCode;
  parsed?: ParsedInput;
  /** true when the circuit can witness this decision (proof worth attempting). */
  circuitWitnessable: boolean;
}

function parseDateSafe(s: unknown): Date | null {
  if (typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function evaluate(
  env: TaskEnvelope,
  ctx: EngineContext,
  reuse: ReuseStore,
): EngineOutcome {
  const fail = (reasonCode: ReasonCode, circuitWitnessable = false): EngineOutcome => ({
    decision: 'REJECT',
    reasonCode,
    circuitWitnessable,
  });

  // ── Checklist #6: task signature and timestamp, BEFORE any work ──────────
  if (!ctx.signatureValid) return fail(ReasonCode.MALFORMED_TASK);

  const issued = parseDateSafe(env.issued_at);
  const deadline = parseDateSafe(env.deadline_at);
  if (!issued || !deadline) return fail(ReasonCode.INVALID_TIMESTAMP);
  const skewMs = config.behaviour.clockSkewSeconds * 1000;
  const now = ctx.now.getTime();
  // issued_at may legitimately differ by the clock skew; a passed deadline
  // is unambiguous — allow only a tiny grace (5s) and fail closed.
  const deadlineGraceMs = Math.min(skewMs, 5000);
  if (issued.getTime() - skewMs > now) return fail(ReasonCode.INVALID_TIMESTAMP);
  if (deadline.getTime() < now - deadlineGraceMs) return fail(ReasonCode.DEADLINE_EXCEEDED);

  // ── Structural validation (fail closed on anything malformed) ────────────
  let p: ParsedInput;
  try {
    p = parseInput(env.input, env.task_id);
  } catch {
    return fail(ReasonCode.MALFORMED_TASK);
  }

  // ── Checklist #1: proof_vk must equal the registered key ─────────────────
  // (the only reason_code named verbatim in the official docs)
  if (p.proofVk !== p.registeredVk) return fail(ReasonCode.VK_SUBSTITUTION, true);

  // ── Checklist #2: the condition must be the gatekeeper circuit we hold ───
  if (p.registeredVk.toString(16) !== BigInt(config.circuit.expectedVkHash).toString(16)) {
    return fail(ReasonCode.CIRCUIT_MISMATCH, true);
  }

  // ── Checklist #4: proof reference must not be reused ─────────────────────
  // NOTE: proof_tx is NOT a circuit input, so a reuse-rejection cannot carry a
  // proof (circuitRefuted handling in prover.ts).
  const proofTxKey = p.proofTx.trim().toLowerCase();
  if (proofTxKey && reuse.hasSeen(proofTxKey)) return fail(ReasonCode.PROOF_REUSED);

  // ── Checklist #3: threshold, recipient, amount — mirror the circuit ──────
  // Boundary semantics match the circuit probes (see README):
  //   approve requires: balance >= minimum, amount <= maxTransfer,
  //                     currentBlock < expiryBlock (STRICT),
  //                     recipient equality.
  if (p.publicBalance < p.minimum) return fail(ReasonCode.INSUFFICIENT_BALANCE, true);
  if (p.amount > p.maxTransfer) return fail(ReasonCode.AMOUNT_EXCEEDS_LIMIT, true);
  if (p.recipient !== p.conditionRecipient) return fail(ReasonCode.RECIPIENT_MISMATCH, true);
  if (p.currentBlock >= p.expiryBlock) return fail(ReasonCode.CONDITION_EXPIRED, true);

  // ── All checks passed ─────────────────────────────────────────────────────
  // (checklist #5 — finalization — is enforced by the server/prover layer
  // before an APPROVE is returned)
  return { decision: 'APPROVE', reasonCode: ReasonCode.APPROVED, parsed: p, circuitWitnessable: true };
}
