/**
 * Report renderers: terminal, JSON, Markdown and JUnit XML.
 */
import { isAbsolute, relative } from 'node:path';
import type { BaselineComparison, FunctionCosts } from '../baseline/baseline.js';
import type { Finding, FunctionSummary, RunReport } from '../runner/runner.js';

/** Options shared by the reporters. */
export interface ReportOptions {
  /** The CLI target (path or contract ID), used in replay hints. */
  target?: string;
  /** Use ANSI colors (terminal reporter only). Default false. */
  color?: boolean;
}

type Paint = (s: string) => string;

/** Shows paths under the working directory relative to it (shorter, no home directory). */
export function displayPath(p: string, cwd: string = process.cwd()): string {
  const r = relative(cwd, p);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r) ? r : p;
}

function palette(
  color: boolean,
): Record<'red' | 'green' | 'yellow' | 'dim' | 'bold' | 'cyan', Paint> {
  const wrap =
    (open: number, close: number): Paint =>
    (s) =>
      color ? `\u001b[${open}m${s}\u001b[${close}m` : s;
  return {
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null) return 'n/a';
  return n.toLocaleString('en-US');
}

function table(rows: string[][], alignRight: boolean[] = []): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) =>
    r
      .map((cell, i) => (alignRight[i] ? padLeft(cell, widths[i]!) : pad(cell, widths[i]!)))
      .join('  ')
      .trimEnd(),
  );
}

function replayHint(f: Finding, target: string | undefined): string {
  if (!f.replayFile) return '';
  return `soroban-testkit fuzz ${target ?? '<target>'} --replay ${displayPath(f.replayFile)}`;
}

function title(f: Finding): string {
  return f.property ? `${f.check} · ${f.function} · "${f.property}"` : `${f.check} · ${f.function}`;
}

function counterexampleLine(f: Finding): string {
  if (f.check === 'cost-regression')
    return `costliest input: ${f.counterexample.display || '(no arguments)'}`;
  const how =
    f.shrinkSteps > 0
      ? `shrunk in ${f.shrinkSteps} step${f.shrinkSteps === 1 ? '' : 's'}`
      : 'minimal as found';
  return `counterexample: ${f.counterexample.display || '(no arguments)'}  (${how})`;
}

function detailLines(f: Finding): string[] {
  const d = f.details;
  if (!d) return [];
  const out: string[] = [];
  if (f.check === 'deterministic') {
    if (typeof d.first === 'string')
      out.push(`first call:  ${d.first}`, `second call: ${d.second as string}`);
    if (Array.isArray(d.diffs)) out.push(...d.diffs.map((x) => `changed: ${String(x)}`));
  }
  if (f.check === 'no-unexpected-trap' && typeof d.hostDetail === 'string')
    out.push(`host: ${d.hostDetail}`);
  return out;
}

function costRows(functions: FunctionSummary[]): string[][] {
  const rows = [['function', 'samples', 'cpu max', 'cpu mean', 'mem max', 'fee max (stroops)']];
  for (const f of functions) {
    const c: FunctionCosts | null = f.costs;
    if (!c) {
      rows.push([f.name, f.skipped ? 'skipped' : '0', '-', '-', '-', '-']);
      continue;
    }
    rows.push([
      f.name,
      String(c.samples),
      fmtNum(c.cpuInstructions.max),
      fmtNum(c.cpuInstructions.mean),
      fmtNum(c.memoryBytes?.max),
      fmtNum(Number(c.maxMinResourceFee)),
    ]);
  }
  return rows;
}

function baselineLines(cmp: BaselineComparison): string[] {
  const out: string[] = [];
  for (const r of cmp.regressions) {
    out.push(
      `regression  ${r.function} ${r.metric}: ${fmtNum(r.baseline)} -> ${fmtNum(r.current)} (+${r.changePercent}%)`,
    );
  }
  for (const r of cmp.improvements) {
    out.push(
      `improvement ${r.function} ${r.metric}: ${fmtNum(r.baseline)} -> ${fmtNum(r.current)} (${r.changePercent}%)`,
    );
  }
  for (const f of cmp.newFunctions) out.push(`new function (not in baseline): ${f}`);
  for (const f of cmp.missingFunctions)
    out.push(`missing function (in baseline, not measured): ${f}`);
  if (out.length === 0) out.push(`no function changed by more than ${cmp.thresholdPercent}%`);
  return out;
}

