/**
 * Error types with the CLI exit code they map to.
 *
 * Exit codes: 0 clean, 1 findings, 2 usage/config error, 3 RPC unreachable.
 */

/** Process exit codes used by the CLI. */
export const ExitCode = {
  /** No findings. */
  Clean: 0,
  /** At least one check reported a finding. */
  Findings: 1,
  /** Bad command line, bad config, unreadable spec. */
  Usage: 2,
  /** The RPC endpoint could not be reached or returned transport errors. */
  RpcUnavailable: 3,
} as const;

/** Union of the numeric exit codes. */
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** Base class for all errors raised by soroban-testkit. */
export class TestkitError extends Error {
  /** Exit code the CLI uses when this error aborts a command. */
  readonly exitCode: ExitCodeValue;
  constructor(message: string, exitCode: ExitCodeValue, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** Invalid command line usage. Exit code 2. */
export class UsageError extends TestkitError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ExitCode.Usage, options);
  }
}

/** Invalid or unreadable configuration. Exit code 2. */
export class ConfigError extends TestkitError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ExitCode.Usage, options);
  }
}

/** The contract spec could not be loaded or parsed. Exit code 2. */
export class SpecError extends TestkitError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ExitCode.Usage, options);
  }
}

/**
 * The RPC server could not be reached, timed out, or answered with a
 * transport-level / JSON-RPC error. Never reported as a contract finding.
 * Exit code 3.
 */
export class RpcUnavailableError extends TestkitError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ExitCode.RpcUnavailable, options);
  }
}
