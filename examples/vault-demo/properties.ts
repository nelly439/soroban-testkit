/**
 * Custom property for the vault demo: a transfer must never leave the sender
 * with a negative balance.
 */
import type { Property } from 'soroban-testkit';

export default [
  {
    name: 'balance after transfer is never negative',
    function: 'transfer',
    check: (_args, balanceAfter) => (balanceAfter as bigint) >= 0n,
  },
] satisfies Property[];
