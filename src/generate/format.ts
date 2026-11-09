/**
 * Human-readable and JSON-safe renderings of native values.
 */

/**
 * Renders a native value compactly, e.g. `[0, 0x00ff, "a", Kind::One(5)]`.
 * Big integers print without an `n` suffix; byte arrays print as hex.
 */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString('hex')}`;
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.tag === 'string' && Array.isArray(o.values) && Object.keys(o).length === 2) {
      return o.values.length === 0 ? o.tag : `${o.tag}(${o.values.map(formatValue).join(', ')})`;
    }
    if ('$type' in o && 'value' in o && Object.keys(o).length === 2) {
      return `${formatValue(o.value)}_${String(o.$type)}`;
    }
    return `{ ${Object.entries(o)
      .map(([k, x]) => `${k}: ${formatValue(x)}`)
      .join(', ')} }`;
  }
  return String(v);
}

/** Renders named arguments as `name=value, name=value`. */
export function formatArgs(names: readonly string[], args: readonly unknown[]): string {
  return names.map((n, i) => `${n}=${formatValue(args[i])}`).join(', ');
}

/** A JSON value. */
export type JsonSafe = null | boolean | number | string | JsonSafe[] | { [k: string]: JsonSafe };

/**
 * Converts a native value into plain JSON: bigints become `{"$bigint": "..."}`,
 * byte arrays `{"$bytes": "<hex>"}`. Reversed by {@link fromJsonSafe}.
 */
export function toJsonSafe(v: unknown): JsonSafe {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return { $bigint: v.toString() };
  if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString('hex') };
  if (Array.isArray(v)) return v.map(toJsonSafe);
  if (typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, toJsonSafe(x)]));
  }
  return v as boolean | number | string;
}

/** Inverse of {@link toJsonSafe}. */
export function fromJsonSafe(v: JsonSafe | undefined): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(fromJsonSafe);
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v.$bigint === 'string') return BigInt(v.$bigint);
    if (keys.length === 1 && typeof v.$bytes === 'string') {
      return new Uint8Array(Buffer.from(v.$bytes, 'hex'));
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromJsonSafe(x)]));
  }
  return v;
}
