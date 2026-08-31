#!/usr/bin/env node
/**
 * db-review.ts — document a PostgreSQL schema AND review its design in one pass.
 *
 *     node scripts/db-review.ts schema.sql --narratives narratives.json --out docs/database
 *
 * Reads DDL with the real PostgreSQL parser (libpg-query, a WebAssembly build of
 * libpg_query), builds a model (tables, columns, keys, foreign keys, indexes, RLS,
 * comments), joins it with human intent from narratives.json (domains, blurbs,
 * assertions), runs a set of deterministic design checks, and writes:
 *
 *     <out>/schema.json     machine-readable model + findings (input for the LLM pass)
 *     <out>/index.html      self-contained browsable docs with findings inline
 *     <out>/README.md       markdown index + per-domain pages with SVG ERDs
 *     <out>/erd.svg         whole-schema entity-relationship diagram (one more per domain)
 *     <out>/FINDINGS.md     findings grouped by severity with fix suggestions
 *
 * Exit code is non-zero when findings at or above --fail-on exist, so this can
 * gate CI the same way a linter does.
 *
 * Requires: Node 24+, libpg-query  (npm install)
 */
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type {
  A_Const, A_Expr, AlterTableStmt, ColumnRef, Constraint, Node, ParseResult, TypeName,
} from 'libpg-query';

// ----------------------------------------------------------------------------
// Model
// ----------------------------------------------------------------------------
// Field order matters: it is the key order of schema.json.

export interface Column {
  name: string;
  type: string;
  type_base: string;          // normalised base type: varchar, text, timestamp, ...
  length: number | null;
  not_null: boolean;
  default: string | null;
  check: string | null;
  comment: string;
  is_pk: boolean;
  is_unique: boolean;         // single-column unique
  is_fk: boolean;
  is_enum_type: boolean;
}

export interface ForeignKey {
  name: string | null;
  columns: string[];
  ref_table: string;
  ref_columns: string[];
  on_delete: string;          // NO ACTION | RESTRICT | CASCADE | SET NULL | SET DEFAULT
  nullable: boolean;
  unique: boolean;            // FK columns covered by a PK/UNIQUE
  indexed: boolean;           // FK columns are a leading prefix of some index
  cardinality: string;        // inferred parent:child, "1:1" | "1:N"
}

export interface Index {
  name: string | null;
  columns: string[];          // expression indexes render the expression
  unique: boolean;
  where: string | null;
  source: string;             // index | pk | unique-constraint
}

export interface ReferencedBy {
  table: string;
  columns: string[];
  on_delete: string;
  cardinality: string;
}

export interface Table {
  name: string;
  schema: string;
  description: string[];
  section: string;
  columns: Column[];
  pk: string[];
  uniques: string[][];
  checks: string[];
  fks: ForeignKey[];
  indexes: Index[];
  rls_enabled: boolean;
  policies: string[];
  referenced_by: ReferencedBy[];
  domain: string | null;
  findings: string[];         // finding ids
  source_line: number;
}

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  id: string;
  check: string;
  severity: Severity;
  table: string;
  columns: string[];
  title: string;
  detail: string;
  suggestion: string;
  fix_sql: string;
}

export interface Extras {
  extensions: string[];
  enums: Record<string, string[]>;
  unparsed: string[];
}


type Narratives = Record<string, any>;

function newColumn(c: Pick<Column, 'name' | 'type' | 'type_base' | 'length'> & Partial<Column>): Column {
  return {
    name: c.name, type: c.type, type_base: c.type_base, length: c.length,
    not_null: c.not_null ?? false, default: c.default ?? null, check: c.check ?? null,
    comment: c.comment ?? '', is_pk: c.is_pk ?? false, is_unique: c.is_unique ?? false,
    is_fk: c.is_fk ?? false, is_enum_type: c.is_enum_type ?? false,
  };
}

function newForeignKey(name: string | null, columns: string[], refTable: string, refColumns: string[], onDelete: string): ForeignKey {
  return { name, columns, ref_table: refTable, ref_columns: refColumns, on_delete: onDelete,
    nullable: false, unique: false, indexed: false, cardinality: '1:N' };
}

function newIndex(name: string | null, columns: string[], unique: boolean, where: string | null, source: string): Index {
  return { name, columns, unique, where, source };
}

function newTable(name: string, schema: string): Table {
  return { name, schema, description: [], section: '', columns: [], pk: [], uniques: [], checks: [],
    fks: [], indexes: [], rls_enabled: false, policies: [], referenced_by: [], domain: null,
    findings: [], source_line: 0 };
}

function col(t: Table, name: string): Column | null {
  return t.columns.find((c) => c.name === name) ?? null;
}

// ----------------------------------------------------------------------------
// Parsing
// ----------------------------------------------------------------------------
// Node shapes come from @pgsql/types (re-exported by libpg-query): every node is
// `{ <Kind>: { ...fields } }`, enum fields are string unions, and the parser omits
// zero, false and empty values, so `{ ival: {} }` means 0.

const DEL_ACTIONS: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

// Internal type names the parser uses for the SQL spellings.
const TYPE_ALIASES: Record<string, string> = {
  int4: 'integer', int8: 'bigint', int2: 'smallint', float8: 'double precision', float4: 'real',
  bpchar: 'char', bool: 'boolean', serial8: 'bigserial', serial4: 'serial', serial2: 'smallserial',
};

/** The tag of a parse-tree node: `{ CreateStmt: {...} }` gives "CreateStmt". */
function kindOf(node: Node): string {
  return Object.keys(node)[0] ?? '';
}

function svals(list: Node[] | undefined): string[] {
  return (list ?? []).map((x) => ('String' in x ? x.String.sval ?? '' : ''));
}

/** Render a TypeName node the way the SQL spelt it: varchar(255), bigint, uuid[]. */
export function renderType(tn: TypeName | undefined): string {
  if (!tn) return '';
  const names = svals(tn.names);
  let base = names[names.length - 1] ?? '';
  if (names[0] === 'pg_catalog') base = TYPE_ALIASES[base] ?? base;
  let out = base;
  if (tn.typmods?.length) out += `(${tn.typmods.map(renderExpr).join(', ')})`;
  out += '[]'.repeat(tn.arrayBounds?.length ?? 0);
  return out;
}

const list = (nodes: Node[] | undefined): string => (nodes ?? []).map(renderExpr).join(', ');

/** An operand of an operator: nested operator and boolean expressions get parentheses, as in
 *  pglast. NULLIF renders as a function call, so it needs none. */
function operand(node: Node | undefined): string {
  if (!node) return '';
  const nested = ('A_Expr' in node && node.A_Expr.kind !== 'AEXPR_NULLIF') || 'BoolExpr' in node;
  return nested ? `(${renderExpr(node)})` : renderExpr(node);
}

// ponytail: covers the node kinds that appear in table DDL (defaults, CHECKs, index
// expressions, policies). Anything else renders as "…" plus the column names inside it,
// which keeps the either/or check working. Swap in pgsql-deparser if that stops being enough.
/** Turn an expression node back into SQL text, formatted the way pglast's printer did. */
export function renderExpr(node: Node | null | undefined): string {
  if (node == null) return '';
  if ('A_Const' in node) return renderConst(node.A_Const);
  if ('String' in node) return node.String.sval ?? '';
  if ('Integer' in node) return String(node.Integer.ival ?? 0);
  if ('Float' in node) return node.Float.fval ?? '';
  if ('Boolean' in node) return node.Boolean.boolval ? 'TRUE' : 'FALSE';
  if ('ColumnRef' in node) {
    return (node.ColumnRef.fields ?? []).map((f) => ('A_Star' in f ? '*' : renderExpr(f))).join('.');
  }
  if ('FuncCall' in node) {
    const f = node.FuncCall;
    return `${svals(f.funcname).join('.')}(${f.agg_star ? '*' : list(f.args)})`;
  }
  if ('TypeCast' in node) return `CAST(${renderExpr(node.TypeCast.arg)} AS ${renderType(node.TypeCast.typeName)})`;
  if ('TypeName' in node) return renderType(node.TypeName);
  if ('A_Expr' in node) return renderAExpr(node.A_Expr);
  if ('BoolExpr' in node) {
    const { boolop, args = [] } = node.BoolExpr;
    if (boolop === 'NOT_EXPR') {
      const a = args[0];
      return a && 'BoolExpr' in a ? `NOT(${renderExpr(a)})` : `NOT ${renderExpr(a)}`;
    }
    // Nested AND/OR groups get parentheses; a nested NOT does not.
    const group = (a: Node): boolean => 'BoolExpr' in a && a.BoolExpr.boolop !== 'NOT_EXPR';
    return args.map((a) => (group(a) ? `(${renderExpr(a)})` : renderExpr(a)))
      .join(boolop === 'OR_EXPR' ? ' OR ' : ' AND ');
  }
  if ('NullTest' in node) {
    // IS NULL binds looser than arithmetic, so `a + b IS NULL` needs no parentheses.
    return `${renderExpr(node.NullTest.arg)} ${node.NullTest.nulltesttype === 'IS_NOT_NULL' ? 'IS NOT NULL' : 'IS NULL'}`;
  }
  if ('List' in node) return list(node.List.items);
  if ('A_ArrayExpr' in node) return `ARRAY[${list(node.A_ArrayExpr.elements)}]`;
  if ('SQLValueFunction' in node) {
    const { op = '', typmod } = node.SQLValueFunction;
    const name = op.replace(/^SVFOP_/, '');
    return name.endsWith('_N') ? `${name.slice(0, -2)}(${typmod ?? 0})` : name;
  }
  if ('CoalesceExpr' in node) return `COALESCE(${list(node.CoalesceExpr.args)})`;
  if ('MinMaxExpr' in node) {
    return `${node.MinMaxExpr.op === 'IS_LEAST' ? 'LEAST' : 'GREATEST'}(${list(node.MinMaxExpr.args)})`;
  }
  if ('CaseExpr' in node) {
    const c = node.CaseExpr;
    let s = 'CASE';
    if (c.arg) s += ` ${renderExpr(c.arg)}`;
    for (const w of c.args ?? []) {
      if ('CaseWhen' in w) s += ` WHEN ${renderExpr(w.CaseWhen.expr)} THEN ${renderExpr(w.CaseWhen.result)}`;
    }
    if (c.defresult) s += ` ELSE ${renderExpr(c.defresult)}`;
    return `${s} END`;
  }
  if ('A_Indirection' in node) {
    let s = `(${renderExpr(node.A_Indirection.arg)})`;
    for (const ind of node.A_Indirection.indirection ?? []) {
      if ('A_Indices' in ind) {
        const ix = ind.A_Indices;
        s += ix.is_slice ? `[${renderExpr(ix.lidx)}:${renderExpr(ix.uidx)}]` : `[${renderExpr(ix.uidx)}]`;
      } else if ('A_Star' in ind) {
        s += '.*';
      } else {
        s += `.${renderExpr(ind)}`;
      }
    }
    return s;
  }
  const cols = columnNames(node);
  return cols.length ? `…(${cols.join(', ')})` : '…';
}

function renderConst(c: A_Const): string {
  if (c.isnull) return 'NULL';
  if (c.sval) return `'${(c.sval.sval ?? '').replace(/'/g, "''")}'`;
  if (c.ival) return String(c.ival.ival ?? 0);
  if (c.fval) return c.fval.fval ?? '';
  if (c.boolval) return c.boolval.boolval ? 'TRUE' : 'FALSE';
  if (c.bsval) return `B'${c.bsval.bsval ?? ''}'`;
  return '…';
}

const BETWEEN_WORDS: Partial<Record<string, string>> = {
  AEXPR_BETWEEN: 'BETWEEN', AEXPR_NOT_BETWEEN: 'NOT BETWEEN',
  AEXPR_BETWEEN_SYM: 'BETWEEN SYMMETRIC', AEXPR_NOT_BETWEEN_SYM: 'NOT BETWEEN SYMMETRIC',
};

