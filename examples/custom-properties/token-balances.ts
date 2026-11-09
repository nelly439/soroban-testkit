/**
 * Token balance properties.
 *
 * Run against the demo token (see docs/custom-properties.md):
 *   node dist/cli.js fuzz <TOKEN_ID> --rpc-url http://127.0.0.1:8787 \
 *     --config examples/custom-properties/soroban-testkit.config.json
 */
import type { Property } from 'soroban-testkit';

export default [
  {
    name: 'sender balance after transfer is never negative',
    function: 'transfer',
    // `transfer` returns Result<i128, TokenError>; properties receive the Ok value.
    check: (_args, balanceAfter) => (balanceAfter as bigint) >= 0n,
  },
  {
    name: 'no balance exceeds the total supply',
    function: 'balance',
    check: async (_args, balance, ctx) => {
      const { result: supply } = await ctx.call('total_supply');
      if ((balance as bigint) <= (supply as bigint)) return true;
      return `balance ${String(balance)} is larger than the total supply ${String(supply)}`;
    },
  },
] satisfies Property[];
