/**
 * Human-readable rendering of a contract spec (`soroban-testkit inspect`).
 */
import { formatType, type ContractSpec, type UdtSpec } from '../spec/types.js';

function docLine(doc: string, indent: string): string[] {
  const d = doc.trim();
  if (!d) return [];
  return d.split('\n').map((l) => `${indent}${l.trim()}`);
}

function renderUdt(t: UdtSpec): string[] {
  const out: string[] = [];
  const lib = t.lib ? ` (from ${t.lib})` : '';
  switch (t.kind) {
    case 'struct': {
      const tuple = t.fields.length > 0 && t.fields.every((f) => /^\d+$/.test(f.name));
      out.push(
        tuple
          ? `  struct ${t.name}(${t.fields.map((f) => formatType(f.type)).join(', ')})${lib}`
          : `  struct ${t.name} { ${t.fields.map((f) => `${f.name}: ${formatType(f.type)}`).join(', ')} }${lib}`,
      );
      break;
    }
    case 'union':
      out.push(
        `  union ${t.name} { ${t.cases
          .map((c) =>
            c.kind === 'void' ? c.name : `${c.name}(${c.types.map(formatType).join(', ')})`,
          )
          .join(', ')} }${lib}`,
      );
      break;
    case 'enum':
      out.push(
        `  enum ${t.name} { ${t.cases.map((c) => `${c.name} = ${c.value}`).join(', ')} }${lib}`,
      );
      break;
    case 'errorEnum':
      out.push(
        `  error ${t.name} { ${t.cases.map((c) => `${c.name} = ${c.value}`).join(', ')} }${lib}`,
      );
      break;
  }
  out.push(...docLine(t.doc, '      '));
  return out;
}

/** Renders the spec for the terminal. */
export function renderSpec(spec: ContractSpec, source: string): string {
  const types = Object.values(spec.types);
  const lines: string[] = [
    `Contract interface: ${source}`,
    `${spec.functions.length} function${spec.functions.length === 1 ? '' : 's'}, ${types.length} type${types.length === 1 ? '' : 's'}, ${spec.events.length} event${spec.events.length === 1 ? '' : 's'}`,
    '',
    'FUNCTIONS',
  ];
  for (const f of spec.functions) {
    const params = f.inputs.map((i) => `${i.name}: ${formatType(i.type)}`).join(', ');
    const ret = f.outputs.length > 0 ? ` -> ${f.outputs.map(formatType).join(', ')}` : '';
    lines.push(`  ${f.name}(${params})${ret}`);
    lines.push(...docLine(f.doc, '      '));
  }
  if (types.length > 0) {
    lines.push('', 'TYPES');
    for (const t of types) lines.push(...renderUdt(t));
  }
  if (spec.events.length > 0) {
    lines.push('', 'EVENTS');
    for (const e of spec.events) lines.push(`  ${e}`);
  }
  return lines.join('\n') + '\n';
}
