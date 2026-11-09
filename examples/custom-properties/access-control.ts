/**
 * Access-control property: only the admin may mint.
 *
 * `includeFailures: true` makes the property see failed calls too, so it can
 * require that non-admin callers are rejected with `TokenError::Unauthorized`.
 * Add the admin address to `generators.addresses` so it is also tried as a
 * caller (see soroban-testkit.config.json in this folder).
 */
import type { Property } from 'soroban-testkit';

export default [
  {
    name: 'only the admin can mint',
    function: 'mint',
    includeFailures: true,
    check: async (args, _result, ctx) => {
      const { result: admin } = await ctx.call('admin');
      if (args.caller === admin) return true; // the admin may mint (or fail for other reasons)
      if (
        ctx.outcome.kind === 'contract-error' &&
        ctx.outcome.name === 'TokenError::Unauthorized'
      ) {
        return true;
      }
      return `non-admin caller was not rejected (outcome: ${ctx.outcome.kind})`;
    },
  },
] satisfies Property[];
