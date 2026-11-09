/**
 * Replay files: everything needed to re-run one failing case exactly.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageError } from '../errors.js';
import { CHECK_NAMES, type CheckName } from '../config/config.js';

/** Contents of a replay file written for every finding. */
export interface ReplayFile {
  version: 1;
  /** Contract the failure was found on. */
  contractId: string;
  function: string;
  check: CheckName;
  /** Property name, for `custom-property` findings. */
  property?: string;
  /** Seed of the original run. */
  seed: number;
  /** Random runs of the original run (used to replay `cost-regression`). */
  runs: number;
  /** Base64 XDR of each argument of the (shrunk) counterexample. */
  argsXdr: string[];
  /** Human-readable counterexample. */
  display: string;
  /** The finding message at the time it was recorded. */
  message: string;
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
}

/** Writes a replay file and returns its path. */
export async function writeReplay(dir: string, replay: ReplayFile): Promise<string> {
  await mkdir(dir, { recursive: true });
  const name = [replay.check, replay.function, replay.property ? slug(replay.property) : undefined]
    .filter(Boolean)
    .join('--');
  const path = join(dir, `${name}.json`);
  await writeFile(path, JSON.stringify(replay, null, 2) + '\n');
  return path;
}

/** Reads and validates a replay file. */
export async function readReplay(path: string): Promise<ReplayFile> {
  let doc: Partial<ReplayFile>;
  try {
    doc = JSON.parse(await readFile(path, 'utf8')) as Partial<ReplayFile>;
  } catch (err) {
    throw new UsageError(`cannot read replay file ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (
    doc.version !== 1 ||
    typeof doc.function !== 'string' ||
    typeof doc.contractId !== 'string' ||
    !CHECK_NAMES.includes(doc.check as CheckName) ||
    !Array.isArray(doc.argsXdr) ||
    typeof doc.seed !== 'number' ||
    typeof doc.runs !== 'number'
  ) {
    throw new UsageError(`${path} is not a soroban-testkit replay file`);
  }
  return doc as ReplayFile;
}