function renderAExpr(n: A_Expr): string {
  const op = svals(n.name).join('.');
  const l = operand(n.lexpr);
  const r = operand(n.rexpr);
  switch (n.kind) {
    case 'AEXPR_IN': return `${l} ${op === '<>' ? 'NOT IN' : 'IN'} (${renderExpr(n.rexpr)})`;
    case 'AEXPR_LIKE': return `${l} ${op === '!~~' ? 'NOT LIKE' : 'LIKE'} ${r}`;
    case 'AEXPR_ILIKE': return `${l} ${op === '!~~*' ? 'NOT ILIKE' : 'ILIKE'} ${r}`;
    case 'AEXPR_BETWEEN':
    case 'AEXPR_NOT_BETWEEN':
    case 'AEXPR_BETWEEN_SYM':
    case 'AEXPR_NOT_BETWEEN_SYM': {
      const bounds = n.rexpr && 'List' in n.rexpr ? (n.rexpr.List.items ?? []).map(renderExpr) : [r];
      return `${l} ${BETWEEN_WORDS[n.kind]} ${bounds.join(' AND ')}`;
    }
    case 'AEXPR_DISTINCT': return `${l} IS DISTINCT FROM ${r}`;
    case 'AEXPR_NOT_DISTINCT': return `${l} IS NOT DISTINCT FROM ${r}`;
    case 'AEXPR_NULLIF': return `NULLIF(${renderExpr(n.lexpr)}, ${renderExpr(n.rexpr)})`;
    case 'AEXPR_OP_ANY': return `${l} ${op} ANY(${renderExpr(n.rexpr)})`;
    case 'AEXPR_OP_ALL': return `${l} ${op} ALL(${renderExpr(n.rexpr)})`;
    default: return n.lexpr == null ? `${op} ${r}` : `${l} ${op} ${r}`;
  }
}

/** Every column reference inside a node, in document order. */
function columnNames(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const x of node) columnNames(x, acc);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'ColumnRef') acc.push(renderExpr({ ColumnRef: v as ColumnRef }));
      else columnNames(v, acc);
    }
  }
  return acc;
}

function typeInfo(tn: TypeName | undefined): [string, string, number | null] {
  const rendered = renderType(tn);
  const names = svals(tn?.names);
  let base = (names[names.length - 1] ?? '').toLowerCase();
  base = TYPE_ALIASES[base] ?? base;
  let length: number | null = null;
  const m = /^[a-z ]+\((\d+)\)$/.exec(rendered);
  if (m && (base === 'varchar' || base === 'char')) length = parseInt(m[1], 10);
  return [rendered, base, length];
}

type Parser = { loadModule(): Promise<void>; parseSync(query: string): ParseResult };
let parser: Promise<Parser> | undefined;

async function getParser(): Promise<Parser> {
  parser ??= (async () => {
    const m: Parser = await import('libpg-query');
    await m.loadModule();
    return m;
  })();
  return parser;
}

export async function parseSchema(sqlText: string, _path: string): Promise<{ tables: Map<string, Table>; extras: Extras }> {
  const { parseSync } = await getParser();
  // pg_dump 16.10+ / 17.6+ wraps its output in `\restrict <key>` ... `\unrestrict <key>`. Those
  // are psql commands, not SQL, and the parser rejects them. Blank them with the same number of
  // characters so every byte offset and line number below still points at the same place.
  const sql = sqlText.replace(/^\\.*$/gm, (line) => ' '.repeat(line.length));
  const tables = new Map<string, Table>();
  const enumTypes = new Set<string>();
  const pendingAlters: AlterTableStmt[] = [];
  const extras: Extras = { extensions: [], enums: {}, unparsed: [] };
  const lines = sql.split('\n');
  // Statement locations are byte offsets into the UTF-8 text.
  const bytes = Buffer.from(sql, 'utf8');

  const lineOf = (offset: number): number => {
    let n = 1;
    const end = Math.min(offset, bytes.length);
    for (let i = 0; i < end; i++) if (bytes[i] === 10) n++;
    return n;
  };

  // libpg_query reports a statement's location as the byte after the previous ';'
  // (0 for the first), so walk forward past whitespace and comments to its first token.
  const firstToken = (offset: number): number => {
    let i = offset;
    while (i < bytes.length) {
      const b = bytes[i];
      if (b === 32 || b === 9 || b === 10 || b === 13) {
        i++;
      } else if (b === 45 && bytes[i + 1] === 45) {           // "--" to end of line
        while (i < bytes.length && bytes[i] !== 10) i++;
      } else if (b === 47 && bytes[i + 1] === 42) {           // "/* ... */", nesting allowed
        let depth = 0;
        do {
          if (bytes[i] === 47 && bytes[i + 1] === 42) { depth++; i += 2; }
          else if (bytes[i] === 42 && bytes[i + 1] === 47) { depth--; i += 2; }
          else i++;
        } while (depth > 0 && i < bytes.length);
      } else {
        break;
      }
    }
    return i;
  };

  /** Collect the '--' comment block directly above a statement, and the most recent
   *  '-- PHASE ...' section heading above it. */
  const precedingComment = (offset: number): [string[], string] => {
    let ln = lineOf(offset) - 2;
    const desc: string[] = [];
    while (ln >= 0) {
      const s = lines[ln].trim();
      if (!s.startsWith('--') || s.startsWith('-- =') || s.startsWith('-- -')) break;
      const body = s.replace(/^-+/, '').trim();
      if (body && !/^(PHASE|Phase)\s/.test(body)) desc.unshift(body);
      ln--;
    }
    let section = '';
    for (let j = lineOf(offset) - 1; j >= 0; j--) {
      const m = /^\s*--\s*(PHASE\s+\d+.*?)\s*$/.exec(lines[j]);
      if (m) {
        section = m[1].trim();
        break;
      }
    }
    return [desc, section];
  };

  const result = parseSync(sql);
  for (const raw of result.stmts ?? []) {
    const stmt = raw.stmt;
    if (!stmt) continue;
    const loc = firstToken(raw.stmt_location ?? 0);

    if ('CreateEnumStmt' in stmt) {
      const name = svals(stmt.CreateEnumStmt.typeName).join('.');
      const short = name.split('.').pop() ?? name;
      enumTypes.add(short);
      extras.enums[short] = svals(stmt.CreateEnumStmt.vals);
    } else if ('CreateExtensionStmt' in stmt) {
      extras.extensions.push(stmt.CreateExtensionStmt.extname ?? '');
    } else if ('CreateStmt' in stmt) {
      const s = stmt.CreateStmt;
      const t = newTable(s.relation?.relname ?? '', s.relation?.schemaname || 'public');
      [t.description, t.section] = precedingComment(loc);
      t.source_line = lineOf(loc);
      for (const elt of s.tableElts ?? []) {
        if ('ColumnDef' in elt) {
          const e = elt.ColumnDef;
          const [rendered, base, length] = typeInfo(e.typeName);
          const c = newColumn({ name: e.colname ?? '', type: rendered, type_base: base, length, is_enum_type: enumTypes.has(base) });
          for (const cw of e.constraints ?? []) {
            if (!('Constraint' in cw)) continue;
            const k = cw.Constraint;
            switch (k.contype) {
              case 'CONSTR_NOTNULL': c.not_null = true; break;
              case 'CONSTR_DEFAULT': c.default = renderExpr(k.raw_expr); break;
              case 'CONSTR_PRIMARY': c.is_pk = true; c.not_null = true; t.pk = [c.name]; break;
              case 'CONSTR_UNIQUE': c.is_unique = true; t.uniques.push([c.name]); break;
              case 'CONSTR_CHECK': c.check = renderExpr(k.raw_expr); break;
              case 'CONSTR_FOREIGN':
                t.fks.push(newForeignKey(k.conname ?? null, [c.name], k.pktable?.relname ?? '', svals(k.pk_attrs),
                  DEL_ACTIONS[k.fk_del_action ?? ''] ?? 'NO ACTION'));
                break;
            }
          }
          t.columns.push(c);
        } else if ('Constraint' in elt) {
          applyTableConstraint(t, elt.Constraint);
        }
      }
      tables.set(t.name, t);
    } else if ('AlterTableStmt' in stmt) {
      pendingAlters.push(stmt.AlterTableStmt);
    } else if ('IndexStmt' in stmt) {
      const s = stmt.IndexStmt;
      const rel = s.relation?.relname ?? '';
      const t = tables.get(rel);
      if (!t) {
        extras.unparsed.push(`index on unknown table ${rel}`);
        continue;
      }
      const cols = (s.indexParams ?? []).map((p) => ('IndexElem' in p ? (p.IndexElem.name ? p.IndexElem.name : renderExpr(p.IndexElem.expr)) : ''));
      t.indexes.push(newIndex(s.idxname ?? null, cols, Boolean(s.unique), s.whereClause ? renderExpr(s.whereClause) : null, 'index'));
    } else if ('CommentStmt' in stmt) {
      const s = stmt.CommentStmt;
      const names = s.object && 'List' in s.object ? svals(s.object.List.items) : [];
      if (s.objtype === 'OBJECT_TABLE' && names.length) {
        const t = tables.get(names[names.length - 1]);
        if (t && s.comment) t.description.push(s.comment);
      } else if (s.objtype === 'OBJECT_COLUMN' && names.length >= 2) {
        const t = tables.get(names[names.length - 2]);
        const c = t ? col(t, names[names.length - 1]) : null;
        if (c && s.comment) c.comment = s.comment;
      }
    } else if ('CreatePolicyStmt' in stmt) {
      const s = stmt.CreatePolicyStmt;
      const t = tables.get(s.table?.relname ?? '');
      if (t) t.policies.push(s.policy_name ?? '');
    } else {
      extras.unparsed.push(kindOf(stmt));
    }
  }

  // ALTER TABLE after all CREATEs so forward references resolve
  for (const s of pendingAlters) {
    const rel = s.relation?.relname ?? '';
    const t = tables.get(rel);
    if (!t) {
      extras.unparsed.push(`ALTER on unknown table ${rel}`);
      continue;
    }
    for (const cw of s.cmds ?? []) {
      if (!('AlterTableCmd' in cw)) continue;
      const cmd = cw.AlterTableCmd;
      const def = cmd.def;
      switch (cmd.subtype) {
        case 'AT_AddConstraint':
          if (def && 'Constraint' in def) applyTableConstraint(t, def.Constraint);
          break;
        case 'AT_EnableRowSecurity':
        case 'AT_ForceRowSecurity':
          t.rls_enabled = true;
          break;
        case 'AT_AddColumn':
          if (def && 'ColumnDef' in def) {
            const [rendered, base, length] = typeInfo(def.ColumnDef.typeName);
            t.columns.push(newColumn({ name: def.ColumnDef.colname ?? '', type: rendered, type_base: base, length }));
          }
          break;
        case 'AT_DropColumn':
          t.columns = t.columns.filter((c) => c.name !== cmd.name);
          break;
      }
    }
  }

  // Inline source comments after a column ("-- Organization | User") become column comments
  harvestTrailingComments(tables, lines);

  // Derived facts
  derive(tables);
  return { tables, extras };
}

