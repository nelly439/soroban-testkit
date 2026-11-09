/**
 * A fake "token" contract for the custom-property examples in
 * `examples/custom-properties/` and the demo.
 *
 * It behaves correctly except for ONE planted defect: `mint` does not check
 * that the caller is the admin, which the access-control example property
 * detects.
 */
import { StrKey } from '@stellar/stellar-sdk';
import type { ContractSpec, TypeRef } from '../../src/spec/types.js';
import { fakeContractId, type FakeContract, type FakeHandler } from './server.js';

const t = (kind: TypeRef['kind']): TypeRef => ({ kind }) as TypeRef;
const err: TypeRef = { kind: 'udt', name: 'TokenError' };

/** The token admin (a fixed account). */
export const TOKEN_ADMIN = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x11));
/** Total supply reported by `total_supply()`. */
export const TOTAL_SUPPLY = 1_000_000n;
/** Starting balance of every account. */
export const TOKEN_START_BALANCE = 1000n;
const I128_MAX = 2n ** 127n - 1n;

/** Token interface. */
export const tokenSpec: ContractSpec = {
  functions: [
    { name: 'admin', doc: 'Returns the admin.', inputs: [], outputs: [t('address')] },
    { name: 'total_supply', doc: 'Returns the total supply.', inputs: [], outputs: [t('i128')] },
    {
      name: 'balance',
      doc: 'Returns the balance of `id`.',
      inputs: [{ name: 'id', type: t('address'), doc: '' }],
      outputs: [t('i128')],
    },
    {
      name: 'transfer',
      doc: 'Transfers `amount`; returns the sender balance after the transfer.',
      inputs: [
        { name: 'from', type: t('address'), doc: '' },
        { name: 'to', type: t('address'), doc: '' },
        { name: 'amount', type: t('i128'), doc: '' },
      ],
      outputs: [{ kind: 'result', ok: t('i128'), error: err }],
    },
    {
      name: 'mint',
      doc: 'Admin only: mints `amount` to `to`; returns the new balance of `to`.',
      inputs: [
        { name: 'caller', type: t('address'), doc: '' },
        { name: 'to', type: t('address'), doc: '' },
        { name: 'amount', type: t('i128'), doc: '' },
      ],
      outputs: [{ kind: 'result', ok: t('i128'), error: err }],
    },
  ],
  types: {
    TokenError: {
      kind: 'errorEnum',
      name: 'TokenError',
      doc: '',
      lib: '',
      cases: [
        { name: 'Unauthorized', value: 1, doc: '' },
        { name: 'NegativeAmount', value: 2, doc: '' },
        { name: 'InsufficientBalance', value: 3, doc: '' },
        { name: 'Overflow', value: 4, doc: '' },
      ],
    },
  },
  events: [],
};

const handlers: Record<string, FakeHandler> = {
  admin: () => ({ ok: TOKEN_ADMIN, cost: { cpu: 150_000 }, reads: ['Admin'] }),
  total_supply: () => ({ ok: TOTAL_SUPPLY, cost: { cpu: 150_000 }, reads: ['Supply'] }),
  balance: () => ({ ok: TOKEN_START_BALANCE, cost: { cpu: 200_000 }, reads: ['Balance'] }),
  transfer: ([, , amount]) => {
    const a = amount as bigint;
    if (a < 0n) return { contractError: 2 };
    if (a > TOKEN_START_BALANCE) return { contractError: 3 };
    return { ok: TOKEN_START_BALANCE - a, cost: { cpu: 500_000 }, writes: ['Balance'] };
  },
  // PLANTED BUG: `caller` is never compared with the admin.
  mint: ([, , amount]) => {
    const a = amount as bigint;
    if (a < 0n) return { contractError: 2 };
    if (a > I128_MAX - TOKEN_START_BALANCE) return { contractError: 4 };
    return { ok: TOKEN_START_BALANCE + a, cost: { cpu: 450_000 }, writes: ['Balance', 'Supply'] };
  },
};

/** Contract ID of the demo token on the fake RPC. */
export const TOKEN_ID = fakeContractId('demo-token');

/** The demo token contract. */
export const demoToken: FakeContract = { id: TOKEN_ID, spec: tokenSpec, handlers };
