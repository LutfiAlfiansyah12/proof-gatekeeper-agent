/**
 * Mapping from envelope values to BN254 field elements for the gatekeeper
 * circuit.
 *
 * Circuit interface (discovered from the published gatekeeper.wasm — see
 * README "Circuit interface"):
 *   inputs : registeredVkHash, proofVkHash, minimum, publicBalance,
 *            expiryBlock, currentBlock, recipient, conditionRecipient,
 *            amount, maxTransfer, taskId, decision, salt
 *   outputs (public signals): [bindingHash, ...same 11 fields..., decision,
 *            taskId]
 *
 * Value conventions used here:
 *   - decimal strings / numbers  -> decimal BigInt   (minimum, balances,
 *     amounts, blocks)
 *   - hex strings                -> BigInt(hex) mod r (VK hashes, addresses)
 *   - task_id (string "gk_...")  -> configurable derivation (TASKID_FIELD_MODE)
 *   - salt                       -> random per task (makes every proof unique;
 *     the platform never sees it except via the binding hash public signal)
 */
import * as crypto from 'node:crypto';
import { keccak256 } from 'js-sha3';
import { config } from './config.js';
import type { GatekeeperInput } from './types.js';

export const BN254_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function modR(v: bigint): string {
  const r = ((v % BN254_R) + BN254_R) % BN254_R;
  return r.toString();
}

/** Decimal or numeric JSON value -> field (decimal). */
function decimalField(v: string | number, name: string): string {
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) {
    throw new Error(`field "${name}" is not a decimal value: ${JSON.stringify(String(v).slice(0, 40))}`);
  }
  return modR(BigInt(s));
}

/** Hex string (0x-prefixed) -> field. Values wider than r are reduced mod r. */
function hexField(v: string, name: string): string {
  const s = v.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error(`field "${name}" is not a hex value`);
  }
  return modR(BigInt('0x' + s));
}

/**
 * task_id -> field. The official docs do not pin down this derivation;
 * TASKID_FIELD_MODE selects the strategy. keccak256 of the UTF-8 string,
 * reduced mod r, is the default (EVM-ecosystem convention).
 */
export function taskIdField(taskId: string): string {
  switch (config.taskIdFieldMode) {
    case 'numeric': {
      if (!/^\d+$/.test(taskId)) {
        throw new Error('TASKID_FIELD_MODE=numeric but task_id is not a decimal integer');
      }
      return modR(BigInt(taskId));
    }
    case 'digits': {
      const digits = taskId.replace(/\D+/g, '');
      if (digits === '') throw new Error('task_id contains no digits');
      return modR(BigInt(digits));
    }
    case 'zero':
      return '0';
    case 'keccak':
    default: {
      // keccak256 (not sha3-256) — EVM standard.
      return modR(BigInt('0x' + keccak256(taskId)));
    }
  }
}

export function newSalt(): string {
  // 200-bit random salt, comfortably inside the field.
  return ('0x' + crypto.randomBytes(25).toString('hex')) as string;
}

export interface CircuitFields {
  registeredVkHash: string;
  proofVkHash: string;
  minimum: string;
  publicBalance: string;
  expiryBlock: string;
  currentBlock: string;
  recipient: string;
  conditionRecipient: string;
  amount: string;
  maxTransfer: string;
  taskId: string;
  decision: string;
  salt: string;
}

/**
 * Parse the envelope input into raw semantic values (BigInts, before any
 * field arithmetic). Throws on malformed values — caller maps this to
 * MALFORMED_TASK (fail closed).
 */
export interface ParsedInput {
  registeredVk: bigint;
  proofVk: bigint;
  minimum: bigint;
  publicBalance: bigint;
  expiryBlock: bigint;
  currentBlock: bigint;
  recipient: bigint;
  conditionRecipient: bigint;
  amount: bigint;
  maxTransfer: bigint;
  proofTx: string;
  taskId: string;
}

export function parseInput(input: GatekeeperInput, taskId: string): ParsedInput {
  const hexOrDec = (v: string | number, name: string): bigint => {
    const s = String(v).trim();
    if (/^0x[0-9a-fA-F]+$/.test(s) || /^[0-9a-fA-F]{8,}$/.test(s)) {
      return BigInt('0x' + s.replace(/^0x/i, ''));
    }
    if (/^-?\d+$/.test(s)) return BigInt(s);
    throw new Error(`cannot interpret "${name}"`);
  };
  const dec = (v: string | number, name: string): bigint => {
    const s = String(v).trim();
    if (!/^-?\d+$/.test(s)) throw new Error(`"${name}" is not decimal`);
    return BigInt(s);
  };
  return {
    registeredVk: hexOrDec(input.registered_vk, 'registered_vk'),
    proofVk: hexOrDec(input.proof_vk, 'proof_vk'),
    minimum: dec(input.minimum, 'minimum'),
    publicBalance: dec(input.public_balance, 'public_balance'),
    expiryBlock: dec(input.expiry_block, 'expiry_block'),
    currentBlock: dec(input.current_block, 'current_block'),
    recipient: hexOrDec(input.recipient, 'recipient'),
    conditionRecipient: hexOrDec(input.condition_recipient, 'condition_recipient'),
    amount: dec(input.amount, 'amount'),
    maxTransfer: dec(input.max_transfer, 'max_transfer'),
    proofTx: String(input.proof_tx),
    taskId,
  };
}

/**
 * Build the full circuit input object for snarkjs.
 * `approve` selects the decision bit — the circuit itself refuses a witness
 * when the decision does not follow from the values (that's the referee).
 */
export function buildCircuitInput(p: ParsedInput, approve: boolean, salt: string): Record<string, string> {
  return {
    registeredVkHash: modR(p.registeredVk),
    proofVkHash: modR(p.proofVk),
    minimum: p.minimum.toString(),
    publicBalance: p.publicBalance.toString(),
    expiryBlock: p.expiryBlock.toString(),
    currentBlock: p.currentBlock.toString(),
    recipient: modR(p.recipient),
    conditionRecipient: modR(p.conditionRecipient),
    amount: p.amount.toString(),
    maxTransfer: p.maxTransfer.toString(),
    taskId: taskIdField(p.taskId),
    decision: approve ? '1' : '0',
    salt: modR(BigInt(salt)),
  };
}
