import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { resolveConfig } from '../../src/config/config.js';
import { SimulationClient } from '../../src/rpc/client.js';
import { run, type RunReport } from '../../src/runner/runner.js';
import {
  renderJson,
  renderJunit,
  renderMarkdown,
  renderTerminal,
} from '../../src/report/reporters.js';
import type { BaselineFile } from '../../src/baseline/baseline.js';
import { startFakeRpc, type FakeRpc } from '../fake-rpc/server.js';
import {
  BUGGY_VAULT_ID,
  CLEAN_VAULT_ID,
  buggyVault,
  cleanVault,
  vaultSpec,
} from '../fake-rpc/contracts.js';

let rpc: FakeRpc;
let buggy: RunReport;
let clean: RunReport;

/** Removes run-specific values so snapshots are stable. */
function normalize(r: RunReport): RunReport {
  return {
    ...r,
    durationMs: 1234,
    startedAt: '2026-01-01T00:00:00.000Z',
    findings: r.findings.map((f) => ({
      ...f,
      replayFile: `.soroban-testkit/replays/${f.replayFile!.split('/').pop()}`,
    })),
  };
}

beforeAll(async () => {
  rpc = await startFakeRpc({ contracts: [cleanVault, buggyVault], reportCost: true });
  const client = new SimulationClient({
    rpcUrl: rpc.url,
    networkPassphrase: Networks.STANDALONE,
    retries: 0,
  });
  const config = resolveConfig(
    {
      replayDir: '/tmp/stk-report-replays',
      functions: { balance: { readOnly: true }, transfer: { skip: true } },
    },
    undefined,
    {},
  );
  const costs = await run({
    spec: vaultSpec,
    contractId: CLEAN_VAULT_ID,
    simulator: client,
    config,
    seed: 42,
    runs: 5,
    mode: 'costs',
  });
  const baseline: BaselineFile = {
    version: 1,
    generator: 'soroban-testkit',
    createdAt: '',
    seed: 42,
    runs: 5,
    functions: {
      ...Object.fromEntries(costs.functions.filter((f) => f.costs).map((f) => [f.name, f.costs!])),
      removed: costs.functions[0]!.costs!,
    },
  };
  baseline.functions.div_by = {
    ...baseline.functions.div_by!,
    cpuInstructions: { min: 1, max: 600_000, mean: 1 },
  };
  delete baseline.functions.first;
  buggy = normalize(
    await run({
      spec: vaultSpec,
      contractId: BUGGY_VAULT_ID,
      simulator: client,
      config,
      seed: 42,
      runs: 5,
      baseline: { path: '.soroban-testkit/baseline.json', file: baseline },
      properties: [{ name: 'roll is | odd-safe', function: 'roll', check: () => true }],
    }),
  );
  clean = normalize(
    await run({
      spec: vaultSpec,
      contractId: CLEAN_VAULT_ID,
      simulator: client,
      config,
      seed: 42,
      runs: 5,
      writeReplays: false,
    }),
  );
});
afterAll(() => rpc.close());

describe('reporters', () => {
  it('terminal', async () => {
    await expect(renderTerminal(buggy, { target: 'vault.wasm' })).toMatchFileSnapshot(
      '__snapshots__/report.buggy.txt',
    );
    await expect(renderTerminal(clean)).toMatchFileSnapshot('__snapshots__/report.clean.txt');
  });

  it('terminal with color', () => {
    const out = renderTerminal(buggy, { color: true });
    expect(out).toContain('\u001b[31m');
    expect(out).toContain('\u001b[1m');
  });

  it('terminal for replays and simulation failures', () => {
    const r: RunReport = {
      ...clean,
      mode: 'replay',
      simulationFailures: [{ function: 'roll', input: 'salt=1', message: 'bad' }],
      notes: ['a note'],
      findings: [{ ...buggy.findings[0]!, shrinkSteps: 1, replayFile: undefined }],
    };
    const out = renderTerminal(r);
    expect(out).toContain('replaying a recorded case');
    expect(out).toContain('SIMULATION FAILURES (not contract bugs, not counted as findings)');
    expect(out).toContain('shrunk in 1 step)');
    expect(out).toContain('  - a note');
    expect(out).not.toContain('COSTS');
  });

  it('json', async () => {
    const parsed = JSON.parse(renderJson(buggy)) as RunReport;
    expect(parsed.findings).toHaveLength(buggy.findings.length);
    await expect(renderJson(buggy)).toMatchFileSnapshot('__snapshots__/report.buggy.json');
  });

  it('markdown', async () => {
    await expect(renderMarkdown(buggy, { target: 'vault.wasm' })).toMatchFileSnapshot(
      '__snapshots__/report.buggy.md',
    );
    await expect(renderMarkdown(clean)).toMatchFileSnapshot('__snapshots__/report.clean.md');
  });

  it('junit', async () => {
    const out = renderJunit(buggy, { target: 'vault.wasm' });
    expect(out).toMatch(/failures="\d+"/);
    expect(out).toContain('<skipped message="skipped by config"/>');
    await expect(out).toMatchFileSnapshot('__snapshots__/report.buggy.junit.xml');
    await expect(renderJunit(clean)).toMatchFileSnapshot('__snapshots__/report.clean.junit.xml');
  });
});