function applyTableConstraint(t: Table, c: Constraint): void {
  switch (c.contype) {
    case 'CONSTR_PRIMARY':
      t.pk = svals(c.keys);
      for (const k of t.pk) {
        const cc = col(t, k);
        if (cc) {
          cc.is_pk = true;
          cc.not_null = true;
        }
      }
      break;
    case 'CONSTR_UNIQUE': {
      const keys = svals(c.keys);
      t.uniques.push(keys);
      if (keys.length === 1) {
        const cc = col(t, keys[0]);
        if (cc) cc.is_unique = true;
      }
      break;
    }
    case 'CONSTR_CHECK': {
      const rendered = renderExpr(c.raw_expr);
      t.checks.push(rendered);
      // pg_dump writes every CHECK at table level, even one declared inline. A CHECK that
      // mentions exactly one column is that column's CHECK; the enum and singleton checks
      // read it from the column.
      const names = [...new Set(columnNames(c.raw_expr))];
      const cc = names.length === 1 ? col(t, names[0]) : null;
      if (cc && cc.check === null) cc.check = rendered;
      break;
    }
    case 'CONSTR_FOREIGN':
      t.fks.push(newForeignKey(c.conname ?? null, svals(c.fk_attrs), c.pktable?.relname ?? '', svals(c.pk_attrs),
        DEL_ACTIONS[c.fk_del_action ?? ''] ?? 'NO ACTION'));
      break;
  }
}

/** True when a CHECK pins a uniquely-constrained column to one constant, so the table can hold
 *  at most one row: `CHECK (id = 1)` on the primary key, or `CHECK (singleton)` on a boolean
 *  under a unique index (the fix the singleton-table finding suggests). */
function oneRowGuard(t: Table): boolean {
  const unique = (name: string): boolean =>
    (t.pk.length === 1 && t.pk[0] === name)
    || t.uniques.some((u) => u.length === 1 && u[0] === name)
    || t.indexes.some((ix) => ix.unique && !ix.where && ix.columns.length === 1 && ix.columns[0] === name);
  const pinned = (c: Column): boolean => {
    if (c.check === null) return false;
    if (c.check === c.name) return true;
    const m = /^(.+?) = (-?\d+(?:\.\d+)?|'[^']*'|TRUE|FALSE)$/.exec(c.check);
    return m !== null && m[1] === c.name;
  };
  return t.columns.some((c) => pinned(c) && unique(c.name));
}

/** Pick up `col TYPE ...,  -- some note` comments; strip our own ⚠ markers. */
function harvestTrailingComments(tables: Map<string, Table>, lines: string[]): void {
  const count = (s: string, ch: string): number => s.split(ch).length - 1;
  for (const t of tables.values()) {
    const start = t.source_line - 1;
    let depth = 0;
    for (let i = start; i < Math.min(start + 400, lines.length); i++) {
      const line = lines[i];
      depth += count(line, '(') - count(line, ')');
      const m = /^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s+\S.*?--\s*(.+?)\s*$/.exec(line);
      if (m) {
        const c = col(t, m[1]);
        const note = m[2].replace(/\s*⚠.*$/, '').trim();
        if (c && note && !c.comment) c.comment = note;
      }
      if (i > start && depth <= 0) break;
    }
  }
}

