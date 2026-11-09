/**
 * Read-only getters must write nothing and return the same value when called
 * again with the same arguments.
 *
 * `ctx.call` always runs a fresh simulation, so this really re-reads.
 */
import type { Property } from 'soroban-testkit';

const same = (a: unknown, b: unknown): boolean => a === b;

export default [
  {
    name: 'reads are idempotent and write nothing',
    function: ['admin', 'total_supply', 'balance'],
    check: async (args, result, ctx) => {
      const writes = ctx.resources?.writeEntries ?? 0;
      if (writes > 0) return `a read wrote ${writes} ledger entr${writes === 1 ? 'y' : 'ies'}`;
      const again = await ctx.call(ctx.function, args);
      return (
        same(again.result, result) ||
        `second read returned ${String(again.result)}, first ${String(result)}`
      );
    },
  },
] satisfies Property[];