/** Human-friendly terminal output. */
export function renderTerminal(report: RunReport, opts: ReportOptions = {}): string {
  const p = palette(opts.color ?? false);
  const lines: string[] = [];
  const n = report.findings.length;
  lines.push(
    p.bold(`soroban-testkit ${report.tool.version}`) +
      p.dim(` · ${report.mode} · contract ${report.contractId}`),
  );
  if (report.mode === 'replay') {
    lines.push(p.dim(`replaying a recorded case (original seed ${report.seed})`));
  } else {
    lines.push(
      p.dim(
        `seed ${report.seed} · ${report.runs} random runs per function and check, after boundary cases · reproduce with --seed ${report.seed}`,
      ),
    );
  }
  lines.push('');

  const rows: string[][] = [
    ['function', 'checks', 'inputs', 'ok', 'contract err', 'trap', 'result'],
  ];
  for (const f of report.functions) {
    const found = report.findings.filter((x) => x.function === f.name).length;
    const result = f.skipped
      ? p.dim(`skipped (${f.skipped})`)
      : found > 0
        ? p.red(`✗ ${found} finding${found === 1 ? '' : 's'}`)
        : p.green('✓ pass');
    rows.push([
      f.name,
      String(f.checks.length),
      String(f.inputs),
      String(f.outcomes.success),
      String(f.outcomes.contractError),
      String(f.outcomes.trap),
      result,
    ]);
  }
  lines.push(...table(rows, [false, true, true, true, true, true, false]).map((l) => `  ${l}`));

  if (n > 0) {
    lines.push('', p.bold(p.red(`FINDINGS (${n})`)));
    report.findings.forEach((f, i) => {
      lines.push('', `${p.bold(`${i + 1})`)} ${p.bold(title(f))}`);
      lines.push(`   ${f.message}`);
      for (const d of detailLines(f)) lines.push(`   ${p.dim(d)}`);
      lines.push(`   ${counterexampleLine(f)}`);
      lines.push(`   ${p.dim(`seed: ${f.seed}`)}`);
      const hint = replayHint(f, opts.target);
      if (hint) lines.push(`   ${p.dim(`replay: ${hint}`)}`);
    });
  }

  if (report.mode !== 'replay' && report.functions.some((f) => f.costs)) {
    lines.push(
      '',
      p.bold('COSTS') + p.dim(' (successful simulations; boundary + seeded random inputs)'),
    );
    lines.push(
      ...table(costRows(report.functions), [false, true, true, true, true, true]).map(
        (l) => `  ${l}`,
      ),
    );
  }

  if (report.baseline) {
    lines.push(
      '',
      p.bold('BASELINE') +
        p.dim(
          ` ${displayPath(report.baseline.path)} (threshold ${report.baseline.comparison.thresholdPercent}%)`,
        ),
    );
    for (const l of baselineLines(report.baseline.comparison)) {
      lines.push(`  ${l.startsWith('regression') ? p.red(l) : l}`);
    }
  }

  if (report.simulationFailures.length > 0) {
    lines.push('', p.yellow('SIMULATION FAILURES (not contract bugs, not counted as findings)'));
    for (const s of report.simulationFailures.slice(0, 5))
      lines.push(`  ${s.function}(${s.input}): ${s.message}`);
  }
  if (report.notes.length > 0) {
    lines.push('', p.bold('NOTES'));
    for (const note of report.notes) lines.push(`  - ${note}`);
  }

  const secs = (report.durationMs / 1000).toFixed(1);
  lines.push('');
  const verdict = n === 0 ? p.green('✓ no findings') : p.red(`✗ ${n} finding${n === 1 ? '' : 's'}`);
  lines.push(`${verdict} · ${report.simulations} simulations · ${secs}s · seed ${report.seed}`);
  return lines.join('\n') + '\n';
}