const sameSet = (a: string[], b: string[]): boolean => {
  const A = new Set(a);
  const B = new Set(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};

const isSuperset = (a: string[], b: Iterable<string>): boolean => {
  const A = new Set(a);
  return [...b].every((x) => A.has(x));
};

function derive(tables: Map<string, Table>): void {
  for (const t of tables.values()) {
    // PK and UNIQUE constraints are indexes too
    if (t.pk.length) t.indexes.unshift(newIndex(null, [...t.pk], true, null, 'pk'));
    for (const u of t.uniques) t.indexes.push(newIndex(null, [...u], true, null, 'unique-constraint'));
    for (const fk of t.fks) {
      fk.nullable = fk.columns.some((c) => {
        const cc = col(t, c);
        return !(cc && cc.not_null);
      });
      fk.unique = t.indexes.some((ix) => sameSet(ix.columns, fk.columns) && ix.unique && !ix.where);
      fk.indexed = t.indexes.some((ix) => sameSet(ix.columns.slice(0, fk.columns.length), fk.columns));
      fk.cardinality = fk.unique ? '1:1' : '1:N';
      for (const c of fk.columns) {
        const cc = col(t, c);
        if (cc) cc.is_fk = true;
      }
    }
  }
  for (const t of tables.values()) {
    for (const fk of t.fks) {
      const parent = tables.get(fk.ref_table);
      if (parent) {
        parent.referenced_by.push({ table: t.name, columns: fk.columns, on_delete: fk.on_delete, cardinality: fk.cardinality });
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Checks
// ----------------------------------------------------------------------------

const ENUMISH_NAMES = /(^|_)(status|state|type|kind|mode|selection|category|level|role|scope|visibility)$/;
const AUDIT_COLS = new Set(['created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'id']);
const SEV_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export class Reviewer {
  private readonly t: Map<string, Table>;
  private readonly n: Narratives;
  private readonly a: Narratives;
  private readonly findings: Finding[] = [];
  private seq = 0;
  private readonly domainOf = new Map<string, Narratives>();

  constructor(tables: Map<string, Table>, narratives: Narratives | null | undefined) {
    this.t = tables;
    this.n = narratives ?? {};
    this.a = this.n.assertions ?? {};
    for (const d of (this.n.domains ?? []) as Narratives[]) {
      for (const name of (d.tables ?? []) as string[]) {
        this.domainOf.set(name, d);
        const t = tables.get(name);
        if (t) t.domain = d.key;
      }
    }
  }

  add(check: string, severity: Severity, table: string, columns: string[], title: string,
    detail: string, suggestion = '', fixSql = ''): void {
    this.seq += 1;
    const f: Finding = { id: `F${String(this.seq).padStart(3, '0')}`, check, severity, table, columns, title, detail, suggestion, fix_sql: fixSql };
    this.findings.push(f);
    this.t.get(table)?.findings.push(f.id);
  }

  // -- helpers ---------------------------------------------------------
  tenantTable(): string | null {
    return this.a.tenant_table ?? null;
  }

  tenantCol(): string {
    return this.a.tenant_column ?? 'tenant_id';
  }

  isGlobal(name: string): boolean {
    if (((this.a.global_tables ?? []) as string[]).includes(name)) return true;
    if (name === this.tenantTable()) return true;
    const d = this.domainOf.get(name);
    return Boolean(d) && d!.tenant_scoped === false;
  }

  run(): Finding[] {
    for (const fn of [this.chkDomainCoverage, this.chkPrimaryKey, this.chkFkIndex,
      this.chkFkNullable, this.chkFkDeleteAction, this.chkCardinalityAssertions,
      this.chkRelationshipNotes, this.chkNaturalKeys, this.chkJunctionTables, this.chkEnumish,
      this.chkSoftDeleteUnique, this.chkPolymorphic, this.chkExclusiveArc,
      this.chkTimestamps, this.chkMoney, this.chkTenantScoping, this.chkRls,
      this.chkOrphans, this.chkSingletons, this.chkFkCycles, this.chkBlastRadius,
      this.chkWideTables]) {
      fn.call(this);
    }
    this.findings.sort((x, y) => {
      if (SEV_RANK[x.severity] !== SEV_RANK[y.severity]) return SEV_RANK[x.severity] - SEV_RANK[y.severity];
      if (x.table !== y.table) return x.table < y.table ? -1 : 1;
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
    return this.findings;
  }

  // -- the checks ------------------------------------------------------
  chkDomainCoverage(): void {
    if (!(this.n.domains ?? []).length) return;
    for (const name of this.t.keys()) {
      if (!this.domainOf.has(name)) {
        this.add('domain-coverage', 'error', name, [], 'Table is in no domain',
          'Every table must be claimed by a domain in narratives.json, otherwise it silently '
          + 'falls out of the documentation and of any per-domain backup/retention policy.',
          "Add it to the right domain's `tables` list, or delete the table if it is dead.");
      }
    }
    for (const [name, d] of this.domainOf) {
      if (!this.t.has(name)) {
        this.add('domain-coverage', 'error', name, [], 'Domain lists a table that does not exist',
          `Domain \`${d.key}\` claims \`${name}\` but the schema has no such table — likely a `
          + 'rename that never reached the narratives.',
          'Fix or remove the entry.');
      }
    }
  }

  chkPrimaryKey(): void {
    for (const t of this.t.values()) {
      if (!t.pk.length) {
        this.add('primary-key', 'error', t.name, [], 'No primary key',
          'Without a primary key rows are not individually addressable: no safe UPDATE/DELETE '
          + 'of one row, no logical replication, ORMs misbehave, and duplicates are legal.',
          'Add a natural composite key or a surrogate id.',
          `ALTER TABLE ${t.name} ADD PRIMARY KEY (...);`);
      }
    }
  }

  chkFkIndex(): void {
    for (const t of this.t.values()) {
      for (const fk of t.fks) {
        if (!fk.indexed) {
          const cols = fk.columns.join(', ');
          this.add('fk-index', 'warn', t.name, fk.columns, 'Foreign key without index',
            'PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on '
            + `\`${fk.ref_table}\` must scan \`${t.name}\` to check the constraint, and every join `
            + 'from the parent side is a sequential scan.',
            'Add an index on the FK column(s).',
            `CREATE INDEX CONCURRENTLY idx_${t.name}_${fk.columns.join('_')} ON ${t.name}(${cols});`);
        }
      }
    }
  }

  chkFkNullable(): void {
    const arcs = new Set<string>();
    for (const x of (this.a.exclusive_arcs ?? []) as Narratives[]) {
      for (const c of x.columns as string[]) arcs.add(`${x.table} ${c}`);
    }
    for (const t of this.t.values()) {
      for (const fk of t.fks) {
        if (fk.nullable && !fk.columns.some((c) => arcs.has(`${t.name} ${c}`))) {
          this.add('fk-nullable', 'info', t.name, fk.columns, 'Nullable foreign key',
            `\`${[t.name, ...fk.columns].join('.')}\` may be NULL, so the relationship to `
            + `\`${fk.ref_table}\` is optional. That is legitimate (e.g. approved_by before approval) `
            + 'but often a modelling shrug: a row with no owner, or two nullable FKs that are '
            + 'secretly an either/or.',
            'Confirm the optionality is a domain rule; document it in the column comment.');
        }
      }
    }
  }

  chkFkDeleteAction(): void {
    const tt = this.tenantTable();
    for (const t of this.t.values()) {
      for (const fk of t.fks) {
        if (fk.on_delete === 'NO ACTION' && fk.ref_table === tt) {
          this.add('fk-on-delete', 'info', t.name, fk.columns,
            'Tenant FK relies on the default ON DELETE NO ACTION',
            `Deleting a \`${tt}\` row will fail while \`${t.name}\` rows exist. Fine if tenants are `
            + 'never hard-deleted; a surprise the day offboarding/GDPR erasure is built.',
            'State the intent explicitly: CASCADE, RESTRICT, or an offboarding job.');
        }
      }
    }
  }

  chkCardinalityAssertions(): void {
    for (const a of (this.a.cardinality ?? []) as Narratives[]) {
      const child = this.t.get(a.child);
      if (!child) continue;
      const fks = child.fks.filter((fk) => fk.ref_table === a.parent
        && (!Array.isArray(a.columns) || sameSet(a.columns as string[], fk.columns)));
      if (!fks.length) {
        this.add('cardinality', 'error', a.child, [], 'Asserted relationship has no foreign key',
          `narratives.json says \`${a.parent}\` → \`${a.child}\` ${a.expect ? `is ${a.expect}` : 'exists'}, but there is `
          + 'no FK from the child to the parent. The relationship exists only in application code.',
          'Add the FK, or correct the narrative.');
        continue;
      }
      for (const fk of fks) {
        if (a.expect === '1:1' && !fk.unique) {
          const cols = fk.columns.join(', ');
          this.add('cardinality', 'error', a.child, fk.columns,
            'Modelled 1:N but intended 1:1',
            `The narrative says each \`${a.parent}\` has exactly one \`${a.child}\`, but `
            + `\`${cols}\` is not UNIQUE, so the database happily stores five. Application code `
            + 'that does `.single()` or `LIMIT 1` will return an arbitrary row.',
            'Make the FK column(s) unique — or make it the primary key.',
            `ALTER TABLE ${a.child} ADD CONSTRAINT ${a.child}_${fk.columns.join('_')}_key UNIQUE (${cols});`);
        } else if (a.expect === '1:N' && fk.unique) {
          this.add('cardinality', 'warn', a.child, fk.columns,
            'Modelled 1:1 but intended 1:N',
            `The narrative expects many \`${a.child}\` per \`${a.parent}\`, but the FK is `
            + 'UNIQUE, so the second child will fail to insert.',
            'Drop the unique constraint, or fix the narrative.');
        }
      }
    }
  }

  chkRelationshipNotes(): void {
    if (!this.a.require_relationship_notes) return;
    for (const t of this.t.values()) {
      for (const r of relationships(t, this.n)) {
        if (r.why) continue;
        const cols = r.columns.join(', ');
        const ambiguous = t.fks.filter((k) => k.ref_table === r.parent).length > 1;
        this.add('undocumented-relationship', 'info', t.name, r.columns, 'Relationship has no narrative',
          `\`${t.name}.${cols}\` → \`${r.parent}\` is ${describeRelationship(r)}, but narratives.json `
          + 'does not say why the relationship exists, so the docs show the constraint and nothing else.',
          `Add a \`why\` to the \`${r.parent}\` → \`${t.name}\` entry in assertions.cardinality `
          + '(create the entry if it is missing; `expect` is optional)'
          + (ambiguous ? `, and give it \`"columns": [${r.columns.map((c) => `"${c}"`).join(', ')}]\` because `
            + `\`${t.name}\` has more than one foreign key to \`${r.parent}\`.` : '.'));
      }
    }
  }

  chkNaturalKeys(): void {
    for (const nk of (this.a.natural_keys ?? []) as Narratives[]) {
      const t = this.t.get(nk.table);
      if (!t) continue;
      const cols = nk.columns as string[];
      if (!t.indexes.some((ix) => sameSet(ix.columns, cols) && ix.unique)) {
        this.add('natural-key', 'error', t.name, cols, 'Asserted natural key is not enforced',
          `\`(${cols.join(', ')})\` is declared to identify a \`${t.name}\` row, but nothing enforces `
          + 'it. Retries, double-submits and webhook redeliveries create duplicates.',
          'Add a unique constraint (partial if the table is soft-deleted).',
          `ALTER TABLE ${t.name} ADD CONSTRAINT ${t.name}_${cols.join('_')}_key UNIQUE (${cols.join(', ')});`);
      }
    }
  }

  /** Return the linking FK columns if `t` looks like a pure many-to-many link table. */
  isJunction(t: Table): Set<string> | null {
    const tt = this.tenantTable();
    const linkFks = t.fks.filter((fk) => fk.ref_table !== tt);
    if (linkFks.length !== 2 || linkFks.some((fk) => fk.nullable)) return null;
    const fkCols = new Set(linkFks.flatMap((fk) => fk.columns));
    const payload = t.columns.filter((c) => !fkCols.has(c.name) && !AUDIT_COLS.has(c.name) && c.name !== this.tenantCol());
    return payload.length <= 1 ? fkCols : null;
  }

  chkJunctionTables(): void {
    for (const t of this.t.values()) {
      const fkCols = this.isJunction(t);
      if (!fkCols) continue;
      if (t.indexes.some((ix) => isSuperset(ix.columns, fkCols) && ix.unique)) continue;
      const sorted = [...fkCols].sort();
      this.add('junction-uniqueness', 'error', t.name, sorted,
        'Junction table allows duplicate links',
        `\`${t.name}\` looks like a many-to-many link table but has no unique constraint across `
        + `(${sorted.join(', ')}). The same pair can be inserted twice; every join through it `
        + 'will double-count.',
        'Use the FK pair as the primary key (or add a UNIQUE).',
        `ALTER TABLE ${t.name} ADD PRIMARY KEY (${sorted.join(', ')});`);
    }
  }

  chkEnumish(): void {
    for (const t of this.t.values()) {
      for (const c of t.columns) {
        if (c.is_fk || c.is_enum_type || c.check) continue;
        const short = ['varchar', 'char', 'text'].includes(c.type_base) && (c.length === null || c.length <= 32);
        if (short && ENUMISH_NAMES.test(c.name)) {
          const hint = c.comment ? ` The comment lists \`${c.comment}\`, i.e. the values are known.` : '';
          this.add('undocumented-enum', 'warn', t.name, [c.name],
            'Enum-like column with no CHECK',
            `\`${c.name}\` is a short string that clearly takes a fixed set of values, but the `
            + 'database accepts anything. Typos become new states, and nobody can list the '
            + `legal values without reading application code.${hint}`,
            'Add a CHECK constraint (cheap, easy to evolve) or a lookup table if values need '
            + 'metadata. Avoid native ENUM types unless the set is truly frozen.',
            `ALTER TABLE ${t.name} ADD CONSTRAINT ${t.name}_${c.name}_check CHECK (${c.name} IN (...));`);
        }
      }
    }
  }

  chkSoftDeleteUnique(): void {
    for (const t of this.t.values()) {
      if (!col(t, 'deleted_at')) continue;
      for (const ix of t.indexes) {
        if (ix.unique && ix.source !== 'pk' && !ix.where) {
          const cols = ix.columns.join(', ');
          this.add('soft-delete-unique', 'warn', t.name, ix.columns,
            'Soft delete collides with non-partial UNIQUE',
            `\`${t.name}\` soft-deletes via \`deleted_at\`, but \`(${cols})\` is unique across live AND `
            + 'deleted rows. A user who deletes their account can never sign up again with the '
            + 'same value, and `ON CONFLICT` upserts will resurrect ghosts.',
            'Replace with a partial unique index scoped to live rows.',
            `DROP CONSTRAINT/INDEX ...; CREATE UNIQUE INDEX ${t.name}_${ix.columns.join('_')}_live `
            + `ON ${t.name}(${cols}) WHERE deleted_at IS NULL;`);
        }
      }
    }
  }

  chkPolymorphic(): void {
    for (const t of this.t.values()) {
      for (const c of t.columns) {
        const m = /^(.*)_type$/.exec(c.name);
        if (!m) continue;
        const idc = col(t, `${m[1]}_id`);
        if (idc && !idc.is_fk) {
          this.add('polymorphic-reference', 'warn', t.name, [c.name, idc.name],
            'Polymorphic reference without referential integrity',
            `\`${idc.name}\` points at different tables depending on \`${c.name}\`. No FK can express `
            + 'that, so orphans accumulate silently and every join needs a CASE. Acceptable for '
            + 'append-only audit data; painful anywhere the target must still exist.',
            'Either one nullable FK per target with a CHECK that exactly one is set, or a '
            + 'supertype table that the targets reference.');
        }
      }
    }
  }

  chkExclusiveArc(): void {
    const declared = new Map<string, string[]>();
    for (const x of (this.a.exclusive_arcs ?? []) as Narratives[]) declared.set(x.table, x.columns);
    for (const t of this.t.values()) {
      const nullableFks = t.fks.filter((fk) => fk.nullable && fk.columns.length === 1 && !fk.columns[0].endsWith('_by'));
      let cols = nullableFks.map((fk) => fk.columns[0]);
      const isDeclared = declared.has(t.name);
      if (isDeclared) cols = declared.get(t.name)!;
      else if (cols.length < 2) continue;
      const guarded = t.checks.some((chk) => cols.every((c) => chk.includes(c)));
      if (!guarded) {
        const num = cols.map((c) => `(${c} IS NOT NULL)::int`).join(' + ');
        this.add('exclusive-arc', isDeclared ? 'warn' : 'info', t.name, cols,
          'Either/or foreign keys without a CHECK',
          `\`${t.name}\` has several nullable FKs (${cols.join(', ')}) that look like an exclusive `
          + 'arc — a row should point at exactly one of them. Nothing stops zero or both.',
          'Add a CHECK that exactly one is non-null, or restructure with a supertype.',
          `ALTER TABLE ${t.name} ADD CONSTRAINT ${t.name}_one_target CHECK (${num} = 1);`);
      }
    }
  }

  chkTimestamps(): void {
    for (const t of this.t.values()) {
      for (const c of t.columns) {
        if (c.type_base === 'timestamp') {
          this.add('timestamp-tz', 'info', t.name, [c.name], 'TIMESTAMP without time zone',
            `\`${c.name}\` stores wall-clock time with no zone. It reads back differently depending `
            + "on the session's TimeZone, and DST transitions produce ambiguous values.",
            'Use TIMESTAMPTZ.',
            `ALTER TABLE ${t.name} ALTER COLUMN ${c.name} TYPE timestamptz;`);
        }
      }
    }
  }

  chkMoney(): void {
    for (const t of this.t.values()) {
      for (const c of t.columns) {
        if (['double precision', 'real'].includes(c.type_base)
          && /(amount|price|cost|total|fee|balance|rate|tax|net|gross)/.test(c.name)) {
          this.add('money-float', 'error', t.name, [c.name], 'Monetary value stored as float',
            `\`${c.name}\` is binary floating point. 0.1 + 0.2 ≠ 0.3; sums drift; reconciliation `
            + 'against the ledger will be off by cents.',
            'Use NUMERIC(p, s) or integer minor units.',
            `ALTER TABLE ${t.name} ALTER COLUMN ${c.name} TYPE numeric(14,2);`);
        }
      }
    }
  }

  chkTenantScoping(): void {
    const tt = this.tenantTable();
    const tc = this.tenantCol();
    if (!tt || !this.t.has(tt)) return;
    const graph = new Map<string, string[]>();
    for (const [name, t] of this.t) graph.set(name, t.fks.map((fk) => fk.ref_table));
    const hasDomains = Boolean((this.n.domains ?? []).length);
    for (const t of this.t.values()) {
      if (this.isGlobal(t.name) || col(t, tc) || (hasDomains && t.domain === null)) continue;
      const p = shortestPath(graph, t.name, tt);
      if (p) {
        const hops = p.join(' → ');
        const sev: Severity = this.isJunction(t) ? 'info' : 'warn';
        this.add('tenant-derivable', sev, t.name, [], `No \`${tc}\`; tenant only reachable via ${p.length - 1} join(s)`,
          `\`${t.name}\` belongs to a tenant only transitively (${hops}). Row-level security, `
          + 'per-tenant export/erasure, and per-tenant sharding all need that join. It works at 10 '
          + 'tenants and hurts at 1,000.',
          `Denormalise \`${tc}\` onto the table (with a composite FK to keep it consistent), or accept `
          + 'the join and write the RLS policy as a subquery now, while it is cheap.');
      } else {
        this.add('tenant-unscoped', 'error', t.name, [],
          'Tenant-scoped domain but no path to the tenant',
          `\`${t.name}\` sits in a tenant-scoped domain yet neither has \`${tc}\` nor references anything `
          + 'that leads to it. Its rows cannot be attributed to a tenant at all.',
          `Add \`${tc}\` (NOT NULL, FK) or move the table to a global domain in narratives.json.`);
      }
    }
  }

  chkRls(): void {
    if (!this.a.require_rls) return;
    const tc = this.tenantCol();
    const hasDomains = Boolean((this.n.domains ?? []).length);
    for (const t of this.t.values()) {
      if (this.isGlobal(t.name) || !col(t, tc) || (hasDomains && t.domain === null)) continue;
      if (!t.rls_enabled) {
        this.add('rls-missing', 'error', t.name, [tc], 'Tenant table without row-level security',
          `\`${t.name}\` carries \`${tc}\` but RLS is not enabled, so isolation depends entirely on every `
          + 'query remembering the WHERE clause. One forgotten filter is a cross-tenant leak.',
          'Enable RLS and add the standard policy.',
          `ALTER TABLE ${t.name} ENABLE ROW LEVEL SECURITY;\nCREATE POLICY ${t.name}_tenant_isolation ON `
          + `${t.name} USING (${tc} = current_setting('app.tenant_id')::uuid);`);
      } else if (!t.policies.length) {
        this.add('rls-no-policy', 'error', t.name, [tc], 'RLS enabled but no policy',
          'With RLS on and no policy, non-owner roles see zero rows — usually discovered in staging '
          + "as 'the table is empty'.", 'Add a policy.');
      }
    }
  }

  chkOrphans(): void {
    for (const t of this.t.values()) {
      if (!t.fks.length && !t.referenced_by.length) {
        this.add('orphan-table', 'info', t.name, [], 'Isolated table',
          `\`${t.name}\` references nothing and nothing references it. Either it is a staging/log `
          + 'table (fine, say so), or it is dead, or it is the seed of a second data model growing '
          + 'beside the first.',
          'Document its purpose or drop it.');
      }
    }
  }

  chkSingletons(): void {
    for (const name of (this.a.singleton_tables ?? []) as string[]) {
      const t = this.t.get(name);
      if (!t || oneRowGuard(t)) continue;
      const guard = t.indexes.some((ix) => ix.source !== 'pk' && ix.unique && !ix.where);
      this.add('singleton-table', 'info', name, [], 'Single-row configuration table',
        `\`${name}\` is documented as holding exactly one row. Nothing enforces that`
        + `${guard ? '' : ' (no unique constraint besides the PK)'}, and the day a second `
        + 'instance is needed (a second GitHub App, a staging vs prod config) every reader that '
        + 'does `SELECT * ... LIMIT 1` becomes wrong.',
        'Either enforce one row (CHECK on a constant column with a UNIQUE) or give it a '
        + 'discriminator now (`provider_id`, `environment`) while there is only one row to backfill.',
        `ALTER TABLE ${name} ADD COLUMN singleton boolean NOT NULL DEFAULT true CHECK (singleton);\n`
        + `CREATE UNIQUE INDEX ${name}_one_row ON ${name}(singleton);`);
    }
  }

  chkFkCycles(): void {
    const graph = new Map<string, Set<string>>();
    for (const [name, t] of this.t) graph.set(name, new Set(t.fks.map((fk) => fk.ref_table).filter((r) => r !== name)));
    const seen = new Set<string>();
    const cycles: string[][] = [];
    const dfs = (n: string, p: string[]): void => {
      const at = p.indexOf(n);
      if (at !== -1) {
        cycles.push([...p.slice(at), n]);
        return;
      }
      if (seen.has(n)) return;
      seen.add(n);
      for (const m of graph.get(n) ?? []) dfs(m, [...p, n]);
    };
    for (const n of graph.keys()) dfs(n, []);
    const reported = new Set<string>();
    for (const cyc of cycles) {
      const key = [...new Set(cyc)].sort().join(' ');
      if (reported.has(key)) continue;
      reported.add(key);
      this.add('fk-cycle', 'warn', cyc[0], [], 'Foreign-key cycle',
        `${cyc.join(' → ')}. Rows must be inserted with a deferred constraint or a NULL-then-update `
        + 'dance; backups/restores and truncation have no valid order; ON DELETE CASCADE can loop.',
        'Break the cycle (move one FK to a link table) or mark one FK DEFERRABLE INITIALLY DEFERRED.');
    }
  }

  chkBlastRadius(): void {
    const ranked = [...this.t.values()].sort((x, y) => y.referenced_by.length - x.referenced_by.length);
    for (const t of ranked.slice(0, 3)) {
      if (t.referenced_by.length >= 5) {
        this.add('blast-radius', 'info', t.name, [], `Hub table: referenced by ${t.referenced_by.length} tables`,
          'Any change to its key, its delete semantics, or its partitioning touches every '
          + 'dependent. Migrations on hub tables need the longest lock windows and the most careful '
          + 'rollout.',
          'Treat schema changes here as breaking changes with a written rollout plan.');
      }
    }
  }

  chkWideTables(): void {
    for (const t of this.t.values()) {
      if (t.columns.length >= 30) {
        this.add('wide-table', 'info', t.name, [], `Wide table (${t.columns.length} columns)`,
          'Tables this wide usually hide several entities (or a JSON column that wants to be '
          + 'one). Every row update rewrites the whole tuple; TOAST kicks in; indexes bloat.',
          'Look for column groups that always change together and split them out.');
      }
    }
  }
}

function shortestPath(graph: Map<string, string[]>, start: string, goal: string): string[] | null {
  const prev = new Map<string, string | null>([[start, null]]);
  const queue: string[] = [start];
  while (queue.length) {
    const n = queue.shift()!;
    if (n === goal) {
      const p: string[] = [];
      for (let cur: string | null = n; cur !== null; cur = prev.get(cur) ?? null) p.push(cur);
      return p.reverse();
    }
    for (const m of graph.get(n) ?? []) {
      if (!prev.has(m)) {
        prev.set(m, n);
        queue.push(m);
      }
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

interface Stats {
  tables: number;
  columns: number;
  foreign_keys: number;
  domains: number;
  findings: Record<Severity, number>;
}

const SEVERITIES: Severity[] = ['error', 'warn', 'info'];
const SEV_LABEL: Record<Severity, string> = { error: 'Error', warn: 'Warning', info: 'Note' };

function utcNowSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function modelToJson(tables: Map<string, Table>, extras: Extras, narratives: Narratives, findings: Finding[], source: string): Record<string, any> {
  const all = [...tables.values()];
  const count = (sev: Severity): number => findings.filter((f) => f.severity === sev).length;
  return {
    generated_at: utcNowSeconds(),
    source,
    stats: {
      tables: tables.size,
      columns: all.reduce((n, t) => n + t.columns.length, 0),
      foreign_keys: all.reduce((n, t) => n + t.fks.length, 0),
      domains: (narratives.domains ?? []).length,
      findings: { error: count('error'), warn: count('warn'), info: count('info') },
    },
    database: narratives.database ?? {},
    conventions: narratives.conventions ?? [],
    domains: narratives.domains ?? [],
    assertions: narratives.assertions ?? {},
    extras,
    tables: Object.fromEntries(tables),
    findings,
  };
}

export interface Relationship {
  child: string;
  columns: string[];
  parent: string;
  ref_columns: string[];
  cardinality: string;
  required: boolean;
  on_delete: string;
  indexed: boolean;
  why: string | null;
}

/** One entry per foreign key of `t`: what the schema enforces, plus the `why` from the matching
 *  `assertions.cardinality` entry in narratives.json when someone has written one. */
export function relationships(t: Table, narratives: Narratives | null | undefined): Relationship[] {
  const notes = ((narratives?.assertions ?? {}).cardinality ?? []) as Narratives[];
  return t.fks.map((fk) => {
    // An entry naming `columns` belongs to that foreign key alone. One without applies only
    // when the pair is unambiguous, so two foreign keys to one parent never share a sentence.
    const candidates = notes.filter((a) => a.parent === fk.ref_table && a.child === t.name
      && typeof a.why === 'string' && a.why.trim() !== '');
    const siblings = t.fks.filter((k) => k.ref_table === fk.ref_table).length;
    const note = candidates.find((a) => Array.isArray(a.columns) && sameSet(a.columns as string[], fk.columns))
      ?? (siblings === 1 ? candidates.find((a) => !Array.isArray(a.columns)) : undefined);
    return {
      child: t.name, columns: fk.columns, parent: fk.ref_table, ref_columns: fk.ref_columns,
      cardinality: fk.cardinality, required: !fk.nullable, on_delete: fk.on_delete, indexed: fk.indexed,
      why: note ? (note.why as string).trim() : null,
    };
  });
}

/** The enforced facts of a relationship in words: `one org, many widget · required · ON DELETE CASCADE · indexed`. */
export function describeRelationship(r: Relationship): string {
  const shape = r.cardinality === '1:1' ? `one ${r.parent}, at most one ${r.child}` : `one ${r.parent}, many ${r.child}`;
  return `${shape} · ${r.required ? 'required' : 'optional'} · ON DELETE ${r.on_delete} · ${r.indexed ? 'indexed' : 'not indexed'}`;
}

// Diagram geometry, in px. Text widths come from character counts, so the output is deterministic
// and needs no font metrics; the page CSS gives the classes their colours (a standalone .svg file
// embeds ERD_STYLE instead, because it has no page).
const ERD = { charW: 7.2, rowH: 18, headH: 28, pad: 10, gapX: 48, gapY: 76, margin: 24, minW: 120, loop: 26 };

// Literal palette for standalone .svg files: the light half of the page palette, light background,
// dark strokes, no var(--) references — an .svg on disk inherits nothing.
// ponytail: this is a hand-kept copy of the page's .erd rules below (hex for var(--…)); a tweak
// to one must be made in the other. One token map rendered twice is the upgrade if it drifts.
const ERD_STYLE = 'svg{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}'
  + '.bg{fill:#fbfaf7}.bx{fill:#ffffff;stroke:#1d2430;stroke-width:1.2}.hd{fill:#e2ddd3}'
  + '.stub .bx{stroke:#6b7280;stroke-dasharray:4 3}.stub .hd{fill:none}'
  + '.lbl{paint-order:stroke;stroke:#fbfaf7;stroke-width:3}'
  + '.ttl{font-weight:700;fill:#1d2430}.col{fill:#1d2430}.typ,.lbl{fill:#6b7280;font-size:11px}'
  + '.key{fill:#1f5f8b;font-weight:700;font-size:10px}'
  + '.ln,.end path{fill:none;stroke:#1d2430;stroke-width:1.2}'
  + '.end circle{fill:#ffffff;stroke:#1d2430;stroke-width:1.2}';

interface ErdBox {
  name: string;
  stub: boolean;
  columns: Column[];
  w: number;
  h: number;
  x: number;
  y: number;
  layer: number;
}

/** Crow's-foot glyph for one end of an edge, drawn at the box edge with +x pointing along the line. */
function erdEnd(kind: string, x: number, y: number, angle: number, side: string): string {
  const paths: Record<string, string> = {
    one: 'M8,-6 L8,6',
    'zero-one': 'M8,-6 L8,6',
    many: 'M0,-6 L12,0 M0,0 L12,0 M0,6 L12,0',
  };
  const circle = kind === 'zero-one' ? '<circle cx="18" cy="0" r="4"/>' : '';
  return `<g class="end ${side}-${kind}" transform="translate(${x},${y}) rotate(${angle})"><path d="${paths[kind]}"/>${circle}</g>`;
}

/** An entity-relationship diagram of `names` as self-contained SVG: every named table in full,
 *  a stub box for each parent referenced from outside the set, and one edge per foreign key
 *  with crow's-foot ends derived from the schema. Parents sit above children. With `standalone`
 *  the SVG carries its own palette and background, for writing to an .svg file. */
export function svgErd(tables: Map<string, Table>, names: string[], standalone = false): string {
  const e = escapeHtml;
  const inSet = names.filter((n) => tables.has(n));
  const stubs = [...new Set(inSet.flatMap((n) => tables.get(n)!.fks.map((fk) => fk.ref_table)))]
    .filter((p) => !inSet.includes(p)).sort();

  const boxes = new Map<string, ErdBox>();
  const boxFor = (name: string, stub: boolean, columns: Column[]): ErdBox => {
    const textW = Math.max(name.length + 2, ...columns.map((c) => c.name.length + c.type.length + 7));
    return {
      name, stub, columns, layer: 0, x: 0, y: 0,
      w: Math.max(ERD.minW, Math.ceil(textW * ERD.charW) + 2 * ERD.pad),
      h: ERD.headH + (stub ? 0 : columns.length * ERD.rowH + ERD.pad),
    };
  };
  for (const n of inSet) boxes.set(n, boxFor(n, false, tables.get(n)!.columns));
  for (const s of stubs) boxes.set(s, boxFor(s, true, []));

  // Layer = longest parent chain inside the set; a cycle is cut where it closes.
  const visiting = new Set<string>();
  const layerOf = (n: string): number => {
    const b = boxes.get(n)!;
    if (b.stub) return 0;
    if (visiting.has(n)) return 0;
    visiting.add(n);
    const parents = tables.get(n)!.fks.map((fk) => fk.ref_table).filter((p) => p !== n && boxes.has(p));
    b.layer = parents.reduce((m, p) => Math.max(m, layerOf(p) + 1), 0);
    visiting.delete(n);
    return b.layer;
  };
  for (const n of inSet) layerOf(n);

  const layers = new Map<number, ErdBox[]>();
  for (const b of [...boxes.values()].sort((a, c) => (a.name < c.name ? -1 : 1))) {
    layers.set(b.layer, [...(layers.get(b.layer) ?? []), b]);
  }
  // Rows of boxes, parents above children. layerTop/layerBottom describe each row's extent, so
  // an edge's horizontal run always sits in the empty gap between two rows, never across a box.
  const layerTop: number[] = [];
  const layerBottom: number[] = [];
  let y = ERD.margin;
  let width = 0;
  for (const l of [...layers.keys()].sort((a, c) => a - c)) {
    let x = ERD.margin;
    let rowH = 0;
    for (const b of layers.get(l)!) {
      b.x = x;
      b.y = y;
      x += b.w + ERD.gapX;
      rowH = Math.max(rowH, b.h);
    }
    width = Math.max(width, x - ERD.gapX);
    layerTop[l] = y;
    layerBottom[l] = y + rowH;
    y += rowH + ERD.gapY;
  }
  const gapMid = (upper: number, lower: number): number => (layerBottom[upper] + layerTop[lower]) / 2;
  let maxX = width;
  const H = Math.ceil(y - ERD.gapY + ERD.margin);

  const out: string[] = [];
  for (const b of boxes.values()) {
    const cls = b.stub ? 'tbl stub' : 'tbl';
    const parts = [`<g class="${cls}" id="erd-${e(b.name)}">`,
      `<rect class="bx" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5"/>`,
      `<rect class="hd" x="${b.x}" y="${b.y}" width="${b.w}" height="${ERD.headH}" rx="5"/>`,
      `<text class="ttl" x="${b.x + b.w / 2}" y="${b.y + 18}" text-anchor="middle">${e(b.name)}</text>`];
    b.columns.forEach((c, i) => {
      const ry = b.y + ERD.headH + (i + 1) * ERD.rowH - 5;
      const key = c.is_pk ? ' <tspan class="key">PK</tspan>' : c.is_fk ? ' <tspan class="key">FK</tspan>' : '';
      parts.push(`<text class="col" x="${b.x + ERD.pad}" y="${ry}">${e(c.name)}${key}</text>`,
        `<text class="typ" x="${b.x + b.w - ERD.pad}" y="${ry}" text-anchor="end">${e(c.type)}</text>`);
    });
    parts.push('</g>');
    out.push(parts.join(''));
  }

  const inbound = new Map<string, number>();
  let channels = 0;               // edges routed down the right-hand side, each in its own lane
  // Labels near a child's top edge are placed only after every edge is drawn, so each can dodge
  // the other labels of its row and the lines and markers that cross the label area.
  type PendingLabel = { g: number; x: number; w: number; top: number; label: string };
  const pending: PendingLabel[] = [];
  const obstacles = new Map<string, { x0: number; x1: number }[]>();
  const block = (g: number, band: number, x0: number, x1: number): void => {
    const k = `${g}:${band}`;
    obstacles.set(k, [...(obstacles.get(k) ?? []), { x0, x1 }]);
  };
  for (const n of inSet) {
    const t = tables.get(n)!;
    const child = boxes.get(n)!;
    t.fks.forEach((fk, i) => {
      const parent = boxes.get(fk.ref_table)!;
      const pEnd = fk.nullable ? 'zero-one' : 'one';
      const cEnd = fk.unique ? 'one' : 'many';
      const label = fk.columns.join(', ');
      const row = child.columns.findIndex((c) => c.name === fk.columns[0]);
      const cy = child.y + ERD.headH + (Math.max(row, 0) + 0.5) * ERD.rowH;
      let path: string;
      let ends: string;
      let text: string;
      if (parent === child) {
        // Self-reference: a loop off the right edge, from the column row up to the header.
        const x0 = child.x + child.w;
        const xr = x0 + ERD.loop;
        const y1 = child.y + ERD.headH / 2;
        path = `M${x0},${cy} H${xr} V${y1} H${x0}`;
        ends = erdEnd(cEnd, x0, cy, 0, 'c') + erdEnd(pEnd, x0, y1, 0, 'p');
        text = `<text class="lbl" x="${xr + 4}" y="${(cy + y1) / 2 + 4}">${e(label)}</text>`;
        maxX = Math.max(maxX, xr + 4 + label.length * ERD.charW);
      } else if (parent.layer < child.layer) {
        // Parent above. Leave the child's top, arrive at the parent's bottom, with attachment
        // points spread so siblings do not overlap. A parent more than one row up is reached
        // through a lane on the right, so the line never crosses the rows in between.
        const k = inbound.get(parent.name) ?? 0;
        inbound.set(parent.name, k + 1);
        const cx = child.x + (child.w * (i + 1)) / (t.fks.length + 1);
        const px = parent.x + (parent.w * ((k % 5) + 1)) / 6;
        const py = parent.y + parent.h;
        const up = gapMid(child.layer - 1, child.layer);
        if (child.layer - parent.layer === 1) {
          path = `M${cx},${child.y} V${up} H${px} V${py}`;
        } else {
          const xr = width + ERD.loop + channels * 12;
          channels += 1;
          const down = gapMid(parent.layer, parent.layer + 1);
          path = `M${cx},${child.y} V${up} H${xr} V${down} H${px} V${py}`;
          maxX = Math.max(maxX, xr);
          for (let g = parent.layer + 1; g <= child.layer; g += 1) {
            block(g, 1, xr - 2, xr + 2);
            block(g, 2, xr - 2, xr + 2);
            if (g < child.layer) block(g, 0, xr - 2, xr + 2);
          }
        }
        ends = erdEnd(cEnd, cx, child.y, -90, 'c') + erdEnd(pEnd, px, py, 90, 'p');
        // The label is placed after every edge is drawn (see the placement pass below); record
        // it, and what its row's label area must dodge: this edge's own vertical next to the
        // child (lowest height), and its parent-side vertical and marker (upper two heights).
        pending.push({ g: child.layer, x: cx + 5, w: label.length * ERD.charW, top: child.y, label });
        block(child.layer, 0, cx - 2, cx + 2);
        block(child.layer, 1, px - 2, px + 2);
        block(child.layer, 2, px - 2, px + 2);
        if (pEnd === 'zero-one') { block(child.layer, 1, px - 6, px + 6); block(child.layer, 2, px - 6, px + 6); }
        text = '';
      } else {
        // Cycle or same row: route around the right of both boxes.
        const xr = Math.max(child.x + child.w, parent.x + parent.w) + ERD.loop;
        const py = parent.y + ERD.headH / 2;
        path = `M${child.x + child.w},${cy} H${xr} V${py} H${parent.x + parent.w}`;
        ends = erdEnd(cEnd, child.x + child.w, cy, 0, 'c') + erdEnd(pEnd, parent.x + parent.w, py, 0, 'p');
        text = `<text class="lbl" x="${xr + 4}" y="${(cy + py) / 2 + 4}">${e(label)}</text>`;
        maxX = Math.max(maxX, xr + 4 + label.length * ERD.charW);
      }
      out.push(`<g class="edge" data-fk="${e(n)}.${e(label)}" data-ends="${pEnd} ${cEnd}">`
        + `<path class="ln" d="${path}"/>${ends}${text}</g>`);
    });
  }

  // The placement pass: per row, three label heights — one below the horizontal edge runs and
  // two above them. Each label takes the first height where nothing occupies its span.
  // ponytail: when all three heights are blocked the least-crowded one takes the spill and two
  // things can touch; flipping text-anchor or an ellipsis is the upgrade if it reads badly.
  if (pending.length) {
    const placed: string[] = [];
    const overlap = (list: { x0: number; x1: number }[], x0: number, x1: number): number =>
      list.reduce((o, iv) => o + Math.max(0, Math.min(iv.x1, x1) - Math.max(iv.x0, x0)), 0);
    for (const p of pending.sort((a, c) => a.g - c.g || a.x - c.x)) {
      const spans = [0, 1, 2].map((b) => obstacles.get(`${p.g}:${b}`) ?? []);
      const cost = spans.map((list) => overlap(list, p.x, p.x + p.w));
      let band = cost.findIndex((o) => o === 0);
      if (band === -1) band = cost.reduce((best, o, b, all) => (o < all[best] ? b : best), 0);
      spans[band].push({ x0: p.x, x1: p.x + p.w });
      obstacles.set(`${p.g}:${band}`, spans[band]);
      placed.push(`<text class="lbl" x="${p.x}" y="${p.top - 20 - [0, 24, 36][band]}">${e(p.label)}</text>`);
      maxX = Math.max(maxX, p.x + p.w);
    }
    out.push(`<g class="lbls">${placed.join('')}</g>`);
  }

  const W = Math.ceil(maxX + ERD.margin);
  const title = `Entity-relationship diagram: ${inSet.join(', ')}`;
  const own = standalone ? `<style>${ERD_STYLE}</style><rect class="bg" width="${W}" height="${H}"/>` : '';
  return `<svg class="erd" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" `
    + `role="img" aria-label="${e(title)}"><title>${e(title)}</title>${own}${out.join('')}</svg>`;
}

export function writeMarkdown(outdir: string, tables: Map<string, Table>, narratives: Narratives, findings: Finding[], stats: Stats): void {
  const domains = (narratives.domains ?? []) as Narratives[];
  mkdirSync(path.join(outdir, 'domains'), { recursive: true });
  // A domain removed from narratives.json must take its page and diagram with it, or a stale
  // domains/<key>.md survives reruns and gets committed as if still current. A run given no
  // domains at all (physical checks only) reconciles nothing: it must not delete the docs an
  // earlier narratives run wrote.
  const domainKeys = new Set(domains.map((d) => d.key as string));
  if (domainKeys.size) {
    for (const f of readdirSync(path.join(outdir, 'domains'))) {
      const m = f.match(/^(.*)\.(md|svg)$/);
      if (m && !domainKeys.has(m[1])) unlinkSync(path.join(outdir, 'domains', f));
    }
  }
  const db = narratives.database ?? {};
  const lines: string[] = [`# ${db.title ?? 'Database'}`, '', db.blurb ?? '', '',
    `${stats.tables} tables · ${stats.columns} columns · ${stats.foreign_keys} foreign keys · `
    + `${stats.findings.error} errors · ${stats.findings.warn} warnings · ${stats.findings.info} notes`,
    '', 'See [FINDINGS.md](FINDINGS.md) for the design review.', ''];
  if ((narratives.conventions ?? []).length) {
    lines.push('## Conventions', '', ...(narratives.conventions as string[]).map((c) => `- ${c}`), '');
  }
  lines.push('## Domains', '', '| Domain | Tables | Findings |', '|---|---|---|');
  for (const d of domains) {
    const nF = (d.tables as string[]).reduce((n, x) => n + (tables.get(x)?.findings.length ?? 0), 0);
    lines.push(`| [${d.title}](domains/${d.key}.md) | ${d.tables.length} | ${nF} |`);
  }
  const unclaimed = [...tables.values()].filter((t) => t.domain === null).map((t) => t.name);
  if (unclaimed.length) lines.push('', `Unclaimed tables: ${unclaimed.map((n) => `\`${n}\``).join(', ')}`);
  lines.push('', '## Diagram', '', '![Entity-relationship diagram](erd.svg)');
  writeFileSync(path.join(outdir, 'erd.svg'), `${svgErd(tables, [...tables.keys()], true)}\n`);
  writeFileSync(path.join(outdir, 'README.md'), `${lines.join('\n')}\n`);

  const domainRelationships = (d: Narratives): Relationship[] =>
    (d.tables as string[]).flatMap((n) => (tables.has(n) ? relationships(tables.get(n)!, narratives) : []));

  const fmap = new Map(findings.map((f) => [f.id, f]));
  for (const d of domains) {
    writeFileSync(path.join(outdir, 'domains', `${d.key}.svg`), `${svgErd(tables, d.tables, true)}\n`);
    const dl: string[] = [`# ${d.title}`, '', d.blurb ?? '', '',
      `Tenant-scoped: ${d.tenant_scoped ? 'yes' : 'no'}`, '',
      `![${d.title} diagram](${d.key}.svg)`, '', '## Relationships', ''];
    const rels = domainRelationships(d);
    if (!rels.length) dl.push('_No foreign keys in this domain._', '');
    for (const r of rels) {
      dl.push(`- \`${r.child}.${r.columns.join(', ')}\` → \`${r.parent}.${r.ref_columns.join(', ')}\` — ${describeRelationship(r)}  `,
        `  why: ${r.why ?? 'not documented'}`);
    }
    if (rels.length) dl.push('');
    for (const name of d.tables as string[]) {
      const t = tables.get(name);
      if (!t) {
        dl.push(`## ${name}`, '', '_Listed in narratives but missing from the schema._', '');
        continue;
      }
      dl.push(`## ${name}`, '');
      if (t.description.length) dl.push(t.description.join(' '), '');
      dl.push('| Column | Type | Null | Default | References | Notes |', '|---|---|---|---|---|---|');
      for (const c of t.columns) {
        const fk = t.fks.find((k) => k.columns.includes(c.name));
        const ref = fk ? `${fk.ref_table}.${fk.ref_columns[0] ?? ''}` : '';
        const flag = c.is_pk ? ' (PK)' : c.is_unique ? ' (UK)' : '';
        dl.push(`| \`${c.name}\`${flag} | ${c.type} | ${c.not_null ? 'NOT NULL' : ''} | `
          + `${c.default ?? ''} | ${ref} | ${c.comment.replaceAll('|', '\\|')} |`);
      }
      const ix = t.indexes.filter((i) => i.source === 'index')
        .map((i) => `${i.unique ? 'UNIQUE ' : ''}(${i.columns.join(', ')})${i.where ? ` WHERE ${i.where}` : ''}`);
      dl.push('', `Indexes: ${ix.length ? ix.join('; ') : 'none'}  `,
        `Referenced by: ${t.referenced_by.map((r) => r.table).join(', ') || 'nothing'}  `,
        `RLS: ${t.rls_enabled ? `enabled, policies: ${t.policies.join(', ')}` : 'off'}`, '');
      if (t.findings.length) {
        dl.push('Findings:', '', ...t.findings.map((i) => {
          const f = fmap.get(i)!;
          return `- **${SEV_LABEL[f.severity]}** ${f.title} — ${f.detail}`;
        }), '');
      }
    }
    writeFileSync(path.join(outdir, 'domains', `${d.key}.md`), `${dl.join('\n')}\n`);
  }

  const fl: string[] = ['# Design review findings', '',
    'Deterministic checks run by `db-review.ts`. Each finding states what the schema allows today, why it '
    + 'hurts, and the smallest change that fixes it. The LLM review pass (see SKILL.md) builds on top of these.', ''];
  for (const sev of SEVERITIES) {
    const group = findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    fl.push(`## ${SEV_LABEL[sev]}s (${group.length})`, '');
    for (const f of group) {
      const cols = f.columns.length ? ` \`${f.columns.join(', ')}\`` : '';
      fl.push(`### ${f.id} · ${f.table}${cols} — ${f.title}`, '', f.detail, '');
      if (f.suggestion) fl.push(`**Fix:** ${f.suggestion}`, '');
      if (f.fix_sql) fl.push('```sql', f.fix_sql, '```', '');
    }
  }
  writeFileSync(path.join(outdir, 'FINDINGS.md'), `${fl.join('\n')}\n`);
}

/** Same five characters as Python's html.escape. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

const CSS = `
:root{--bg:#fbfaf7;--ink:#1d2430;--mute:#6b7280;--rule:#e2ddd3;--panel:#ffffff;--acc:#1f5f8b;--err:#b3261e;--warn:#9a6700;--info:#3b6ea5;--errbg:#fbe9e7;--warnbg:#fff4d6;--infobg:#e8f0fa}
@media(prefers-color-scheme:dark){:root{--bg:#171a1f;--ink:#e6e3dc;--mute:#9aa0a8;--rule:#2c313a;--panel:#1e232a;--acc:#7cb3e0;--err:#f28b82;--warn:#f2c14e;--info:#8fb8ea;--errbg:#3a2220;--warnbg:#3a3220;--infobg:#1f2c3a}}
.erd-wrap{overflow-x:auto;margin:12px 0}.erd{max-width:100%;height:auto;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.erd .bx{fill:var(--panel);stroke:var(--ink);stroke-width:1.2}.erd .hd{fill:var(--rule)}.erd .stub .bx{stroke:var(--mute);stroke-dasharray:4 3}.erd .stub .hd{fill:none}
.erd .ttl{font-weight:700;fill:var(--ink)}.erd .col{fill:var(--ink)}.erd .typ,.erd .lbl{fill:var(--mute);font-size:11px}.erd .lbl{paint-order:stroke;stroke:var(--bg);stroke-width:3}.erd .key{fill:var(--acc);font-weight:700;font-size:10px}
.erd .ln,.erd .end path{fill:none;stroke:var(--ink);stroke-width:1.2}.erd .end circle{fill:var(--panel);stroke:var(--ink);stroke-width:1.2}
.rels{list-style:none;padding:0;margin:8px 0 16px}.rels li{padding:6px 0;border-bottom:1px solid var(--rule)}.rels .why{font-style:italic}
.rels-h{margin:18px 0 2px}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 Georgia,'Iowan Old Style','Palatino Linotype',serif;color:var(--ink);background:var(--bg);display:flex;align-items:flex-start;min-height:100vh}
nav{flex:0 0 270px;position:sticky;top:0;height:100vh;overflow:auto;padding:22px 18px;border-right:1px solid var(--rule);background:var(--panel)}
nav .brand{font-size:17px;font-weight:700;margin:0 0 2px}nav .sub{color:var(--mute);font-size:13px;margin:0 0 14px}
nav input{width:100%;padding:7px 9px;border:1px solid var(--rule);border-radius:6px;background:var(--bg);color:var(--ink);font:13px system-ui,sans-serif;margin-bottom:12px}
nav a{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:5px;color:var(--ink);text-decoration:none;font:14px system-ui,sans-serif}
nav a:hover{background:var(--bg)}nav .count{margin-left:auto;color:var(--mute);font-size:12px}
.badge{font-size:11px;padding:0 6px;border-radius:9px;color:#fff;font-family:system-ui,sans-serif}.badge.error{background:var(--err)}.badge.warn{background:var(--warn)}
main{flex:1 1 auto;min-width:0;padding:34px 48px 80px;max-width:1180px}h1{font-size:30px;margin:0 0 6px}h2{font-size:22px;margin:44px 0 6px;padding-top:18px;border-top:1px solid var(--rule)}
h3{font-size:17px;margin:0}h4{font:600 13px system-ui,sans-serif;margin:10px 0 4px}.lead{font-size:16px;color:var(--ink);max-width:76ch}.stats,.muted{color:var(--mute)}
.error{color:var(--err)}.warn{color:var(--warn)}.info{color:var(--info)}
section.table{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:16px 20px;margin:18px 0}
section.table header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}.meta{color:var(--mute);font:12px system-ui,sans-serif}.desc{margin:6px 0 4px;max-width:80ch}
table{width:100%;border-collapse:collapse;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin-top:10px}th{text-align:left;font:600 11px system-ui,sans-serif;color:var(--mute);padding:4px 8px;border-bottom:1px solid var(--rule)}
td{padding:4px 8px;border-bottom:1px solid var(--rule);vertical-align:top}td:last-child{font-family:Georgia,serif;font-size:13px}code{font:12.5px ui-monospace,Menlo,Consolas,monospace}
.key{font:600 10px system-ui,sans-serif;color:var(--acc);border:1px solid var(--acc);border-radius:3px;padding:0 3px;margin-left:4px}.chk{display:block;color:var(--mute);margin-top:2px}
.cols2{display:flex;gap:16px}.cols2>div{flex:1}.cols2 ul{margin:0;padding-left:18px;font:13px system-ui,sans-serif}a{color:var(--acc)}
.tfind ul{margin:8px 0 0;padding:0;list-style:none}.tfind li{font:13px/1.45 system-ui,sans-serif;padding:6px 10px;border-left:3px solid;margin:4px 0;border-radius:0 4px 4px 0}
.tfind li.error{border-color:var(--err);background:var(--errbg)}.tfind li.warn{border-color:var(--warn);background:var(--warnbg)}.tfind li.info{border-color:var(--info);background:var(--infobg)}
.finding{border:1px solid var(--rule);border-left:4px solid;border-radius:6px;padding:12px 16px;margin:12px 0;background:var(--panel)}.finding{color:var(--ink)}.finding.error{border-left-color:var(--err)}.finding.warn{border-left-color:var(--warn)}.finding.info{border-left-color:var(--info)}
.fh{display:flex;gap:10px;align-items:baseline;font:13px system-ui,sans-serif}.fid{color:var(--mute);margin-right:6px}.fcheck{margin-left:auto;color:var(--mute);font-size:12px}.finding h4{font:600 15px Georgia,serif;margin:4px 0}.finding p{margin:4px 0;max-width:80ch}
pre{background:var(--bg);border:1px solid var(--rule);border-radius:5px;padding:8px 10px;font:12.5px ui-monospace,Menlo,Consolas,monospace;overflow:auto}
section.table.hidden{display:none}section.missing{border-color:var(--err)}
@media(max-width:900px){body{display:block}nav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--rule)}main{padding:20px}.cols2{display:block}}
`;

const JS = `
const q=document.querySelector('nav input');q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();
document.querySelectorAll('section.table').forEach(s=>{const hit=!v||s.dataset.name.includes(v)||s.dataset.cols.includes(v);s.classList.toggle('hidden',!hit);});});
`;

export function writeHtml(outdir: string, tables: Map<string, Table>, narratives: Narratives, findings: Finding[], stats: Stats, source: string): void {
  const e = escapeHtml;
  /** Escape, then turn `code` spans into <code>. */
  const md = (text: string): string => e(text).replace(/`([^`]+)`/g, '<code>$1</code>');
  const db = narratives.database ?? {};
  const domains = (narratives.domains ?? []) as Narratives[];
  const fmap = new Map(findings.map((f) => [f.id, f]));
  const unclaimed = [...tables.values()].filter((t) => t.domain === null).map((t) => t.name);

  const badge = (sev: string, n: number): string => (n ? `<span class="badge ${sev}">${n}</span>` : '');

  const sevCounts = (names: string[]): Record<Severity, number> => {
    const c: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
    for (const n of names) {
      for (const fid of tables.get(n)?.findings ?? []) c[fmap.get(fid)!.severity] += 1;
    }
    return c;
  };

  const nav = ['<a href="#overview">Overview</a>', '<a href="#conventions">Conventions</a>',
    `<a href="#findings">Findings <span class="count">${findings.length}</span></a>`,
    '<a href="#schema">Schema</a>'];
  for (const d of domains) {
    const c = sevCounts(d.tables);
    nav.push(`<a href="#d-${e(d.key)}">${e(d.title)} <span class="count">${d.tables.length}</span>`
      + `${badge('error', c.error)}${badge('warn', c.warn)}</a>`);
  }
  if (unclaimed.length) {
    nav.push(`<a href="#d-unclaimed">Unclaimed <span class="count">${unclaimed.length}</span>${badge('error', unclaimed.length)}</a>`);
  }

  const tableHtml = (t: Table): string => {
    const rows: string[] = [];
    for (const c of t.columns) {
      let ref = '';
      for (const fk of t.fks) {
        if (fk.columns.includes(c.name)) {
          ref = `<a href="#t-${e(fk.ref_table)}">${e(fk.ref_table)}.${e(fk.ref_columns[0] ?? '')}</a>`
            + `<span class="muted"> ${e(fk.cardinality)}${fk.on_delete === 'NO ACTION' ? '' : ` · ${e(fk.on_delete)}`}</span>`;
        }
      }
      const key = c.is_pk ? '<span class="key">PK</span>' : c.is_unique ? '<span class="key">UK</span>' : '';
      let notes = e(c.comment);
      if (c.check) notes += `<code class="chk">CHECK ${e(c.check)}</code>`;
      rows.push(`<tr><td><code>${e(c.name)}</code> ${key}</td><td>${e(c.type)}</td>`
        + `<td>${c.not_null ? 'NOT NULL' : '<span class=muted>null</span>'}</td>`
        + `<td>${c.default ? e(c.default) : ''}</td><td>${ref}</td><td>${notes}</td></tr>`);
    }
    const ix = t.indexes.filter((i) => i.source === 'index').map((i) =>
      `<li>${i.unique ? 'UNIQUE ' : ''}(${e(i.columns.join(', '))})${i.where ? ` <span class=muted>WHERE ${e(i.where)}</span>` : ''}`
      + `${i.name ? ` <span class=muted>${e(i.name)}</span>` : ''}</li>`);
    const rb = t.referenced_by.map((r) =>
      `<li><a href="#t-${e(r.table)}">${e(r.table)}</a> <span class="muted">(${e(r.columns.join(', '))}, ${e(r.cardinality)})</span></li>`);
    let fnd = '';
    if (t.findings.length) {
      const items = t.findings.map((i) => {
        const f = fmap.get(i)!;
        return `<li class="${f.severity}"><a href="#${i}"><b>${md(f.title)}</b></a>`
          + `${f.columns.length ? ` <code>${e(f.columns.join(', '))}</code>` : ''}`
          + ` — ${md(f.detail)}</li>`;
      }).join('');
      fnd = `<div class="tfind"><ul>${items}</ul></div>`;
    }
    const meta = `${t.columns.length} cols · ${t.rls_enabled ? 'RLS on' : 'no RLS'}`
      + `${t.section ? ` · ${e(t.section)}` : ''} · line ${t.source_line}`;
    const desc = t.description.length ? `<p class="desc">${e(t.description.join(' '))}</p>` : '';
    return `<section class="table" id="t-${e(t.name)}" data-name="${e(t.name)}" data-cols="${e(t.columns.map((c) => c.name).join(' '))}">`
      + `<header><h3>${e(t.name)}</h3><span class="meta">${meta}</span></header>${desc}${fnd}`
      + '<table><thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Default</th><th>References</th><th>Notes</th></tr></thead>'
      + `<tbody>${rows.join('')}</tbody></table>`
      + `<div class="cols2"><div><h4>Indexes</h4><ul>${ix.join('') || '<li class=muted>none</li>'}</ul></div>`
      + `<div><h4>Referenced by</h4><ul>${rb.join('') || '<li class=muted>nothing</li>'}</ul></div></div>`
      + `${t.checks.length ? `<p class=muted>Table checks: ${e(t.checks.join('; '))}</p>` : ''}`
      + '</section>';
  };

  const body: string[] = [];
  const s = stats.findings;
  body.push(`<section id="overview"><h1>${e(db.title ?? 'Database')}</h1><p class="lead">${e(db.blurb ?? '')}</p>`
    + `<p class="stats">${stats.tables} tables · ${stats.columns} columns · ${stats.foreign_keys} foreign keys · `
    + `${domains.length} domains &nbsp;|&nbsp; <span class="error">${s.error} errors</span> · `
    + `<span class="warn">${s.warn} warnings</span> · <span class="info">${s.info} notes</span></p>`
    + `<p class="muted">Generated from <code>${e(source)}</code> on ${localToday()}.</p></section>`);
  const conv = ((narratives.conventions ?? []) as string[]).map((c) => `<li>${e(c)}</li>`).join('');
  body.push(`<section id="conventions"><h2>Conventions</h2><ul>${conv || '<li class=muted>none declared</li>'}</ul>`
    + '<p class="muted">Conventions are claims. Findings below are where the schema breaks them.</p></section>');

  const fitems: string[] = [];
  for (const sev of SEVERITIES) {
    const group = findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    fitems.push(`<h3 class="${sev}">${SEV_LABEL[sev]}s (${group.length})</h3>`);
    for (const f of group) {
      const cols = f.columns.length ? ` <code>${e(f.columns.join(', '))}</code>` : '';
      const fix = f.suggestion ? `<p><b>Fix</b> ${md(f.suggestion)}</p>` : '';
      const sql = f.fix_sql ? `<pre>${e(f.fix_sql)}</pre>` : '';
      fitems.push(`<article class="finding ${sev}" id="${f.id}"><div class="fh"><span class="fid">${f.id}</span>`
        + `<a href="#t-${e(f.table)}">${e(f.table)}</a>${cols}<span class="fcheck">${e(f.check)}</span></div>`
        + `<h4>${md(f.title)}</h4><p>${md(f.detail)}</p>${fix}${sql}</article>`);
    }
  }
  body.push(`<section id="findings"><h2>Findings</h2>${fitems.join('') || '<p class=muted>No findings.</p>'}</section>`);

  // The whole-schema diagram is present in every run, narratives or not.
  body.push(`<section id="schema"><h2>Schema</h2><div class="erd-wrap">${svgErd(tables, [...tables.keys()])}</div></section>`);

  for (const d of domains) {
    const secs = (d.tables as string[]).map((n) => {
      const t = tables.get(n);
      return t ? tableHtml(t)
        : `<section class="table missing" id="t-${e(n)}"><header><h3>${e(n)}</h3></header><p class="error">Listed in narratives.json but not in the schema.</p></section>`;
    }).join('');
    const rels = (d.tables as string[]).flatMap((n) => (tables.has(n) ? relationships(tables.get(n)!, narratives) : []));
    const relHtml = rels.length
      ? `<ul class="rels">${rels.map((r) => `<li><code>${e(r.child)}.${e(r.columns.join(', '))}</code> → `
        + `<a href="#t-${e(r.parent)}">${e(r.parent)}</a>.${e(r.ref_columns.join(', '))} `
        + `<span class="muted">— ${e(describeRelationship(r))}</span><br>`
        + `<span class="why${r.why ? '' : ' muted'}">why: ${e(r.why ?? 'not documented')}</span></li>`).join('')}</ul>`
      : '<p class="muted">No foreign keys in this domain.</p>';
    body.push(`<section class="domain" id="d-${e(d.key)}"><h2>${e(d.title)} <span class="muted">${d.tables.length} tables`
      + `${d.tenant_scoped ? ' · tenant-scoped' : ''}</span></h2><p class="lead">${e(d.blurb ?? '')}</p>`
      + `<div class="erd-wrap">${svgErd(tables, d.tables)}</div>`
      + `<h3 class="rels-h">Relationships</h3>${relHtml}${secs}</section>`);
  }
  if (unclaimed.length) {
    body.push('<section class="domain" id="d-unclaimed"><h2>Unclaimed tables</h2><p class="lead">Present in the schema, absent from every domain.</p>'
      + unclaimed.map((n) => tableHtml(tables.get(n)!)).join('') + '</section>');
  }

  const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${e(db.title ?? 'Database')} — schema &amp; design review</title><style>${CSS}</style></head><body>`
    + `<nav><p class="brand">${e(db.title ?? 'Database')}</p><p class="sub">${stats.tables} tables · ${domains.length} domains</p>`
    + `<input type="search" placeholder="Filter tables and columns"/>${nav.join('')}</nav>`
    + `<main>${body.join('')}</main><script>${JS}</script></body></html>`;
  writeFileSync(path.join(outdir, 'index.html'), page);
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

const USAGE = `usage: db-review.ts [-h] [--narratives NARRATIVES] [--out OUT] [--fail-on {error,warn,info,never}] [--quiet] schema

positional arguments:
  schema                schema.sql (a single DDL file; concatenate migrations first if needed)

options:
  -h, --help            show this help message and exit
  --narratives NARRATIVES
                        narratives.json with domains, conventions and assertions
  --out OUT             output directory (default docs/database)
  --fail-on {error,warn,info,never}
                        exit 1 if findings at this severity or worse exist (default error)
  --quiet
`;

const FAIL_ON = ['error', 'warn', 'info', 'never'] as const;
type FailOn = (typeof FAIL_ON)[number];

function readText(p: string, what: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${what} ${p}: ${(err as Error).message}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        narratives: { type: 'string' },
        out: { type: 'string', default: 'docs/database' },
        'fail-on': { type: 'string', default: 'error' },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`${USAGE}\ndb-review.ts: error: ${(err as Error).message}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write(`${USAGE}\ndb-review.ts: error: expected exactly one schema file\n`);
    return 2;
  }
  const failOn = values['fail-on'] as string;
  if (!(FAIL_ON as readonly string[]).includes(failOn)) {
    process.stderr.write(`${USAGE}\ndb-review.ts: error: argument --fail-on: invalid choice: '${failOn}' (choose from ${FAIL_ON.join(', ')})\n`);
    return 2;
  }
  const schemaPath = positionals[0];
  const outdir = values.out as string;

  let sqlText: string;
  let narratives: Narratives;
  try {
    sqlText = readText(schemaPath, 'schema');
    narratives = values.narratives ? JSON.parse(readText(values.narratives as string, 'narratives')) : {};
  } catch (err) {
    process.stderr.write(`db-review.ts: error: ${(err as Error).message}\n`);
    return 2;
  }

  let tables: Map<string, Table>;
  let extras: Extras;
  try {
    ({ tables, extras } = await parseSchema(sqlText, schemaPath));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' && /libpg-query/.test((err as Error).message)) {
      process.stderr.write('libpg-query is required:  npm install\n');
      return 2;
    }
    throw err;
  }
  const findings = new Reviewer(tables, narratives).run();
  const doc = modelToJson(tables, extras, narratives, findings, schemaPath);

  mkdirSync(outdir, { recursive: true });
  writeFileSync(path.join(outdir, 'schema.json'), JSON.stringify(doc, null, 2));
  writeMarkdown(outdir, tables, narratives, findings, doc.stats);
  writeHtml(outdir, tables, narratives, findings, doc.stats, schemaPath);

  const s = doc.stats.findings as Record<Severity, number>;
  if (!values.quiet) {
    const out: string[] = [
      `${tables.size} tables, ${doc.stats.foreign_keys} FKs, ${(narratives.domains ?? []).length} domains → ${outdir}/`,
      `findings: ${s.error} error, ${s.warn} warn, ${s.info} info`,
    ];
    for (const f of findings) {
      if (f.severity !== 'info') {
        const cols = f.columns.length ? `(${f.columns.join(', ')})` : '';
        out.push(`  [${f.severity.padEnd(5)}] ${f.table}${cols}: ${f.title}`);
      }
    }
    process.stdout.write(`${out.join('\n')}\n`);
  }
  const rank: Record<FailOn, number> = { error: 0, warn: 1, info: 2, never: 3 };
  const worst = findings.length ? Math.min(...findings.map((f) => rank[f.severity])) : 3;
  return worst <= rank[failOn as FailOn] && failOn !== 'never' ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
