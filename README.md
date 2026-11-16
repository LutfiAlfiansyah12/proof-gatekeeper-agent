# Proof Gatekeeper Agent — zkVerify Agent Games

A production-ready TypeScript (Node.js) agent for the **Proof Gatekeeper** event.
It is a public HTTPS endpoint the platform POSTs signed tasks to; it decides
APPROVE/REJECT deterministically, proves its decision locally with a Groth16
proof (snarkjs), optionally finalizes it on zkVerify via Kurier, and answers
with a signed response — always within the 60s platform deadline, always
failing closed.

## File structure

```
├── artifacts/                  # Official circuit artifacts (downloaded from /build)
│   ├── gatekeeper.wasm
│   ├── gatekeeper_final.zkey
│   └── circuit-info.json       # Authoritative vk_hash + artifact URLs
├── src/
│   ├── main.ts                 # Entry point
│   ├── server.ts               # HTTP(S) endpoint: routing, raw-body HMAC gate,
│   │                           #   preflight responder, 60s deadline, signing
│   ├── hmac.ts                 # HMAC-SHA256 sign/verify over RAW bytes
│   ├── config.ts               # Env-only configuration (secrets never hardcoded)
│   ├── engine.ts               # DETERMINISTIC decision engine (/build checklist)
│   ├── fields.ts               # Envelope -> BN254 field-element mapping
│   ├── prover.ts               # snarkjs proof generation + circuit cross-check
│   ├── kurier.ts               # Kurier REST submission, waits for Finalized
│   ├── reuse.ts                # Persistent proof-reference reuse store
│   ├── types.ts                # Wire schemas + reason_code enum
│   └── log.ts                  # Redacting structured logger
├── test/
│   ├── samples.ts              # Valid task + trap envelopes
│   └── harness.ts              # End-to-end local replay
└── .env.example                # Blank secrets — copy to .env and fill in
```

## Circuit interface (reverse-engineered from the official artifacts)

The published `gatekeeper.wasm` does not carry signal names (they live in the
unpublished `.sym` file), so the interface was discovered by probing the wasm's
input-signal hash table (FNV-1 64-bit, exactly like snarkjs's witness
calculator) and by constraint-failure experiments:

**Inputs** (13 field elements):

| signal | source in envelope |
|---|---|
| `registeredVkHash` | `input.registered_vk` (hex → BigInt mod r) |
| `proofVkHash` | `input.proof_vk` |
| `minimum` | `input.minimum` (decimal) |
| `publicBalance` | `input.public_balance` (decimal) |
| `expiryBlock` | `input.expiry_block` (decimal) |
| `currentBlock` | `input.current_block` (decimal) |
| `recipient` | `input.recipient` (hex → BigInt) |
| `conditionRecipient` | `input.condition_recipient` |
| `amount` | `input.amount` (decimal) |
| `maxTransfer` | `input.max_transfer` (decimal) |
| `taskId` | derived — see `TASKID_FIELD_MODE` (unconfirmed) |
| `decision` | 1 = approve, 0 = reject |
| `salt` | agent-chosen random 200-bit value |

**Public signals** = `[bindingHash, registeredVkHash, proofVkHash, minimum,
publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient,
amount, maxTransfer, decision, taskId]` where `bindingHash` is a
salt/task-dependent hash (proved to change with both).

**Referee semantics** (empirically verified against the real zkey):

| values | decision | witness |
|---|---|---|
| all checks pass | 1 | ✅ |
| all checks pass | 0 | ❌ Assert Failed (can't falsely reject a valid task) |
| any violation | 1 | ❌ Assert Failed (can't fake an approval) |
| any violation | 0 | ✅ |

Boundary semantics: approval requires `balance >= minimum`,
`amount <= maxTransfer`, **strict** `currentBlock < expiryBlock`,
`recipient == conditionRecipient`, and `decision ∈ {0,1}`.

`proof_tx` is NOT a circuit input — the reuse check (checklist #4) is enforced
in deterministic agent code (`src/reuse.ts`). A REJECT caused solely by proof
reuse cannot carry a proof; the agent answers without one.

## Setup

```bash
npm install
npm run build
cp .env.example .env   # then fill in AGENT_GAMES_HMAC_SECRET (Rotate Secret)
npm test               # local end-to-end harness (no secrets needed)
npm start              # production listener (put TLS in front, or set TLS_*)
```

### Required env vars (secrets — NEVER commit, NEVER paste into chat)

- `AGENT_GAMES_HMAC_SECRET` — dashboard → My Agents → **Rotate Secret**.
- `KURIER_API_KEY` — for on-chain finalization (APPROVE requires Finalized).
- Optional TLS cert paths for the built-in HTTPS listener.

## Registration / preflight flow

1. Register the **full handler path** exactly as configured (`AGENT_PATH`,
   default `/agent`) — the platform POSTs to the URL exactly as registered.
2. Rotate your secret, put it in `.env`, restart the agent.
3. Trigger preflight from the dashboard; the agent answers
   `{"ok":true,"protocolVersion":"v1"}` signed with
   `x-agent-games-signature`.
4. Use practice mode BEFORE scored rounds. Watch the logs for the
   `TASKID_FIELD_MODE` warning (see below).

## Known unknowns (validate in practice mode, adjust env)

- **task_id → field derivation.** The circuit has a `taskId` input but the
  docs don't publish the string→field convention. Default is
  `keccak256(utf8(task_id)) mod r`; alternatives: `digits`, `numeric`, `zero`.
  If the platform cross-checks public signal [12] against its own derivation,
  this must match — verify with a practice task.
- **Response HMAC header style.** Verification accepts `sha256=`, `v1=`, and
  bare hex; responses are signed in the same style the inbound request used
  (default `sha256=`).
- **Kurier job-status endpoint shape** (`/api/v1/jobs/{id}`) — adjust in
  `src/kurier.ts` if the response schema differs.

## Fail-closed behaviour

- Any error, timeout, or uncertainty ⇒ signed REJECT, never approve.
- Internal deadline = platform 60s minus a 4s margin; a pending pipeline is
  answered with `TIMEOUT_FALLBACK`.
- APPROVE requires Kurier **Finalized** (checklist #5) before responding;
  otherwise REJECT `VERIFICATION_NOT_FINALIZED`. (Disable with
  `APPROVAL_REQUIRE_FINALIZED=false` for local testing only.)
- If the circuit refutes an engine APPROVE (engine/circuit disagreement), the
  agent falls back to REJECT — the circuit is the referee.

## Scoring awareness

+12 correct decision, −6 trap approved, −3 valid rejected, −2 timeout/offline,
−2 proof fails verification, plus reliability bonus. The engine therefore
prefers an unverifiable REJECT (−2) over any chance of approving a trap (−6),
and every proof is locally re-verified with the exported verification key
before being sent.
