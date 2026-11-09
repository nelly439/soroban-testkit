import { describe, expect, it } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import {
  budgetCheck,
  caseChecksFor,
  describeLedgerKey,
  deterministic,
  noUnexpectedTrap,
  propertyCheck,
  readOnly,
  type Invocation,
} from '../../src/checks/checks.js';
import {
  defineProperties,
  propertyApplies,
  validateProperties,
  type Property,
} from '../../src/checks/properties.js';
import { resolveConfig } from '../../src/config/config.js';
import type { Outcome, Resources, SimulationResult } from '../../src/rpc/outcome.js';
import { toScVal } from '../../src/generate/scval.js';
import { ConfigError } from '../../src/errors.js';
import { vaultSpec } from '../fake-rpc/contracts.js';

const spec = vaultSpec;
const transfer = spec.functions.find((f) => f.name === 'transfer')!;

const res = (over: Partial<Resources> = {}): Resources => ({
  cpuInstructions: 100,
  memoryBytes: 50,
  readEntries: 1,
  writeEntries: 0,
  readBytes: 10,
  writeBytes: 0,
  minResourceFee: '100',
  writeFootprint: [],
  ...over,
});

const ok = (n: bigint): Outcome => ({
  kind: 'success',
  retvalXdr: toScVal({ kind: 'i128' }, n, spec).toXdr('base64'),
});

function inv(
  outcome: Outcome,
  resources: Resources | null = res(),
  args: unknown[] = ['GA', 'GB', 5n],
): Invocation {
  return { fn: transfer, args, argsXdr: [], result: { outcome, resources, latestLedger: 1 } };
}

const ctx = (second?: SimulationResult) => ({
  spec,
  reinvoke: async () => second ?? { outcome: ok(1n), resources: res(), latestLedger: 1 },
});

describe('no-unexpected-trap', () => {
  it('fails only on traps', async () => {
    expect(await noUnexpectedTrap.evaluate(inv(ok(1n)), ctx())).toBeNull();
    expect(
      await noUnexpectedTrap.evaluate(
        inv({ kind: 'contract-error', code: 1, name: 'E', message: '' }),
        ctx(),
      ),
    ).toBeNull();
    expect(
      await noUnexpectedTrap.evaluate(inv({ kind: 'simulation-failed', message: 'x' }), ctx()),
    ).toBeNull();
    const v = await noUnexpectedTrap.evaluate(
      inv({ kind: 'trap', error: 'WasmVm, InvalidAction', message: 'm' }),
      ctx(),
    );
    expect(v?.message).toBe('trapped with Error(WasmVm, InvalidAction)');
  });
});

describe('deterministic', () => {
  it('passes identical results', async () => {
    expect(await deterministic.evaluate(inv(ok(1n)), ctx())).toBeNull();
  });
  it('fails when the return value differs', async () => {
    const v = await deterministic.evaluate(
      inv(ok(1n)),
      ctx({ outcome: ok(2n), resources: res(), latestLedger: 1 }),
    );
    expect(v?.message).toBe('two simulations of the same input gave different results');
    expect(v?.details).toEqual({ first: 'returned 1', second: 'returned 2' });
  });
  it('fails when the outcome kind differs', async () => {
    const v = await deterministic.evaluate(
      inv(ok(1n)),
      ctx({
        outcome: {
          kind: 'contract-error',
          code: 3,
          name: 'VaultError::InsufficientBalance',
          message: '',
        },
        resources: null,
        latestLedger: 1,
      }),
    );
    expect(v?.details?.second).toBe('failed with VaultError::InsufficientBalance (#3)');
    const t = await deterministic.evaluate(
      inv({ kind: 'trap', error: 'A, B', message: '' }, null),
      ctx({ outcome: ok(1n), resources: res(), latestLedger: 1 }),
    );
    expect(t?.details).toEqual({ first: 'trapped with Error(A, B)', second: 'returned 1' });
    const sf = await deterministic.evaluate(
      inv({ kind: 'trap', error: 'A, B', message: '' }, null),
      ctx({
        outcome: { kind: 'simulation-failed', message: 'z' },
        resources: null,
        latestLedger: 1,
      }),
    );
    expect(sf).toBeNull();
  });
  it('fails when resources differ, ignoring fees', async () => {
    const v = await deterministic.evaluate(
      inv(ok(1n)),
      ctx({ outcome: ok(1n), resources: res({ cpuInstructions: 101 }), latestLedger: 1 }),
    );
    expect(v?.message).toBe('two simulations of the same input used different resources');
    expect(v?.details).toEqual({ diffs: ['cpuInstructions 100 -> 101'] });
    expect(
      await deterministic.evaluate(
        inv(ok(1n)),
        ctx({ outcome: ok(1n), resources: res({ minResourceFee: '999' }), latestLedger: 1 }),
      ),
    ).toBeNull();
  });
  it('ignores simulation failures on either call', async () => {
    expect(
      await deterministic.evaluate(inv({ kind: 'simulation-failed', message: 'x' }), ctx()),
    ).toBeNull();
    expect(
      await deterministic.evaluate(
        inv(ok(1n)),
        ctx({
          outcome: { kind: 'simulation-failed', message: 'y' },
          resources: null,
          latestLedger: 1,
        }),
      ),
    ).toBeNull();
  });
});

