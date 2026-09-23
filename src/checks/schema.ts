/**
 * Checks a tool call's arguments against the tool's own JSON schema.
 *
 * Only the parts of JSON Schema that tool definitions use are checked. Any
 * other keyword is reported as not checked — never silently treated as
 * passing — so a clean result means the arguments really were checked.
 */

export interface SchemaIssue {
  /** Where in the arguments, as a dotted path; '' for the arguments as a whole. */
  path: string;
  message: string;
}

export interface SchemaResult {
  issues: SchemaIssue[];
  /** Keywords present in the schema that this validator does not check. */
  unchecked: string[];
}

type Schema = Record<string, unknown>;

/** Keywords that describe rather than constrain. */
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples', '$schema', '$id', '$comment', 'deprecated', 'readOnly', 'writeOnly']);
const CHECKED = new Set([
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items',
  'anyOf', 'oneOf', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format',
]);
/** Formats with an unambiguous check; any other format is left unchecked. */
const FORMATS: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value: unknown, type: string): boolean {
  const actual = jsonType(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function check(value: unknown, schema: Schema, path: string, out: SchemaResult): void {
  for (const key of Object.keys(schema)) {
    if (!CHECKED.has(key) && !ANNOTATIONS.has(key) && !out.unchecked.includes(key)) out.unchecked.push(key);
  }
  const where = path || 'arguments';

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
    if (!types.some((type) => typeMatches(value, type))) {
      out.issues.push({ path, message: `${where} should be ${types.join(' or ')}, got ${jsonType(value)}` });
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    out.issues.push({ path, message: `${where} is ${show(value)}, not one of ${schema.enum.map(show).join(', ')}` });
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    out.issues.push({ path, message: `${where} should be ${show(schema.const)}` });
  }

  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const passing = branches.filter((branch) => {
      const trial: SchemaResult = { issues: [], unchecked: out.unchecked };
      check(value, branch as Schema, path, trial);
      return trial.issues.length === 0;
    }).length;
    if (key === 'anyOf' ? passing === 0 : passing !== 1) {
      out.issues.push({ path, message: `${where} matches ${passing} of the allowed shapes, needs ${key === 'anyOf' ? 'at least one' : 'exactly one'}` });
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) out.issues.push({ path, message: `${where} is shorter than ${schema.minLength} characters` });
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) out.issues.push({ path, message: `${where} is longer than ${schema.maxLength} characters` });
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) out.issues.push({ path, message: `${where} doesn't match the pattern ${schema.pattern}` });
      } catch {
        if (!out.unchecked.includes('pattern')) out.unchecked.push('pattern');
      }
    }
    if (typeof schema.format === 'string') {
      const format = FORMATS[schema.format];
      if (!format) {
        if (!out.unchecked.includes(`format:${schema.format}`)) out.unchecked.push(`format:${schema.format}`);
      } else if (!format.test(value)) {
        out.issues.push({ path, message: `${where} isn't a valid ${schema.format}` });
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) out.issues.push({ path, message: `${where} is below ${schema.minimum}` });
    if (typeof schema.maximum === 'number' && value > schema.maximum) out.issues.push({ path, message: `${where} is above ${schema.maximum}` });
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const name of Array.isArray(schema.required) ? schema.required as string[] : []) {
      if (!(name in object)) out.issues.push({ path: path ? `${path}.${name}` : name, message: `${name} is required but missing` });
    }
    for (const [name, item] of Object.entries(object)) {
      const child = path ? `${path}.${name}` : name;
      if (properties[name]) check(item, properties[name], child, out);
      else if (schema.additionalProperties === false) out.issues.push({ path: child, message: `${name} isn't a parameter this tool takes` });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(item, schema.additionalProperties as Schema, child, out);
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    value.forEach((item, index) => check(item, schema.items as Schema, `${path}[${index}]`, out));
  }
}

export function validateArgs(args: unknown, schema: Record<string, unknown>): SchemaResult {
  const out: SchemaResult = { issues: [], unchecked: [] };
  check(args, schema, '', out);
  return out;
}
