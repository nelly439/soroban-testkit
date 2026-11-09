#!/usr/bin/env node
/**
 * CLI entry point.
 */
import { runCli } from './program.js';

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`soroban-testkit: ${String(err)}\n`);
    process.exitCode = 2;
  },
);
