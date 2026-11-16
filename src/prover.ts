/**
 * Local Groth16 proof generation with snarkjs, plus the "circuit cross-check".
 *
 * The circuit is the referee: it refuses a witness whenever `decision` does
 * not follow from the values (verified empirically, see README). So:
 *  - engine says APPROVE  -> witness(decision=1) must succeed; if it somehow
 *    fails, we fall back to REJECT/CIRCUIT_REFUTED (fail closed).
 *  - engine says REJECT (circuit-visible reason) -> witness(decision=0)
 *    succeeds and the proof proves the rejection.
 *  - engine says REJECT (off-circuit reason, e.g. PROOF_REUSED, timestamps)
 *    -> witness likely unsatisfiable; we answer WITHOUT a proof.
 */
import * as snarkjs from 'snarkjs';
import { config } from './config.js';
import { log } from './log.js';
import { buildCircuitInput, newSalt, type ParsedInput } from './fields.js';
import type { GatekeeperResponse } from './types.js';

export interface ProofArtifacts {
  proof: GatekeeperResponse['proof'];
  publicSignals: string[];
}

export interface ProveOutcome {
  /** Decision the circuit was able to witness (APPROVE/REJECT), or null. */
  witnessedDecision: 'APPROVE' | 'REJECT' | null;
  artifacts?: ProofArtifacts;
}

async function tryWitness(
  parsed: ParsedInput,
  approve: boolean,
  salt: string,
): Promise<ProofArtifacts | null> {
  const input = buildCircuitInput(parsed, approve, salt);
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      config.circuit.wasmPath,
      config.circuit.zkeyPath,
    );
    // Defensive: sanity-verify locally before ever shipping a proof.
    const vk = await loadVerificationKey();
    if (vk) {
      const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
      if (!ok) {
        log.error('local verification of freshly generated proof FAILED', {});
        return null;
      }
    }
    return {
      proof: {
        pi_a: proof.pi_a.map(String),
        pi_b: (proof.pi_b as string[][]).map((row) => row.map(String)),
        pi_c: proof.pi_c.map(String),
        protocol: String(proof.protocol),
        curve: String(proof.curve),
      },
      publicSignals: publicSignals.map(String),
    };
  } catch (e) {
    // Witness computation failure = the circuit refuses this (decision, values)
    // combination. That is expected referee behaviour, not an internal error.
    log.debug('witness attempt refused by circuit', {
      approve,
      error: String((e as Error).message).split('\n')[0],
    });
    return null;
  }
}

let cachedVk: object | null | undefined;

async function loadVerificationKey(): Promise<object | null> {
  if (cachedVk !== undefined) return cachedVk;
  try {
    cachedVk = (await snarkjs.zKey.exportVerificationKey(config.circuit.zkeyPath)) as object;
  } catch (e) {
    log.warn('could not export verification key for local re-verify', {
      error: String((e as Error).message),
    });
    cachedVk = null;
  }
  return cachedVk;
}

/**
 * Attempt to produce proof artifacts for the engine's decision, with the
 * circuit cross-check fallback described above.
 */
export async function proveDecision(
  parsed: ParsedInput,
  engineDecision: 'APPROVE' | 'REJECT',
): Promise<ProveOutcome> {
  const salt = newSalt();

  const primary = await tryWitness(parsed, engineDecision === 'APPROVE', salt);
  if (primary) {
    return { witnessedDecision: engineDecision, artifacts: primary };
  }

  if (engineDecision === 'APPROVE') {
    // The circuit REFUTED an approval the engine would have made. The engine
    // and circuit disagree on boundary semantics — the circuit is the referee,
    // so the true decision is REJECT; try to prove it.
    log.warn('circuit refuted engine APPROVE — falling back to REJECT', {
      task_id: parsed.taskId,
    });
    const rejectProof = await tryWitness(parsed, false, salt);
    if (rejectProof) return { witnessedDecision: 'REJECT', artifacts: rejectProof };
    return { witnessedDecision: null };
  }

  // REJECT: if the rejection reason is off-circuit (reuse, timestamps, …) the
  // circuit may be unsatisfiable for decision=0 too. Answer without a proof.
  return { witnessedDecision: null };
}

export async function localVerify(
  publicSignals: string[],
  proof: NonNullable<GatekeeperResponse['proof']>,
): Promise<boolean> {
  const vk = await loadVerificationKey();
  if (!vk) return false;
  try {
    return await snarkjs.groth16.verify(vk, publicSignals, proof as never);
  } catch {
    return false;
  }
}