describe('read-only', () => {
  const key = xdr.LedgerKey.fromJson({
    contract_data: {
      contract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      key: { symbol: 'LastSeen' },
      durability: 'persistent',
    },
  } as xdr.JsonValue).toXdr('base64');

  it('passes calls without writes and failed calls', async () => {
    expect(await readOnly.evaluate(inv(ok(1n)), ctx())).toBeNull();
    expect(
      await readOnly.evaluate(inv({ kind: 'trap', error: 'x', message: '' }, null), ctx()),
    ).toBeNull();
  });
  it('fails on any write and names the written keys', async () => {
    const v = await readOnly.evaluate(
      inv(ok(1n), res({ writeEntries: 1, writeFootprint: [key] })),
      ctx(),
    );
    expect(v?.message).toBe(
      'function is configured read-only but writes 1 ledger entry: persistent contract data {"symbol":"LastSeen"}',
    );
    const two = await readOnly.evaluate(
      inv(ok(1n), res({ writeEntries: 2, writeFootprint: [key, key] })),
      ctx(),
    );
    expect(two?.message).toContain('writes 2 ledger entries');
  });
  it('describes ledger keys', () => {
    const inst = xdr.LedgerKey.fromJson({
      contract_data: {
        contract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
        key: 'ledger_key_contract_instance',
        durability: 'persistent',
      },
    } as xdr.JsonValue).toXdr('base64');
    expect(describeLedgerKey(inst)).toBe('persistent contract data instance');
    const code = xdr.LedgerKey.fromJson({
      contract_code: { hash: '00'.repeat(32) },
    } as xdr.JsonValue).toXdr('base64');
    expect(describeLedgerKey(code)).toContain('contract_code');
    expect(describeLedgerKey('garbage')).toBe('garbage');
  });
});

describe('budget', () => {
  it('fails above the CPU or memory threshold', async () => {
    const b = budgetCheck({ cpuInstructions: 100, memoryBytes: 40 });
    const v = await b.evaluate(inv(ok(1n), res({ cpuInstructions: 101 })), ctx());
    expect(v?.message).toBe('over budget: CPU 101 > 100 instructions, memory 50 > 40 bytes');
    expect(await budgetCheck({ cpuInstructions: 100 }).evaluate(inv(ok(1n)), ctx())).toBeNull();
    expect(
      await budgetCheck({ memoryBytes: 1 }).evaluate(
        inv(ok(1n), res({ memoryBytes: null })),
        ctx(),
      ),
    ).toBeNull();
    expect(await b.evaluate(inv(ok(1n), null), ctx())).toBeNull();
  });
});

