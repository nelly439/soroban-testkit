/**
 * The "vault" fake contracts used by the planted-bug end-to-end test and the
 * demo. Both share one interface; the BUGGY one carries exactly six planted
 * defects, one per built-in check:
 *
 * | function   | planted defect                                      | check that must catch it |
 * | ---------- | --------------------------------------------------- | ------------------------ |
 * | `div_by`   | traps when the i128 argument is 0                    | no-unexpected-trap       |
 * | `first`    | traps when the vec argument is empty                 | no-unexpected-trap       |
 * | `balance`  | "read-only" function writes to storage               | read-only                |
 * | `roll`     | returns a different value on repeated calls          | deterministic            |
 * | `compute`  | CPU cost is 40% above the clean version              | cost-regression          |
 * | `transfer` | sender balance can go negative                       | custom-property          |
 *
 * The CLEAN contract handles every one of those inputs correctly (declared
 * contract errors or `None`) and must produce zero findings.
 *
 * The same interface is implemented in Rust in `examples/rust-contracts/`
 * for the optional real-network integration test.
 */
import { createHash } from 'node:crypto';
import type { ContractSpec, TypeRef } from '../../src/spec/types.js';
import { fakeContractId, type FakeContract, type FakeHandler } from './server.js';

const t = (kind: TypeRef['kind']): TypeRef => ({ kind }) as TypeRef;

/** Interface shared by the clean and buggy vaults. */
export const vaultSpec: ContractSpec = {
  functions: [
    {
      name: 'div_by',
      doc: 'Returns 1_000_000 / amount.',
      inputs: [{ name: 'amount', type: t('i128'), doc: '' }],
      outputs: [{ kind: 'result', ok: t('i128'), error: { kind: 'udt', name: 'VaultError' } }],
    },
    {
      name: 'first',
      doc: 'Returns the first element, if any.',
      inputs: [{ name: 'items', type: { kind: 'vec', element: t('u32') }, doc: '' }],
      outputs: [{ kind: 'option', value: t('u32') }],
    },
    {
      name: 'balance',
      doc: 'Reads the balance of an account.',
      inputs: [{ name: 'who', type: t('address'), doc: '' }],
      outputs: [t('i128')],
    },
    {
      name: 'roll',
      doc: 'Derives a number from a salt.',
      inputs: [{ name: 'salt', type: t('u32'), doc: '' }],
      outputs: [t('u64')],
    },
    {
      name: 'compute',
      doc: 'Does some arithmetic.',
      inputs: [{ name: 'n', type: t('u32'), doc: '' }],
      outputs: [t('u64')],
    },
    {
      name: 'transfer',
      doc: 'Moves amount from `from` to `to`; returns the sender balance after the transfer. Every account starts with 1000.',
      inputs: [
        { name: 'from', type: t('address'), doc: '' },
        { name: 'to', type: t('address'), doc: '' },
        { name: 'amount', type: t('i128'), doc: '' },
      ],
      outputs: [{ kind: 'result', ok: t('i128'), error: { kind: 'udt', name: 'VaultError' } }],
    },
  ],
  types: {
    VaultError: {
      kind: 'errorEnum',
      name: 'VaultError',
      doc: 'Errors returned by the vault.',
      lib: '',
      cases: [
        { name: 'DivByZero', value: 1, doc: '' },
        { name: 'NegativeAmount', value: 2, doc: '' },
        { name: 'InsufficientBalance', value: 3, doc: '' },
      ],
    },
  },
  events: [],
};

/** Starting balance of every account. */
export const START_BALANCE = 1000n;

function rollValue(salt: number): bigint {
  return createHash('sha256').update(String(salt)).digest().readBigUInt64BE(0);
}

function computeCpu(n: number): number {
  return 1_000_000 + (n % 1000) * 100;
}

const cleanHandlers: Record<string, FakeHandler> = {
  div_by: ([amount]) =>
    amount === 0n
      ? { contractError: 1 }
      : { ok: 1_000_000n / (amount as bigint), cost: { cpu: 300_000 } },
  first: ([items]) => {
    const list = items as number[];
    return { ok: list.length === 0 ? null : list[0], cost: { cpu: 200_000 + list.length * 1000 } };
  },
  balance: () => ({ ok: START_BALANCE, cost: { cpu: 250_000 }, reads: ['Balance'] }),
  roll: ([salt]) => ({ ok: rollValue(salt as number), cost: { cpu: 400_000 } }),
  compute: ([n]) => ({ ok: BigInt(n as number) * 2n, cost: { cpu: computeCpu(n as number) } }),
  transfer: ([, , amount]) => {
    const a = amount as bigint;
    if (a < 0n) return { contractError: 2 };
    if (a > START_BALANCE) return { contractError: 3 };
    return { ok: START_BALANCE - a, cost: { cpu: 600_000 }, writes: ['Balance'] };
  },
};

const buggyHandlers: Record<string, FakeHandler> = {
  ...cleanHandlers,
  // BUG 1: no zero check, the division traps.
  div_by: ([amount]) =>
    amount === 0n
      ? { trap: 'attempt to divide by zero' }
      : { ok: 1_000_000n / (amount as bigint), cost: { cpu: 300_000 } },
  // BUG 2: unwraps the first element of an empty vec.
  first: ([items]) => {
    const list = items as number[];
    if (list.length === 0) return { trap: 'called `Option::unwrap()` on a `None` value' };
    return { ok: list[0], cost: { cpu: 200_000 + list.length * 1000 } };
  },
  // BUG 3: a getter that also writes (e.g. "touches" a TTL / last-seen entry).
  balance: () => ({
    ok: START_BALANCE,
    cost: { cpu: 250_000 },
    reads: ['Balance'],
    writes: ['LastSeen'],
  }),
  // BUG 4: depends on hidden mutable state, so repeated calls differ.
  roll: ([salt], ctx) => ({
    ok: rollValue(salt as number) + BigInt(ctx.callCount),
    cost: { cpu: 400_000 },
  }),
  // BUG 5: 40% more CPU than the clean version.
  compute: ([n]) => ({
    ok: BigInt(n as number) * 2n,
    cost: { cpu: Math.round(computeCpu(n as number) * 1.4) },
  }),
  // BUG 6: missing balance check; the sender balance can go negative.
  transfer: ([, , amount]) => {
    const a = amount as bigint;
    if (a < 0n) return { contractError: 2 };
    return { ok: START_BALANCE - a, cost: { cpu: 600_000 }, writes: ['Balance'] };
  },
};

/** Contract ID of the clean vault on the fake RPC. */
export const CLEAN_VAULT_ID = fakeContractId('clean-vault');
/** Contract ID of the buggy vault on the fake RPC. */
export const BUGGY_VAULT_ID = fakeContractId('buggy-vault');

/** The clean vault. */
export const cleanVault: FakeContract = {
  id: CLEAN_VAULT_ID,
  spec: vaultSpec,
  handlers: cleanHandlers,
};
/** The buggy vault (six planted defects). */
export const buggyVault: FakeContract = {
  id: BUGGY_VAULT_ID,
  spec: vaultSpec,
  handlers: buggyHandlers,
};

/** The six planted defects, as the e2e test expects them to be reported. */
export const PLANTED_DEFECTS = [
  { check: 'no-unexpected-trap', fn: 'div_by' },
  { check: 'no-unexpected-trap', fn: 'first' },
  { check: 'read-only', fn: 'balance' },
  { check: 'deterministic', fn: 'roll' },
  { check: 'cost-regression', fn: 'compute' },
  { check: 'custom-property', fn: 'transfer' },
] as const;
