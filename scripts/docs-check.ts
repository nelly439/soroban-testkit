/**
 * `make docs-check`: fails when the documentation and the code disagree.
 *
 * Checks:
 *  1. every config option (CONFIG_KEYS) and env var is documented in docs/configuration.md
 *  2. every CLI command and flag appears in docs/cli.md, and every exit code is documented
 *  3. every built-in check has a section in docs/checks.md and is described in docs/concepts.md
 *  4. every `make <target>` mentioned in any Markdown file exists in the Makefile
 *  5. all relative Markdown links (and #anchors) resolve
 *  6. every runtime export of src/index.ts is mentioned in docs/api.md
 *  7. every export of src/index.ts has a TSDoc comment
 *  8. docs/WAVE_ISSUES.md has 25-30 issues, each with a complexity level
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { CHECK_NAMES, CONFIG_KEYS, ENV_VARS } from '../src/config/config.js';
import { ExitCode } from '../src/errors.js';
import { buildProgram } from '../src/cli/program.js';

const ROOT = resolve(import.meta.dirname, '..');
let passed = 0;
let failed = 0;

function check(name: string, problems: string[]): void {
  if (problems.length === 0) {
    passed++;
    process.stdout.write(`PASS  ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL  ${name}\n${problems.map((p) => `        - ${p}`).join('\n')}\n`);
  }
}

function read(rel: string): string {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'coverage', '.git', 'target', '.verify'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** GitHub-style heading slug. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchors(md: string): Set<string> {
  const set = new Set<string>();
  const counts = new Map<string, number>();
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]!.replace(/`/g, ''));
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    set.add(n === 0 ? base : `${base}-${n}`);
  }
  return set;
}

function stripFences(md: string): string {
  return md.replace(/```[\s\S]*?```/g, '');
}

const configuration = read('docs/configuration.md');
const cli = read('docs/cli.md');
const checks = read('docs/checks.md');
const concepts = read('docs/concepts.md');
const api = read('docs/api.md');

// 1. config
check('every config option and environment variable is documented in docs/configuration.md', [
  ...CONFIG_KEYS.filter((k) => !configuration.includes(`\`${k}\``)).map(
    (k) => `config option \`${k}\` not documented`,
  ),
  ...Object.values(ENV_VARS)
    .filter((v) => !configuration.includes(`\`${v}\``))
    .map((v) => `env var \`${v}\` not documented`),
  ...(configuration ? [] : ['docs/configuration.md is missing']),
]);

// 2. CLI
{
  const program = buildProgram(
    { stdout: () => {}, stderr: () => {}, env: {}, cwd: ROOT, color: false },
    { code: 0 },
  );
  const problems: string[] = [];
  if (!cli) problems.push('docs/cli.md is missing');
  for (const flag of ['--help', '--version'])
    if (!cli.includes(flag)) problems.push(`global flag ${flag} missing`);
  for (const cmd of program.commands) {
    if (!new RegExp(`^#+ .*soroban-testkit ${cmd.name()}\\b`, 'm').test(cli)) {
      problems.push(`command "${cmd.name()}" has no "soroban-testkit ${cmd.name()}" heading`);
    }
    for (const opt of cmd.options) {
      const flag = opt.long ?? opt.short!;
      // the flag must appear inside an inline code span, e.g. `-c, --config <file>`
      const inCode = new RegExp('`[^`\\n]*' + flag + '(?![\\w-])[^`\\n]*`');
      if (!inCode.test(cli)) problems.push(`flag ${flag} of "${cmd.name()}" not documented`);
    }
  }
  for (const [name, code] of Object.entries(ExitCode)) {
    if (!new RegExp(`\\|\\s*\`${code}\`\\s*\\|`).test(cli))
      problems.push(`exit code ${code} (${name}) not in the exit-code table`);
  }
  check('every CLI command, flag and exit code is documented in docs/cli.md', problems);
}

// 3. checks
check('every built-in check has a section in docs/checks.md and is described in docs/concepts.md', [
  ...CHECK_NAMES.filter((c) => !new RegExp(`^## \`${c}\``, 'm').test(checks)).map(
    (c) => `docs/checks.md: no "## \`${c}\`" section`,
  ),
  ...CHECK_NAMES.filter((c) => !concepts.includes(`\`${c}\``)).map(
    (c) => `docs/concepts.md does not mention \`${c}\``,
  ),
]);

// 4. make targets
{
  const makefile = read('Makefile');
  const targets = new Set([...makefile.matchAll(/^([a-z0-9][a-z0-9-]*):/gm)].map((m) => m[1]!));
  const problems: string[] = [];
  let mentions = 0;
  for (const file of markdownFiles(ROOT)) {
    const md = readFileSync(file, 'utf8');
    const found: string[] = [];
    for (const m of md.matchAll(/`make ([a-z0-9][a-z0-9-]*)[^`]*`/g)) found.push(m[1]!);
    for (const block of md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
      for (const line of block[1]!.split('\n')) {
        const m = /^\s*(?:\$\s+)?make\s+([a-z0-9][a-z0-9-]*)/.exec(line);
        if (m) found.push(m[1]!);
      }
    }
    for (const t of found) {
      mentions++;
      if (!targets.has(t))
        problems.push(
          `${relative(ROOT, file)} mentions "make ${t}", which is not a Makefile target`,
        );
    }
  }
  check(
    `every make target mentioned in the docs exists (${mentions} mentions, ${targets.size} targets)`,
    problems,
  );
}

// 5. links
{
  const problems: string[] = [];
  let links = 0;
  for (const file of markdownFiles(ROOT)) {
    const md = readFileSync(file, 'utf8');
    for (const m of stripFences(md).matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1]!;
      if (/^(https?:|mailto:)/.test(target)) continue;
      links++;
      const [path, anchor] = target.split('#') as [string, string | undefined];
      const dest = path === '' ? file : resolve(dirname(file), decodeURIComponent(path));
      if (!existsSync(dest)) {
        problems.push(`${relative(ROOT, file)}: broken link ${target}`);
        continue;
      }
      if (anchor && dest.endsWith('.md') && !anchors(readFileSync(dest, 'utf8')).has(anchor)) {
        problems.push(
          `${relative(ROOT, file)}: missing anchor #${anchor} in ${relative(ROOT, dest)}`,
        );
      }
    }
  }
  check(`all relative Markdown links resolve (${links} links checked)`, problems);
}

// 6 + 7. API docs and TSDoc
{
  const mod = (await import('../src/index.js')) as Record<string, unknown>;
  const runtime = Object.keys(mod);
  check(
    `every runtime export (${runtime.length}) is mentioned in docs/api.md`,
    runtime
      .filter((name) => !new RegExp(`\\b${name}\\b`).test(api))
      .map((n) => `\`${n}\` not mentioned in docs/api.md`),
  );

  const entry = join(ROOT, 'src/index.ts');
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry)!;
  const symbol = checker.getSymbolAtLocation(source)!;
  const exports = checker.getExportsOfModule(symbol);
  const missing: string[] = [];
  for (const exp of exports) {
    const target = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    const decls = target.getDeclarations() ?? [];
    const documented = decls.some((d) => {
      const node = ts.isVariableDeclaration(d) ? d.parent.parent : d;
      return (
        ts.getJSDocCommentsAndTags(node).length > 0 ||
        target.getDocumentationComment(checker).length > 0
      );
    });
    if (!documented)
      missing.push(
        `${exp.getName()} (${decls[0] ? relative(ROOT, decls[0].getSourceFile().fileName) : '?'})`,
      );
  }
  check(
    `every export of src/index.ts has TSDoc (${exports.length} exports)`,
    missing.map((m) => `no TSDoc: ${m}`),
  );
}

// 8. Wave issues
{
  const wave = read('docs/WAVE_ISSUES.md');
  const issues = wave.split(/^### /m).slice(1);
  const levels = { Trivial: 0, Medium: 0, High: 0 } as Record<string, number>;
  const problems: string[] = [];
  issues.forEach((body, i) => {
    const m = /\*\*Complexity:\*\*\s*(Trivial|Medium|High)/.exec(body);
    if (!m) problems.push(`issue #${i + 1} has no "**Complexity:** Trivial|Medium|High" line`);
    else levels[m[1]!]!++;
    for (const part of ['Acceptance criteria', 'Files to look at']) {
      if (!body.includes(part)) problems.push(`issue #${i + 1} has no "${part}" section`);
    }
  });
  if (issues.length < 25 || issues.length > 30)
    problems.push(`expected 25-30 issues, found ${issues.length}`);
  check(
    `docs/WAVE_ISSUES.md has 25-30 scoped issues (${issues.length}: ${levels.Trivial} Trivial, ${levels.Medium} Medium, ${levels.High} High)`,
    problems,
  );
}

process.stdout.write(`\ndocs-check: ${passed} checks passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