/** Machine-readable JSON (the full {@link RunReport}). */
export function renderJson(report: RunReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Markdown, suitable for a PR comment or a GitHub job summary. */
export function renderMarkdown(report: RunReport, opts: ReportOptions = {}): string {
  const n = report.findings.length;
  const out: string[] = [];
  out.push(
    `## soroban-testkit ${report.mode}: ${n === 0 ? '✅ no findings' : `❌ ${n} finding${n === 1 ? '' : 's'}`}`,
  );
  out.push('');
  out.push(
    `Contract \`${report.contractId}\` · seed \`${report.seed}\` · ${report.runs} random runs · ${report.simulations} simulations`,
  );
  out.push('');
  if (n > 0) {
    out.push('| # | check | function | message | counterexample |', '|---|---|---|---|---|');
    report.findings.forEach((f, i) => {
      const fn = f.property ? `${f.function} ("${mdEscape(f.property)}")` : f.function;
      out.push(
        `| ${i + 1} | \`${f.check}\` | \`${fn}\` | ${mdEscape(f.message)} | \`${mdEscape(f.counterexample.display)}\` |`,
      );
    });
    out.push('');
    const hints = report.findings.map((f) => replayHint(f, opts.target)).filter(Boolean);
    if (hints.length > 0) {
      out.push(
        '<details><summary>Replay commands</summary>',
        '',
        '```sh',
        ...hints,
        '```',
        '',
        '</details>',
        '',
      );
    }
  }
  out.push(
    '| function | checks | inputs | ok | contract err | trap | cpu max | mem max |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const f of report.functions) {
    out.push(
      `| \`${f.name}\` | ${f.skipped ? `skipped (${f.skipped})` : f.checks.length} | ${f.inputs} | ${f.outcomes.success} | ${f.outcomes.contractError} | ${f.outcomes.trap} | ${fmtNum(f.costs?.cpuInstructions.max)} | ${fmtNum(f.costs?.memoryBytes?.max)} |`,
    );
  }
  if (report.baseline) {
    out.push(
      '',
      `**Baseline** \`${displayPath(report.baseline.path)}\` (threshold ${report.baseline.comparison.thresholdPercent}%)`,
      '',
    );
    for (const l of baselineLines(report.baseline.comparison)) out.push(`- ${l}`);
  }
  if (report.notes.length > 0) {
    out.push('', '**Notes**', '');
    for (const note of report.notes) out.push(`- ${mdEscape(note)}`);
  }
  return out.join('\n') + '\n';
}

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * JUnit XML: one `<testcase>` per function × check (properties are separate
 * test cases), failing test cases carry the finding.
 */
export function renderJunit(report: RunReport, opts: ReportOptions = {}): string {
  const cases: string[] = [];
  let failures = 0;
  let skipped = 0;
  for (const f of report.functions) {
    if (f.skipped) {
      skipped++;
      cases.push(
        `    <testcase classname="${xml(f.name)}" name="${xml(f.name)}"><skipped message="${xml(f.skipped)}"/></testcase>`,
      );
      continue;
    }
    for (const check of f.checks) {
      const finding = report.findings.find(
        (x) => x.function === f.name && (x.property ?? x.check) === check,
      );
      const name = `${f.name} › ${check}`;
      if (!finding) {
        cases.push(`    <testcase classname="${xml(f.name)}" name="${xml(name)}"/>`);
        continue;
      }
      failures++;
      const body = [
        finding.message,
        counterexampleLine(finding),
        `seed: ${finding.seed}`,
        replayHint(finding, opts.target),
      ]
        .filter(Boolean)
        .join('\n');
      cases.push(
        `    <testcase classname="${xml(f.name)}" name="${xml(name)}">\n      <failure type="${xml(finding.check)}" message="${xml(finding.message)}">${xml(body)}</failure>\n    </testcase>`,
      );
    }
  }
  const tests = cases.length;
  const time = (report.durationMs / 1000).toFixed(3);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="soroban-testkit" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">`,
    `  <testsuite name="${xml(`soroban-testkit ${report.mode} ${report.contractId}`)}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}" timestamp="${xml(report.startedAt)}">`,
    `    <properties><property name="seed" value="${report.seed}"/><property name="runs" value="${report.runs}"/></properties>`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}
