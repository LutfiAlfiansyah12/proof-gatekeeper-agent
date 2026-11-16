/**
 * Wire types for the Proof Gatekeeper event, as published at
 * https://agentgames.zkverify.io/build.
 */

export const TASK_TYPE = 'agent-games.proof-gatekeeper.v1';
export const PREFLIGHT_TYPE = 'agent-games.preflight.v1';

export interface GatekeeperInput {
  registered_vk: string;
  proof_vk: string;
  minimum: string;
  public_balance: string;
  expiry_block: number | string;
  current_block: number | string;
  recipient: string;
  condition_recipient: string;
  amount: string;
  max_transfer: string;
  proof_tx: string;
}

export interface TaskEnvelope {
  type: string;
  task_id: string;
  mode: string;
  issued_at: string;
  deadline_at: string;
  input: GatekeeperInput;
  [k: string]: unknown;
}

export interface PreflightEnvelope {
  type: string;
  agent_id: string;
  issued_at: string;
  nonce: string;
  [k: string]: unknown;
}

export type Decision = 'APPROVE' | 'REJECT';

/**
 * reason_code enum. Only VK_SUBSTITUTION is named verbatim in the official
 * docs; the rest follow the same SCREAMING_SNAKE convention and are documented
 * here for the scorer (and for you, in practice-mode logs).
 */
export const ReasonCode = {
  APPROVED: 'APPROVED',

  // Checklist #6 — task signature/timestamp validity
  INVALID_TIMESTAMP: 'INVALID_TIMESTAMP',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',

  // Checklist #1/#2 — key and circuit identity
  VK_SUBSTITUTION: 'VK_SUBSTITUTION',
  CIRCUIT_MISMATCH: 'CIRCUIT_MISMATCH',

  // Checklist #4 — proof reference reuse
  PROOF_REUSED: 'PROOF_REUSED',

  // Checklist #3 — public inputs prove threshold/recipient/amount
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  AMOUNT_EXCEEDS_LIMIT: 'AMOUNT_EXCEEDS_LIMIT',
  RECIPIENT_MISMATCH: 'RECIPIENT_MISMATCH',
  CONDITION_EXPIRED: 'CONDITION_EXPIRED',

  // Checklist #5 — finalization before approval
  VERIFICATION_NOT_FINALIZED: 'VERIFICATION_NOT_FINALIZED',

  // Structural / fail-closed
  MALFORMED_TASK: 'MALFORMED_TASK',
  UNSUPPORTED_TASK_TYPE: 'UNSUPPORTED_TASK_TYPE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  TIMEOUT_FALLBACK: 'TIMEOUT_FALLBACK',
  CIRCUIT_REFUTED: 'CIRCUIT_REFUTED',
} as const;

export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

export interface GatekeeperResponse {
  decision: Decision;
  reason_code: ReasonCode;
  /** Present whenever a Groth16 proof was successfully generated. */
  proof?: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  };
  public_signals?: string[];
  /** Optional on-chain audit pointer (Kurier job / zkVerify tx). */
  proof_tx?: string;
}

export interface PreflightResponse {
  ok: true;
  protocolVersion: 'v1';
}

export function isGatekeeperEnvelope(x: unknown): x is TaskEnvelope {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.type === TASK_TYPE &&
    typeof o.task_id === 'string' &&
    typeof o.issued_at === 'string' &&
    typeof o.deadline_at === 'string' &&
    typeof o.input === 'object' &&
    o.input !== null
  );
}

export function isPreflightEnvelope(x: unknown): x is PreflightEnvelope {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.type === PREFLIGHT_TYPE && typeof o.nonce === 'string';
}