describe('custom-property', () => {
  const nonNegative: Property = {
    name: 'balance is never negative',
    function: 'transfer',
    check: (_args, result) => (result as bigint) >= 0n,
  };

  it('passes and fails with a clear message', async () => {
    const c = propertyCheck(nonNegative);
    expect(await c.evaluate(inv(ok(5n)), ctx())).toBeNull();
    const v = await c.evaluate(inv(ok(-1n)), ctx());
    expect(v?.message).toBe(
      'property "balance is never negative" failed: returned false (result: -1)',
    );
  });

  it('receives named args and supports string verdicts and throws', async () => {
    let seen: Record<string, unknown> = {};
    const c = propertyCheck({
      name: 'p',
      function: '*',
      check: (args) => {
        seen = args;
        return 'custom reason';
      },
    });
    expect((await c.evaluate(inv(ok(5n)), ctx()))?.message).toBe(
      'property "p" failed: custom reason (result: 5)',
    );
    expect(seen).toEqual({ from: 'GA', to: 'GB', amount: 5n });
    const t = propertyCheck({
      name: 't',
      function: 'transfer',
      check: () => {
        throw new Error('boom');
      },
    });
    expect((await t.evaluate(inv(ok(5n)), ctx()))?.message).toBe('property "t" threw: boom');
    const asyncOk = propertyCheck({
      name: 'a',
      function: 'transfer',
      check: async () => undefined,
    });
    expect(await asyncOk.evaluate(inv(ok(5n)), ctx())).toBeNull();
  });

  it('skips failed calls unless includeFailures is set', async () => {
    const failing: Outcome = { kind: 'contract-error', code: 3, name: 'X', message: '' };
    const p = (includeFailures: boolean): Property => ({
      name: 'p',
      function: 'transfer',
      includeFailures,
      check: (_a, r) => r !== undefined,
    });
    expect(await propertyCheck(p(false)).evaluate(inv(failing, null), ctx())).toBeNull();
    expect(await propertyCheck(p(true)).evaluate(inv(failing, null), ctx())).not.toBeNull();
    expect(
      await propertyCheck(p(true)).evaluate(
        inv({ kind: 'simulation-failed', message: '' }, null),
        ctx(),
      ),
    ).toBeNull();
  });

  it('validates property definitions', () => {
    expect(defineProperties([nonNegative])).toEqual([nonNegative]);
    expect(validateProperties(nonNegative, 'f')).toHaveLength(1);
    expect(() => validateProperties([null], 'f')).toThrow(ConfigError);
    expect(() => validateProperties([{ name: '', function: 'x', check: () => true }], 'f')).toThrow(
      /name/,
    );
    expect(() => validateProperties([{ name: 'n', function: [], check: () => true }], 'f')).toThrow(
      /function/,
    );
    expect(() => validateProperties([{ name: 'n', function: 'x' }], 'f')).toThrow(/check/);
    expect(propertyApplies({ ...nonNegative, function: ['a', 'transfer'] }, 'transfer')).toBe(true);
    expect(propertyApplies({ ...nonNegative, function: '*' }, 'any')).toBe(true);
    expect(propertyApplies(nonNegative, 'other')).toBe(false);
  });
});

describe('caseChecksFor', () => {
  const names = (cfg: ReturnType<typeof resolveConfig>, fn = transfer, props: Property[] = []) =>
    caseChecksFor(fn, cfg, props).map((c) => c.label ?? c.check);

  it('enables trap and determinism checks by default only', () => {
    expect(names(resolveConfig({}, undefined, {}))).toEqual([
      'no-unexpected-trap',
      'deterministic',
    ]);
  });

  it('adds read-only, budget and properties when configured', () => {
    const cfg = resolveConfig(
      { functions: { transfer: { readOnly: true, budget: { cpuInstructions: 5 } } } },
      undefined,
      {},
    );
    expect(names(cfg, transfer, [{ name: 'p', function: 'transfer', check: () => true }])).toEqual([
      'no-unexpected-trap',
      'deterministic',
      'read-only',
      'budget',
      'p',
    ]);
  });

  it('honours global and per-function switches', () => {
    const cfg = resolveConfig(
      {
        checks: { deterministic: false },
        functions: { transfer: { checks: { 'no-unexpected-trap': false, deterministic: true } } },
      },
      undefined,
      {},
    );
    expect(names(cfg)).toEqual(['deterministic']);
    expect(names(cfg, spec.functions[0]!)).toEqual(['no-unexpected-trap']);
  });
});
