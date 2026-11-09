/**
 * soroban-testkit: spec-driven fuzzing, invariant checks and cost-regression
 * testing for Soroban smart contracts, using Stellar RPC `simulateTransaction`.
 *
 * @packageDocumentation
 */

// High-level operations (what the CLI does)
export {
  inspect,
  fuzz,
  costs,
  resolveRunTarget,
  clientFromConfig,
  chooseSeed,
  type FuzzOptions,
  type CostsOptions,
  type CostsMode,
  type CostsResult,
  type ResolvedTarget,
} from './api.js';
export { runCli, type CliIO } from './cli/program.js';

// Spec
export {
  loadSpecFromWasm,
  loadSpecFromJson,
  loadSpecFromFile,
  resolveTarget,
  isWasm,
  type Target,
} from './spec/load.js';
export { specFromXdrEntries, specToXdrEntries, specFromJsonEntries } from './spec/xdr-json.js';
export {
  formatType,
  declaredErrorCodes,
  PRIMITIVE_KINDS,
  type ContractSpec,
  type FunctionSpec,
  type NamedType,
  type TypeRef,
  type PrimitiveKind,
  type UdtSpec,
  type StructSpec,
  type UnionSpec,
  type UnionCase,
  type EnumSpec,
  type ErrorEnumSpec,
  type EnumCase,
} from './spec/types.js';

// Generation
export {
  arbitraryFor,
  argumentsArbitrary,
  boundaryValues,
  boundaryCases,
  combineBoundaries,
  DEFAULT_GENERATOR_OPTIONS,
  INT_RANGES,
  BOUNDARY_ADDRESSES,
  MAX_SYMBOL_LENGTH,
  type GeneratorOptions,
  type TaggedVal,
  type UnionValue,
} from './generate/arbitraries.js';
export { toScVal, fromScVal, argsToScVals, compareScVal, sortedMap } from './generate/scval.js';
export {
  formatValue,
  formatArgs,
  toJsonSafe,
  fromJsonSafe,
  type JsonSafe,
} from './generate/format.js';

// RPC
export { SimulationClient, NULL_ACCOUNT, type RpcOptions } from './rpc/client.js';
export {
  classifyError,
  parseSimulation,
  parseResources,
  type Outcome,
  type Resources,
  type SimulationResult,
  type RawSimulation,
} from './rpc/outcome.js';

// Checks and properties
export {
  caseChecksFor,
  noUnexpectedTrap,
  deterministic,
  readOnly,
  budgetCheck,
  propertyCheck,
  type CaseCheck,
  type CaseCheckContext,
  type Invocation,
  type Violation,
} from './checks/checks.js';
export {
  defineProperties,
  loadProperties,
  type Property,
  type PropertyContext,
  type PropertyVerdict,
} from './checks/properties.js';

// Runner
export {
  run,
  replay,
  type RunOptions,
  type ReplayOptions,
  type RunReport,
  type RunEvent,
  type Finding,
  type Counterexample,
  type FunctionSummary,
  type OutcomeCounts,
  type Simulator,
} from './runner/runner.js';
export { readReplay, writeReplay, type ReplayFile } from './runner/replay.js';

// Baseline
export {
  computeCosts,
  compareCosts,
  readBaseline,
  writeBaseline,
  type BaselineFile,
  type BaselineComparison,
  type CostDelta,
  type CostMetric,
  type FunctionCosts,
  type MetricStats,
} from './baseline/baseline.js';

// Reports
export {
  renderTerminal,
  renderJson,
  renderMarkdown,
  renderJunit,
  type ReportOptions,
} from './report/reporters.js';
export { renderSpec } from './report/inspect.js';

// Config
export {
  defineConfig,
  loadConfig,
  loadConfigFile,
  resolveConfig,
  validateConfig,
  checkEnabled,
  budgetFor,
  CHECK_NAMES,
  CONFIG_KEYS,
  ENV_VARS,
  NETWORK_PRESETS,
  DEFAULTS,
  type CheckName,
  type UserConfig,
  type ResolvedConfig,
  type FunctionConfig,
  type BudgetThresholds,
  type BaselineConfig,
  type NetworkPreset,
  type ConfigOverrides,
} from './config/config.js';

// Errors
export {
  ExitCode,
  TestkitError,
  UsageError,
  ConfigError,
  SpecError,
  RpcUnavailableError,
  type ExitCodeValue,
} from './errors.js';

export { VERSION } from './version.js';
