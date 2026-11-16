/**
 * Sample envelopes for the local harness — one valid task plus the classic
 * traps, each built from the envelope schema in the official /build spec.
 *
 * Test HMAC secret: used ONLY locally by the harness; never a production
 * secret. The real secret comes from the dashboard's Rotate Secret.
 */
import * as crypto from 'node:crypto';

export const TEST_SECRET = 'local-harness-test-secret-do-not-use-in-production';

export const VALID_VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

export interface SampleSpec {
  name: string;
  expectDecision: 'APPROVE' | 'REJECT';
  expectReason?: string;
  /** tamper body AFTER signing so the signature check must fail */
  tamperSignature?: boolean;
  omitSignature?: boolean;
  build: () => Record<string, unknown>;
}

function envelope(overrides: {
  task_id?: string;
  issuedOffsetMs?: number;
  deadlineOffsetMs?: number;
  input?: Record<string, unknown>;
}) {
  const now = Date.now();
  const taskId = overrides.task_id ?? `gk_${Math.random().toString(16).slice(2, 10)}`;
  // Deterministic per-task proof_tx so each sample has a distinct reference.
  const proofTx =
    '0x' +
    crypto.createHash('sha256').update(`proof-tx:${taskId}`).digest('hex');
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: taskId,
    mode: 'competition',
    issued_at: new Date(now + (overrides.issuedOffsetMs ?? -2000)).toISOString(),
    deadline_at: new Date(now + (overrides.deadlineOffsetMs ?? 55000)).toISOString(),
    input: {
      registered_vk: VALID_VK,
      proof_vk: VALID_VK,
      minimum: '1000',
      public_balance: '1460',
      expiry_block: 8430000,
      current_block: 8420000,
      recipient: '0xDe4219e1a2B34C8f01AbC56789De42F9Ef019f01',
      condition_recipient: '0xDe4219e1a2B34C8f01AbC56789De42F9Ef019f01',
      amount: '500',
      max_transfer: '1000',
      proof_tx: proofTx,
      ...overrides.input,
    },
  };
}

export const SAMPLES: SampleSpec[] = [
  {
    name: 'preflight',
    expectDecision: 'APPROVE',
    build: () => ({
      type: 'agent-games.preflight.v1',
      agent_id: 'agt_test',
      issued_at: new Date().toISOString(),
      nonce: 'abc123',
    }),
  },
  {
    name: 'valid transfer — expect APPROVE',
    expectDecision: 'APPROVE',
    build: () => envelope({ task_id: 'gk_valid_01' }),
  },
  {
    name: 'proof reuse trap (replays gk_valid_01 proof_tx) — expect REJECT',
    expectDecision: 'REJECT',
    expectReason: 'PROOF_REUSED',
    build: () => {
      const env = envelope({ task_id: 'gk_trap_reuse_01' }) as { input: Record<string, unknown> };
      // Steal the reference already consumed by gk_valid_01 in the same run.
      const stolen = '0x' + crypto.createHash('sha256').update('proof-tx:gk_valid_01').digest('hex');
      env.input.proof_tx = stolen;
      return env;
    },
  },
  {
    name: 'VK substitution trap — expect REJECT',
    expectDecision: 'REJECT',
    expectReason: 'VK_SUBSTITUTION',
    build: () =>
      envelope({
        task_id: 'gk_trap_vk_01',
        input: { proof_vk: '0x1313131313131313131313131313131313131313131313131313131313131313' },
      }),
  },
  {
    name: 'unregistered circuit vk — expect REJECT',
    expectDecision: 'REJECT',
    expectReason: 'CIRCUIT_MISMATCH',
    build: () =>
      envelope({
        task_id: 'gk_trap_circuit_01',
        input: {
          registered_vk: '0x2222222222222222222222222222222222222222222222222222222222222222',
          proof_vk: '0x2222222222222222222222222222222222222222222222222222222222222222',
        },
      }),
  },
  {
    name: 'insufficient balance — expect REJECT',
    expectDecision: 'REJECT',
    expectReason: 'INSUFFICIENT_BALANCE',
    build: () =>
      envelope({
        task_id: 'gk_trap_balance_01',
        input: { public_balance: '500' },
      }),
  },
  {
    name: 'recipient mismatch — expect REJECT',
    expectDecision: 'REJECT',
    expectReason: 'RECIPIENT_MISMATCH',
    build: () =>
      envelope({
        task_id: 'gk_trap_recipient_01',
        input: { condition_recipient: '0x000000000000000000000000000000000000dEaD' },
      }),
  },
  {
    name: 'amount exceeds limit — expect REJECT',
    expectDecision: 'REJECT',
    expectReason: 'AMOUNT_EXCEEDS_LIMIT',
    build: () =>
      envelope({
        task_id: 'gk_trap_amount_01',
        input: { amount: '1500' },
      }),
  },
  {
    name: 'condition expired (current >= expiry) — expect REJECT',
    expectDecision: 'REJECT',
    expectReason: 'CONDITION_EXPIRED',
    build: () =>
      envelope({
        task_id: 'gk_trap_expiry_01',
        input: { current_block: 8430000 },
      }),
  },
  {
    name: 'stale task (issued in the future skew) — expect REJECT',
    expectDecision: 'REJECT',
    expectReason: 'INVALID_TIMESTAMP',
    build: () => envelope({ task_id: 'gk_trap_time_01', issuedOffsetMs: 9999 * 1000 }),
  },
  {
    name: 'deadline passed — expect REJECT',
    expectDecision: 'REJECT',
    expectReason: 'DEADLINE_EXCEEDED',
    build: () => envelope({ task_id: 'gk_trap_deadline_01', deadlineOffsetMs: -5000 }),
  },
  {
    name: 'tampered body — expect 401',
    expectDecision: 'REJECT',
    tamperSignature: true,
    build: () => envelope({ task_id: 'gk_trap_tamper_01' }),
  },
  {
    name: 'missing signature header — expect 401',
    expectDecision: 'REJECT',
    omitSignature: true,
    build: () => envelope({ task_id: 'gk_trap_nosig_01' }),
  },
];
