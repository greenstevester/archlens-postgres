#!/usr/bin/env python3
"""
db_review.py — document a PostgreSQL schema AND review its design in one pass.

    python db_review.py schema.sql --narratives narratives.json --out docs/database

Reads DDL with the real PostgreSQL parser (pglast / libpg_query), builds a
model (tables, columns, keys, foreign keys, indexes, RLS, comments), joins it
with human intent from narratives.json (domains, blurbs, assertions), runs a
set of deterministic design checks, and writes:

    <out>/schema.json     machine-readable model + findings (input for the LLM pass)
    <out>/index.html      self-contained browsable docs with findings inline
    <out>/README.md       markdown index + per-domain pages with Mermaid ERDs
    <out>/FINDINGS.md     findings grouped by severity with fix suggestions

Exit code is non-zero when findings at or above --fail-on exist, so this can
gate CI the same way a linter does.

Requires: Python 3.10+, pglast  (pip install pglast)
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import sys
from collections import defaultdict, deque
from dataclasses import dataclass, field, asdict
from typing import Optional

try:
    from pglast import parse_sql
    from pglast import enums as pgenums
    from pglast.stream import RawStream
except ImportError:  # pragma: no cover
    sys.stderr.write("pglast is required:  pip install pglast\n")
    sys.exit(2)


# ----------------------------------------------------------------------------
# Model
# ----------------------------------------------------------------------------

@dataclass
class Column:
    name: str
    type: str
    type_base: str            # normalised base type: varchar, text, timestamp, ...
    length: Optional[int]
    not_null: bool = False
    default: Optional[str] = None
    check: Optional[str] = None
    comment: str = ""
    is_pk: bool = False
    is_unique: bool = False   # single-column unique
    is_fk: bool = False
    is_enum_type: bool = False


@dataclass
class ForeignKey:
    name: Optional[str]
    columns: list[str]
    ref_table: str
    ref_columns: list[str]
    on_delete: str            # NO ACTION | RESTRICT | CASCADE | SET NULL | SET DEFAULT
    nullable: bool = False
    unique: bool = False      # FK columns covered by a PK/UNIQUE
    indexed: bool = False     # FK columns are a leading prefix of some index
    cardinality: str = "1:N"  # inferred parent:child


@dataclass
class Index:
    name: Optional[str]
    columns: list[str]        # expression indexes render the expression
    unique: bool
    where: Optional[str] = None
    source: str = "index"     # index | pk | unique-constraint


@dataclass
class Table:
    name: str
    schema: str = "public"
    description: list[str] = field(default_factory=list)
    section: str = ""
    columns: list[Column] = field(default_factory=list)
    pk: list[str] = field(default_factory=list)
    uniques: list[list[str]] = field(default_factory=list)
    checks: list[str] = field(default_factory=list)
    fks: list[ForeignKey] = field(default_factory=list)
    indexes: list[Index] = field(default_factory=list)
    rls_enabled: bool = False
    policies: list[str] = field(default_factory=list)
    referenced_by: list[dict] = field(default_factory=list)
    domain: Optional[str] = None
    findings: list[str] = field(default_factory=list)   # finding ids
    source_line: int = 0

    def col(self, name: str) -> Optional[Column]:
        for c in self.columns:
            if c.name == name:
                return c
        return None


@dataclass
class Finding:
    id: str
    check: str
    severity: str             # error | warn | info
    table: str
    columns: list[str]
    title: str
    detail: str
    suggestion: str = ""
    fix_sql: str = ""


# ----------------------------------------------------------------------------
# Parsing
# ----------------------------------------------------------------------------

DEL_ACTIONS = {"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}


def _svals(lst) -> list[str]:
    return [x.sval for x in (lst or [])]


def _type_info(type_name) -> tuple[str, str, Optional[int]]:
    rendered = RawStream()(type_name)
    names = _svals(type_name.names)
    base = names[-1].lower()
    base = {"int4": "integer", "int8": "bigint", "int2": "smallint", "float8": "double precision",
            "float4": "real", "bpchar": "char", "bool": "boolean"}.get(base, base)
    length = None
    m = re.match(r"^[a-z ]+\((\d+)\)$", rendered)
    if m and base in ("varchar", "char"):
        length = int(m.group(1))
    return rendered, base, length


def parse_schema(sql_text: str, path: str) -> tuple[dict[str, Table], dict]:
    tables: dict[str, Table] = {}
    enum_types: set[str] = set()
    pending_alters: list = []
    extras = {"extensions": [], "enums": {}, "unparsed": []}
    lines = sql_text.split("\n")

    def line_of(offset: int) -> int:
        return sql_text.count("\n", 0, offset) + 1

    def preceding_comment(offset: int) -> tuple[list[str], str]:
        """Collect the '--' comment block directly above a statement, and the
        most recent '-- PHASE ...' / section heading above it."""
        ln = line_of(offset) - 2
        desc: list[str] = []
        while ln >= 0:
            s = lines[ln].strip()
            if not s.startswith("--") or s.startswith("-- =") or s.startswith("-- -"):
                break
            body = s.lstrip("-").strip()
            if body and not re.match(r"^(PHASE|Phase)\s", body):
                desc.insert(0, body)
            ln -= 1
        section = ""
        for j in range(line_of(offset) - 1, -1, -1):
            m = re.match(r"^\s*--\s*(PHASE\s+\d+.*?)\s*$", lines[j])
            if m:
                section = m.group(1).strip()
                break
        return desc, section

    for raw in parse_sql(sql_text):
        stmt = raw.stmt
        kind = type(stmt).__name__
        loc = raw.stmt_location or 0

        if kind == "CreateEnumStmt":
            name = ".".join(_svals(stmt.typeName))
            enum_types.add(name.split(".")[-1])
            extras["enums"][name.split(".")[-1]] = _svals(stmt.vals)

        elif kind == "CreateExtensionStmt":
            extras["extensions"].append(stmt.extname)

        elif kind == "CreateStmt":
            t = Table(name=stmt.relation.relname, schema=stmt.relation.schemaname or "public")
            t.description, t.section = preceding_comment(loc)
            t.source_line = line_of(loc)
            for elt in stmt.tableElts or []:
                ek = type(elt).__name__
                if ek == "ColumnDef":
                    rendered, base, length = _type_info(elt.typeName)
                    col = Column(name=elt.colname, type=rendered, type_base=base, length=length,
                                 is_enum_type=base in enum_types)
                    for c in elt.constraints or []:
                        ct = c.contype
                        if ct == pgenums.ConstrType.CONSTR_NOTNULL:
                            col.not_null = True
                        elif ct == pgenums.ConstrType.CONSTR_DEFAULT:
                            col.default = RawStream()(c.raw_expr)
                        elif ct == pgenums.ConstrType.CONSTR_PRIMARY:
                            col.is_pk = True
                            col.not_null = True
                            t.pk = [col.name]
                        elif ct == pgenums.ConstrType.CONSTR_UNIQUE:
                            col.is_unique = True
                            t.uniques.append([col.name])
                        elif ct == pgenums.ConstrType.CONSTR_CHECK:
                            col.check = RawStream()(c.raw_expr)
                        elif ct == pgenums.ConstrType.CONSTR_FOREIGN:
                            t.fks.append(ForeignKey(
                                name=c.conname, columns=[col.name],
                                ref_table=c.pktable.relname, ref_columns=_svals(c.pk_attrs),
                                on_delete=DEL_ACTIONS.get(c.fk_del_action, "NO ACTION")))
                    t.columns.append(col)
                elif ek == "Constraint":
                    _apply_table_constraint(t, elt)
            tables[t.name] = t

        elif kind == "AlterTableStmt":
            pending_alters.append(stmt)

        elif kind == "IndexStmt":
            t = tables.get(stmt.relation.relname)
            if t is None:
                extras["unparsed"].append(f"index on unknown table {stmt.relation.relname}")
                continue
            cols = [p.name if p.name else RawStream()(p.expr) for p in stmt.indexParams]
            t.indexes.append(Index(name=stmt.idxname, columns=cols, unique=bool(stmt.unique),
                                   where=RawStream()(stmt.whereClause) if stmt.whereClause else None))

        elif kind == "CommentStmt":
            names = _svals(stmt.object) if isinstance(stmt.object, tuple) else []
            if stmt.objtype == pgenums.ObjectType.OBJECT_TABLE and names:
                t = tables.get(names[-1])
                if t and stmt.comment:
                    t.description.append(stmt.comment)
            elif stmt.objtype == pgenums.ObjectType.OBJECT_COLUMN and len(names) >= 2:
                t = tables.get(names[-2])
                c = t.col(names[-1]) if t else None
                if c and stmt.comment:
                    c.comment = stmt.comment

        elif kind == "CreatePolicyStmt":
            t = tables.get(stmt.table.relname)
            if t:
                t.policies.append(stmt.policy_name)

        else:
            extras["unparsed"].append(kind)

    # ALTER TABLE after all CREATEs so forward references resolve
    for stmt in pending_alters:
        t = tables.get(stmt.relation.relname)
        if t is None:
            extras["unparsed"].append(f"ALTER on unknown table {stmt.relation.relname}")
            continue
        for cmd in stmt.cmds or []:
            st = cmd.subtype
            if st == pgenums.AlterTableType.AT_AddConstraint and cmd.def_ is not None:
                _apply_table_constraint(t, cmd.def_)
            elif st == pgenums.AlterTableType.AT_EnableRowSecurity:
                t.rls_enabled = True
            elif st == pgenums.AlterTableType.AT_ForceRowSecurity:
                t.rls_enabled = True
            elif st == pgenums.AlterTableType.AT_AddColumn and cmd.def_ is not None:
                rendered, base, length = _type_info(cmd.def_.typeName)
                t.columns.append(Column(name=cmd.def_.colname, type=rendered, type_base=base, length=length))
            elif st == pgenums.AlterTableType.AT_DropColumn:
                t.columns = [c for c in t.columns if c.name != cmd.name]

    # Inline source comments after a column ("-- Organization | User") become column comments
    _harvest_trailing_comments(tables, lines)

    # Derived facts
    _derive(tables)
    return tables, extras


def _apply_table_constraint(t: Table, c) -> None:
    ct = c.contype
    if ct == pgenums.ConstrType.CONSTR_PRIMARY:
        t.pk = _svals(c.keys)
        for k in t.pk:
            col = t.col(k)
            if col:
                col.is_pk = True
                col.not_null = True
    elif ct == pgenums.ConstrType.CONSTR_UNIQUE:
        keys = _svals(c.keys)
        t.uniques.append(keys)
        if len(keys) == 1 and t.col(keys[0]):
            t.col(keys[0]).is_unique = True
    elif ct == pgenums.ConstrType.CONSTR_CHECK:
        t.checks.append(RawStream()(c.raw_expr))
    elif ct == pgenums.ConstrType.CONSTR_FOREIGN:
        t.fks.append(ForeignKey(name=c.conname, columns=_svals(c.fk_attrs), ref_table=c.pktable.relname,
                                ref_columns=_svals(c.pk_attrs),
                                on_delete=DEL_ACTIONS.get(c.fk_del_action, "NO ACTION")))


def _harvest_trailing_comments(tables: dict[str, Table], lines: list[str]) -> None:
    """Pick up `col TYPE ...,  -- some note` comments; strip our own ⚠ markers."""
    for t in tables.values():
        start = t.source_line - 1
        depth = 0
        for i in range(start, min(start + 400, len(lines))):
            line = lines[i]
            depth += line.count("(") - line.count(")")
            m = re.match(r"^\s*\"?([A-Za-z_][A-Za-z0-9_]*)\"?\s+\S.*?--\s*(.+?)\s*$", line)
            if m:
                col = t.col(m.group(1))
                note = re.sub(r"\s*⚠.*$", "", m.group(2)).strip()
                if col and note and not col.comment:
                    col.comment = note
            if i > start and depth <= 0:
                break


def _derive(tables: dict[str, Table]) -> None:
    for t in tables.values():
        # PK and UNIQUE constraints are indexes too
        if t.pk:
            t.indexes.insert(0, Index(name=None, columns=list(t.pk), unique=True, source="pk"))
        for u in t.uniques:
            t.indexes.append(Index(name=None, columns=list(u), unique=True, source="unique-constraint"))
        for fk in t.fks:
            fk.nullable = any(not (t.col(c) and t.col(c).not_null) for c in fk.columns)
            fk.unique = any(set(ix.columns) == set(fk.columns) and ix.unique and not ix.where
                            for ix in t.indexes)
            fk.indexed = any(set(ix.columns[:len(fk.columns)]) == set(fk.columns) for ix in t.indexes)
            fk.cardinality = "1:1" if fk.unique else "1:N"
            for c in fk.columns:
                col = t.col(c)
                if col:
                    col.is_fk = True
    for t in tables.values():
        for fk in t.fks:
            parent = tables.get(fk.ref_table)
            if parent:
                parent.referenced_by.append({"table": t.name, "columns": fk.columns,
                                             "on_delete": fk.on_delete, "cardinality": fk.cardinality})


# ----------------------------------------------------------------------------
# Checks
# ----------------------------------------------------------------------------

ENUMISH_NAMES = re.compile(r"(^|_)(status|state|type|kind|mode|selection|category|level|role|scope|visibility)$")
AUDIT_COLS = {"created_at", "updated_at", "created_by", "updated_by", "deleted_at", "id"}


class Reviewer:
    def __init__(self, tables: dict[str, Table], narratives: dict):
        self.t = tables
        self.n = narratives or {}
        self.a = self.n.get("assertions", {})
        self.findings: list[Finding] = []
        self._seq = 0
        self.domain_of: dict[str, dict] = {}
        for d in self.n.get("domains", []):
            for name in d.get("tables", []):
                self.domain_of[name] = d
                if name in tables:
                    tables[name].domain = d["key"]

    def add(self, check: str, severity: str, table: str, columns: list[str], title: str,
            detail: str, suggestion: str = "", fix_sql: str = "") -> None:
        self._seq += 1
        f = Finding(id=f"F{self._seq:03d}", check=check, severity=severity, table=table,
                    columns=columns, title=title, detail=detail, suggestion=suggestion, fix_sql=fix_sql)
        self.findings.append(f)
        if table in self.t:
            self.t[table].findings.append(f.id)

    # -- helpers ---------------------------------------------------------
    def tenant_table(self) -> Optional[str]:
        return self.a.get("tenant_table")

    def tenant_col(self) -> str:
        return self.a.get("tenant_column", "tenant_id")

    def is_global(self, name: str) -> bool:
        if name in self.a.get("global_tables", []):
            return True
        if name == self.tenant_table():
            return True
        d = self.domain_of.get(name)
        return bool(d) and d.get("tenant_scoped") is False

    def run(self) -> list[Finding]:
        for fn in (self.chk_domain_coverage, self.chk_primary_key, self.chk_fk_index,
                   self.chk_fk_nullable, self.chk_fk_delete_action, self.chk_cardinality_assertions,
                   self.chk_natural_keys, self.chk_junction_tables, self.chk_enumish,
                   self.chk_soft_delete_unique, self.chk_polymorphic, self.chk_exclusive_arc,
                   self.chk_timestamps, self.chk_money, self.chk_tenant_scoping, self.chk_rls,
                   self.chk_orphans, self.chk_singletons, self.chk_fk_cycles, self.chk_blast_radius,
                   self.chk_wide_tables):
            fn()
        order = {"error": 0, "warn": 1, "info": 2}
        self.findings.sort(key=lambda f: (order[f.severity], f.table, f.id))
        return self.findings

    # -- the checks ------------------------------------------------------
    def chk_domain_coverage(self):
        if not self.n.get("domains"):
            return
        for name in self.t:
            if name not in self.domain_of:
                self.add("domain-coverage", "error", name, [], "Table is in no domain",
                         "Every table must be claimed by a domain in narratives.json, otherwise it silently "
                         "falls out of the documentation and of any per-domain backup/retention policy.",
                         "Add it to the right domain's `tables` list, or delete the table if it is dead.")
        for name, d in self.domain_of.items():
            if name not in self.t:
                self.add("domain-coverage", "error", name, [], "Domain lists a table that does not exist",
                         f"Domain `{d['key']}` claims `{name}` but the schema has no such table — likely a "
                         "rename that never reached the narratives.",
                         "Fix or remove the entry.")

    def chk_primary_key(self):
        for t in self.t.values():
            if not t.pk:
                self.add("primary-key", "error", t.name, [], "No primary key",
                         "Without a primary key rows are not individually addressable: no safe UPDATE/DELETE "
                         "of one row, no logical replication, ORMs misbehave, and duplicates are legal.",
                         "Add a natural composite key or a surrogate id.",
                         f"ALTER TABLE {t.name} ADD PRIMARY KEY (...);")

    def chk_fk_index(self):
        for t in self.t.values():
            for fk in t.fks:
                if not fk.indexed:
                    cols = ", ".join(fk.columns)
                    self.add("fk-index", "warn", t.name, fk.columns, "Foreign key without index",
                             f"PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on "
                             f"`{fk.ref_table}` must scan `{t.name}` to check the constraint, and every join "
                             "from the parent side is a sequential scan.",
                             "Add an index on the FK column(s).",
                             f"CREATE INDEX CONCURRENTLY idx_{t.name}_{'_'.join(fk.columns)} ON {t.name}({cols});")

    def chk_fk_nullable(self):
        arcs = {(x["table"], c) for x in self.a.get("exclusive_arcs", []) for c in x["columns"]}
        for t in self.t.values():
            for fk in t.fks:
                if fk.nullable and not any((t.name, c) in arcs for c in fk.columns):
                    self.add("fk-nullable", "info", t.name, fk.columns, "Nullable foreign key",
                             f"`{'.'.join([t.name] + fk.columns)}` may be NULL, so the relationship to "
                             f"`{fk.ref_table}` is optional. That is legitimate (e.g. approved_by before approval) "
                             "but often a modelling shrug: a row with no owner, or two nullable FKs that are "
                             "secretly an either/or.",
                             "Confirm the optionality is a domain rule; document it in the column comment.")

    def chk_fk_delete_action(self):
        tt = self.tenant_table()
        for t in self.t.values():
            for fk in t.fks:
                if fk.on_delete == "NO ACTION" and fk.ref_table == tt:
                    self.add("fk-on-delete", "info", t.name, fk.columns,
                             "Tenant FK relies on the default ON DELETE NO ACTION",
                             f"Deleting a `{tt}` row will fail while `{t.name}` rows exist. Fine if tenants are "
                             "never hard-deleted; a surprise the day offboarding/GDPR erasure is built.",
                             "State the intent explicitly: CASCADE, RESTRICT, or an offboarding job.")

    def chk_cardinality_assertions(self):
        for a in self.a.get("cardinality", []):
            child = self.t.get(a["child"])
            if not child:
                continue
            fks = [fk for fk in child.fks if fk.ref_table == a["parent"]]
            if not fks:
                self.add("cardinality", "error", a["child"], [], "Asserted relationship has no foreign key",
                         f"narratives.json says `{a['parent']}` → `{a['child']}` is {a['expect']}, but there is "
                         "no FK from the child to the parent. The relationship exists only in application code.",
                         "Add the FK, or correct the narrative.")
                continue
            for fk in fks:
                if a["expect"] == "1:1" and not fk.unique:
                    cols = ", ".join(fk.columns)
                    self.add("cardinality", "error", a["child"], fk.columns,
                             "Modelled 1:N but intended 1:1",
                             f"The narrative says each `{a['parent']}` has exactly one `{a['child']}`, but "
                             f"`{cols}` is not UNIQUE, so the database happily stores five. Application code "
                             "that does `.single()` or `LIMIT 1` will return an arbitrary row.",
                             "Make the FK column(s) unique — or make it the primary key.",
                             f"ALTER TABLE {a['child']} ADD CONSTRAINT {a['child']}_{'_'.join(fk.columns)}_key UNIQUE ({cols});")
                elif a["expect"] == "1:N" and fk.unique:
                    self.add("cardinality", "warn", a["child"], fk.columns,
                             "Modelled 1:1 but intended 1:N",
                             f"The narrative expects many `{a['child']}` per `{a['parent']}`, but the FK is "
                             "UNIQUE, so the second child will fail to insert.",
                             "Drop the unique constraint, or fix the narrative.")

    def chk_natural_keys(self):
        for nk in self.a.get("natural_keys", []):
            t = self.t.get(nk["table"])
            if not t:
                continue
            cols = nk["columns"]
            if not any(set(ix.columns) == set(cols) and ix.unique for ix in t.indexes):
                self.add("natural-key", "error", t.name, cols, "Asserted natural key is not enforced",
                         f"`({', '.join(cols)})` is declared to identify a `{t.name}` row, but nothing enforces "
                         "it. Retries, double-submits and webhook redeliveries create duplicates.",
                         "Add a unique constraint (partial if the table is soft-deleted).",
                         f"ALTER TABLE {t.name} ADD CONSTRAINT {t.name}_{'_'.join(cols)}_key UNIQUE ({', '.join(cols)});")

    def is_junction(self, t: Table) -> Optional[set[str]]:
        """Return the linking FK columns if `t` looks like a pure many-to-many link table."""
        tt = self.tenant_table()
        link_fks = [fk for fk in t.fks if fk.ref_table != tt]
        if len(link_fks) != 2 or any(fk.nullable for fk in link_fks):
            return None
        fk_cols = {c for fk in link_fks for c in fk.columns}
        payload = [c.name for c in t.columns if c.name not in fk_cols and c.name not in AUDIT_COLS
                   and c.name != self.tenant_col()]
        return fk_cols if len(payload) <= 1 else None

    def chk_junction_tables(self):
        for t in self.t.values():
            fk_cols = self.is_junction(t)
            if not fk_cols:
                continue
            if any(set(ix.columns) >= fk_cols and ix.unique for ix in t.indexes):
                continue
            self.add("junction-uniqueness", "error", t.name, sorted(fk_cols),
                     "Junction table allows duplicate links",
                     f"`{t.name}` looks like a many-to-many link table but has no unique constraint across "
                     f"({', '.join(sorted(fk_cols))}). The same pair can be inserted twice; every join through it "
                     "will double-count.",
                     "Use the FK pair as the primary key (or add a UNIQUE).",
                     f"ALTER TABLE {t.name} ADD PRIMARY KEY ({', '.join(sorted(fk_cols))});")

    def chk_enumish(self):
        for t in self.t.values():
            for c in t.columns:
                if c.is_fk or c.is_enum_type or c.check:
                    continue
                short = c.type_base in ("varchar", "char", "text") and (c.length is None or c.length <= 32)
                if short and ENUMISH_NAMES.search(c.name):
                    hint = f" The comment lists `{c.comment}`, i.e. the values are known." if c.comment else ""
                    self.add("undocumented-enum", "warn", t.name, [c.name],
                             "Enum-like column with no CHECK",
                             f"`{c.name}` is a short string that clearly takes a fixed set of values, but the "
                             "database accepts anything. Typos become new states, and nobody can list the "
                             f"legal values without reading application code.{hint}",
                             "Add a CHECK constraint (cheap, easy to evolve) or a lookup table if values need "
                             "metadata. Avoid native ENUM types unless the set is truly frozen.",
                             f"ALTER TABLE {t.name} ADD CONSTRAINT {t.name}_{c.name}_check CHECK ({c.name} IN (...));")

    def chk_soft_delete_unique(self):
        for t in self.t.values():
            if not t.col("deleted_at"):
                continue
            for ix in t.indexes:
                if ix.unique and ix.source != "pk" and not ix.where:
                    cols = ", ".join(ix.columns)
                    self.add("soft-delete-unique", "warn", t.name, ix.columns,
                             "Soft delete collides with non-partial UNIQUE",
                             f"`{t.name}` soft-deletes via `deleted_at`, but `({cols})` is unique across live AND "
                             "deleted rows. A user who deletes their account can never sign up again with the "
                             "same value, and `ON CONFLICT` upserts will resurrect ghosts.",
                             "Replace with a partial unique index scoped to live rows.",
                             f"DROP CONSTRAINT/INDEX ...; CREATE UNIQUE INDEX {t.name}_{'_'.join(ix.columns)}_live "
                             f"ON {t.name}({cols}) WHERE deleted_at IS NULL;")

    def chk_polymorphic(self):
        for t in self.t.values():
            names = {c.name for c in t.columns}
            for c in t.columns:
                m = re.match(r"^(.*)_type$", c.name)
                if not m:
                    continue
                idc = t.col(f"{m.group(1)}_id")
                if idc and not idc.is_fk:
                    self.add("polymorphic-reference", "warn", t.name, [c.name, idc.name],
                             "Polymorphic reference without referential integrity",
                             f"`{idc.name}` points at different tables depending on `{c.name}`. No FK can express "
                             "that, so orphans accumulate silently and every join needs a CASE. Acceptable for "
                             "append-only audit data; painful anywhere the target must still exist.",
                             "Either one nullable FK per target with a CHECK that exactly one is set, or a "
                             "supertype table that the targets reference.")

    def chk_exclusive_arc(self):
        declared = {x["table"]: x["columns"] for x in self.a.get("exclusive_arcs", [])}
        for t in self.t.values():
            nullable_fks = [fk for fk in t.fks if fk.nullable and len(fk.columns) == 1
                            and not fk.columns[0].endswith("_by")]
            cols = [fk.columns[0] for fk in nullable_fks]
            if t.name in declared:
                cols = declared[t.name]
            elif len(cols) < 2:
                continue
            guarded = any(all(c in chk for c in cols) for chk in t.checks)
            if not guarded:
                num = " + ".join(f"({c} IS NOT NULL)::int" for c in cols)
                self.add("exclusive-arc", "warn" if t.name in declared else "info", t.name, cols,
                         "Either/or foreign keys without a CHECK",
                         f"`{t.name}` has several nullable FKs ({', '.join(cols)}) that look like an exclusive "
                         "arc — a row should point at exactly one of them. Nothing stops zero or both.",
                         "Add a CHECK that exactly one is non-null, or restructure with a supertype.",
                         f"ALTER TABLE {t.name} ADD CONSTRAINT {t.name}_one_target CHECK ({num} = 1);")

    def chk_timestamps(self):
        for t in self.t.values():
            for c in t.columns:
                if c.type_base == "timestamp":
                    self.add("timestamp-tz", "info", t.name, [c.name], "TIMESTAMP without time zone",
                             f"`{c.name}` stores wall-clock time with no zone. It reads back differently depending "
                             "on the session's TimeZone, and DST transitions produce ambiguous values.",
                             "Use TIMESTAMPTZ.",
                             f"ALTER TABLE {t.name} ALTER COLUMN {c.name} TYPE timestamptz;")

    def chk_money(self):
        for t in self.t.values():
            for c in t.columns:
                if c.type_base in ("double precision", "real") and re.search(
                        r"(amount|price|cost|total|fee|balance|rate|tax|net|gross)", c.name):
                    self.add("money-float", "error", t.name, [c.name], "Monetary value stored as float",
                             f"`{c.name}` is binary floating point. 0.1 + 0.2 ≠ 0.3; sums drift; reconciliation "
                             "against the ledger will be off by cents.",
                             "Use NUMERIC(p, s) or integer minor units.",
                             f"ALTER TABLE {t.name} ALTER COLUMN {c.name} TYPE numeric(14,2);")

    def chk_tenant_scoping(self):
        tt, tc = self.tenant_table(), self.tenant_col()
        if not tt or tt not in self.t:
            return
        graph = {name: [fk.ref_table for fk in t.fks] for name, t in self.t.items()}
        has_domains = bool(self.n.get("domains"))
        for t in self.t.values():
            if self.is_global(t.name) or t.col(tc) or (has_domains and t.domain is None):
                continue
            path = self._shortest_path(graph, t.name, tt)
            if path:
                hops = " → ".join(path)
                sev = "info" if self.is_junction(t) else "warn"
                self.add("tenant-derivable", sev, t.name, [], f"No `{tc}`; tenant only reachable via {len(path) - 1} join(s)",
                         f"`{t.name}` belongs to a tenant only transitively ({hops}). Row-level security, "
                         "per-tenant export/erasure, and per-tenant sharding all need that join. It works at 10 "
                         "tenants and hurts at 1,000.",
                         f"Denormalise `{tc}` onto the table (with a composite FK to keep it consistent), or accept "
                         "the join and write the RLS policy as a subquery now, while it is cheap.")
            else:
                self.add("tenant-unscoped", "error", t.name, [],
                         "Tenant-scoped domain but no path to the tenant",
                         f"`{t.name}` sits in a tenant-scoped domain yet neither has `{tc}` nor references anything "
                         "that leads to it. Its rows cannot be attributed to a tenant at all.",
                         f"Add `{tc}` (NOT NULL, FK) or move the table to a global domain in narratives.json.")

    def chk_rls(self):
        if not self.a.get("require_rls"):
            return
        tc = self.tenant_col()
        has_domains = bool(self.n.get("domains"))
        for t in self.t.values():
            if self.is_global(t.name) or not t.col(tc) or (has_domains and t.domain is None):
                continue
            if not t.rls_enabled:
                self.add("rls-missing", "error", t.name, [tc], "Tenant table without row-level security",
                         f"`{t.name}` carries `{tc}` but RLS is not enabled, so isolation depends entirely on every "
                         "query remembering the WHERE clause. One forgotten filter is a cross-tenant leak.",
                         "Enable RLS and add the standard policy.",
                         f"ALTER TABLE {t.name} ENABLE ROW LEVEL SECURITY;\nCREATE POLICY {t.name}_tenant_isolation ON "
                         f"{t.name} USING ({tc} = current_setting('app.tenant_id')::uuid);")
            elif not t.policies:
                self.add("rls-no-policy", "error", t.name, [tc], "RLS enabled but no policy",
                         "With RLS on and no policy, non-owner roles see zero rows — usually discovered in staging "
                         "as 'the table is empty'.", "Add a policy.")

    def chk_orphans(self):
        for t in self.t.values():
            if not t.fks and not t.referenced_by:
                self.add("orphan-table", "info", t.name, [], "Isolated table",
                         f"`{t.name}` references nothing and nothing references it. Either it is a staging/log "
                         "table (fine, say so), or it is dead, or it is the seed of a second data model growing "
                         "beside the first.",
                         "Document its purpose or drop it.")

    def chk_singletons(self):
        for name in self.a.get("singleton_tables", []):
            t = self.t.get(name)
            if not t:
                continue
            guard = any(ix.unique and not ix.where for ix in t.indexes if ix.source != "pk")
            self.add("singleton-table", "info", name, [], "Single-row configuration table",
                     f"`{name}` is documented as holding exactly one row. Nothing enforces that"
                     f"{'' if guard else ' (no unique constraint besides the PK)'}, and the day a second "
                     "instance is needed (a second GitHub App, a staging vs prod config) every reader that "
                     "does `SELECT * ... LIMIT 1` becomes wrong.",
                     "Either enforce one row (CHECK on a constant column with a UNIQUE) or give it a "
                     "discriminator now (`provider_id`, `environment`) while there is only one row to backfill.",
                     f"ALTER TABLE {name} ADD COLUMN singleton boolean NOT NULL DEFAULT true CHECK (singleton);\n"
                     f"CREATE UNIQUE INDEX {name}_one_row ON {name}(singleton);")

    def chk_fk_cycles(self):
        graph = {name: {fk.ref_table for fk in t.fks if fk.ref_table != name} for name, t in self.t.items()}
        seen, stack, cycles = set(), [], []

        def dfs(n, path):
            if n in path:
                cycles.append(path[path.index(n):] + [n])
                return
            if n in seen:
                return
            seen.add(n)
            for m in graph.get(n, ()):
                dfs(m, path + [n])
        for n in graph:
            dfs(n, [])
        reported = set()
        for cyc in cycles:
            key = frozenset(cyc)
            if key in reported:
                continue
            reported.add(key)
            self.add("fk-cycle", "warn", cyc[0], [], "Foreign-key cycle",
                     f"{' → '.join(cyc)}. Rows must be inserted with a deferred constraint or a NULL-then-update "
                     "dance; backups/restores and truncation have no valid order; ON DELETE CASCADE can loop.",
                     "Break the cycle (move one FK to a link table) or mark one FK DEFERRABLE INITIALLY DEFERRED.")

    def chk_blast_radius(self):
        ranked = sorted(self.t.values(), key=lambda t: len(t.referenced_by), reverse=True)
        for t in ranked[:3]:
            if len(t.referenced_by) >= 5:
                self.add("blast-radius", "info", t.name, [], f"Hub table: referenced by {len(t.referenced_by)} tables",
                         "Any change to its key, its delete semantics, or its partitioning touches every "
                         "dependent. Migrations on hub tables need the longest lock windows and the most careful "
                         "rollout.",
                         "Treat schema changes here as breaking changes with a written rollout plan.")

    def chk_wide_tables(self):
        for t in self.t.values():
            if len(t.columns) >= 30:
                self.add("wide-table", "info", t.name, [], f"Wide table ({len(t.columns)} columns)",
                         "Tables this wide usually hide several entities (or a JSON column that wants to be "
                         "one). Every row update rewrites the whole tuple; TOAST kicks in; indexes bloat.",
                         "Look for column groups that always change together and split them out.")

    @staticmethod
    def _shortest_path(graph: dict[str, list[str]], start: str, goal: str) -> Optional[list[str]]:
        prev = {start: None}
        q = deque([start])
        while q:
            n = q.popleft()
            if n == goal:
                path = []
                while n is not None:
                    path.append(n)
                    n = prev[n]
                return path[::-1]
            for m in graph.get(n, []):
                if m not in prev:
                    prev[m] = n
                    q.append(m)
        return None


# ----------------------------------------------------------------------------
# Rendering
# ----------------------------------------------------------------------------

def model_to_json(tables, extras, narratives, findings, source) -> dict:
    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": source,
        "stats": {
            "tables": len(tables),
            "columns": sum(len(t.columns) for t in tables.values()),
            "foreign_keys": sum(len(t.fks) for t in tables.values()),
            "domains": len(narratives.get("domains", [])),
            "findings": {s: sum(1 for f in findings if f.severity == s) for s in ("error", "warn", "info")},
        },
        "database": narratives.get("database", {}),
        "conventions": narratives.get("conventions", []),
        "domains": narratives.get("domains", []),
        "assertions": narratives.get("assertions", {}),
        "extras": extras,
        "tables": {name: asdict(t) for name, t in tables.items()},
        "findings": [asdict(f) for f in findings],
    }


def mermaid_erd(tables: dict[str, Table], names: list[str]) -> str:
    out = ["erDiagram"]
    for n in names:
        t = tables.get(n)
        if not t:
            continue
        out.append(f"  {n} {{")
        for c in t.columns:
            flags = " ".join(x for x in ("PK" if c.is_pk else "", "FK" if c.is_fk else "", "UK" if c.is_unique else "") if x)
            typ = re.sub(r"[^A-Za-z0-9_]+", "_", c.type).strip("_")
            out.append(f"    {typ} {c.name} {flags}".rstrip())
        out.append("  }")
    for n in names:
        t = tables.get(n)
        if not t:
            continue
        for fk in t.fks:
            if fk.ref_table not in names:
                continue
            left = "||" if not fk.nullable else "|o"
            right = "||" if fk.unique else "o{"
            out.append(f"  {fk.ref_table} {left}--{right} {n} : \"{', '.join(fk.columns)}\"")
    return "\n".join(out)


SEV_LABEL = {"error": "Error", "warn": "Warning", "info": "Note"}


def write_markdown(outdir: str, tables: dict[str, Table], narratives: dict, findings: list[Finding], stats: dict) -> None:
    domains = narratives.get("domains", [])
    os.makedirs(os.path.join(outdir, "domains"), exist_ok=True)
    db = narratives.get("database", {})
    lines = [f"# {db.get('title', 'Database')}", "", db.get("blurb", ""), "",
             f"{stats['tables']} tables · {stats['columns']} columns · {stats['foreign_keys']} foreign keys · "
             f"{stats['findings']['error']} errors · {stats['findings']['warn']} warnings · {stats['findings']['info']} notes",
             "", "See [FINDINGS.md](FINDINGS.md) for the design review.", ""]
    if narratives.get("conventions"):
        lines += ["## Conventions", ""] + [f"- {c}" for c in narratives["conventions"]] + [""]
    lines += ["## Domains", "", "| Domain | Tables | Findings |", "|---|---|---|"]
    for d in domains:
        n_f = sum(len(tables[x].findings) for x in d["tables"] if x in tables)
        lines.append(f"| [{d['title']}](domains/{d['key']}.md) | {len(d['tables'])} | {n_f} |")
    unclaimed = [n for n in tables if tables[n].domain is None]
    if unclaimed:
        lines += ["", "Unclaimed tables: " + ", ".join(f"`{n}`" for n in unclaimed)]
    with open(os.path.join(outdir, "README.md"), "w") as fh:
        fh.write("\n".join(lines) + "\n")

    fmap = {f.id: f for f in findings}
    for d in domains:
        dl = [f"# {d['title']}", "", d.get("blurb", ""), "",
              f"Tenant-scoped: {'yes' if d.get('tenant_scoped') else 'no'}", "", "```mermaid",
              mermaid_erd(tables, d["tables"]), "```", ""]
        for name in d["tables"]:
            t = tables.get(name)
            if not t:
                dl += [f"## {name}", "", "_Listed in narratives but missing from the schema._", ""]
                continue
            dl += [f"## {name}", ""] + ([" ".join(t.description), ""] if t.description else [])
            dl += ["| Column | Type | Null | Default | References | Notes |", "|---|---|---|---|---|---|"]
            for c in t.columns:
                ref = next((f"{fk.ref_table}.{fk.ref_columns[0] if fk.ref_columns else ''}"
                            for fk in t.fks if c.name in fk.columns), "")
                flag = " (PK)" if c.is_pk else (" (UK)" if c.is_unique else "")
                dl.append(f"| `{c.name}`{flag} | {c.type} | {'NOT NULL' if c.not_null else ''} | "
                          f"{c.default or ''} | {ref} | {c.comment.replace('|', '\\|')} |")
            ix = [f"{'UNIQUE ' if i.unique else ''}({', '.join(i.columns)}){' WHERE ' + i.where if i.where else ''}"
                  for i in t.indexes if i.source == "index"]
            dl += ["", f"Indexes: {'; '.join(ix) if ix else 'none'}  ",
                   f"Referenced by: {', '.join(r['table'] for r in t.referenced_by) or 'nothing'}  ",
                   f"RLS: {'enabled, policies: ' + ', '.join(t.policies) if t.rls_enabled else 'off'}", ""]
            if t.findings:
                dl += ["Findings:", ""] + [f"- **{SEV_LABEL[fmap[i].severity]}** {fmap[i].title} — {fmap[i].detail}" for i in t.findings] + [""]
        with open(os.path.join(outdir, "domains", f"{d['key']}.md"), "w") as fh:
            fh.write("\n".join(dl) + "\n")

    fl = ["# Design review findings", "",
          "Deterministic checks run by `db_review.py`. Each finding states what the schema allows today, why it "
          "hurts, and the smallest change that fixes it. The LLM review pass (see SKILL.md) builds on top of these.", ""]
    for sev in ("error", "warn", "info"):
        group = [f for f in findings if f.severity == sev]
        if not group:
            continue
        fl += [f"## {SEV_LABEL[sev]}s ({len(group)})", ""]
        for f in group:
            cols = f" `{', '.join(f.columns)}`" if f.columns else ""
            fl += [f"### {f.id} · {f.table}{cols} — {f.title}", "", f.detail, ""]
            if f.suggestion:
                fl += [f"**Fix:** {f.suggestion}", ""]
            if f.fix_sql:
                fl += ["```sql", f.fix_sql, "```", ""]
    with open(os.path.join(outdir, "FINDINGS.md"), "w") as fh:
        fh.write("\n".join(fl) + "\n")


def write_html(outdir: str, tables: dict[str, Table], narratives: dict, findings: list[Finding], stats: dict, source: str) -> None:
    e = html.escape

    def md(text: str) -> str:
        """Escape, then turn `code` spans into <code>."""
        return re.sub(r"`([^`]+)`", r"<code>\1</code>", e(text))
    db = narratives.get("database", {})
    domains = narratives.get("domains", [])
    fmap = {f.id: f for f in findings}
    unclaimed = [n for n in tables if tables[n].domain is None]

    def badge(sev: str, n: int) -> str:
        return f'<span class="badge {sev}">{n}</span>' if n else ""

    def sev_counts(names):
        c = {"error": 0, "warn": 0, "info": 0}
        for n in names:
            for fid in tables[n].findings if n in tables else []:
                c[fmap[fid].severity] += 1
        return c

    nav = [f'<a href="#overview">Overview</a>', f'<a href="#conventions">Conventions</a>',
           f'<a href="#findings">Findings <span class="count">{len(findings)}</span></a>']
    for d in domains:
        c = sev_counts(d["tables"])
        nav.append(f'<a href="#d-{e(d["key"])}">{e(d["title"])} <span class="count">{len(d["tables"])}</span>'
                   f'{badge("error", c["error"])}{badge("warn", c["warn"])}</a>')
    if unclaimed:
        nav.append(f'<a href="#d-unclaimed">Unclaimed <span class="count">{len(unclaimed)}</span>{badge("error", len(unclaimed))}</a>')

    def table_html(t: Table) -> str:
        rows = []
        for c in t.columns:
            ref = ""
            for fk in t.fks:
                if c.name in fk.columns:
                    ref = f'<a href="#t-{e(fk.ref_table)}">{e(fk.ref_table)}.{e(fk.ref_columns[0] if fk.ref_columns else "")}</a>' \
                          f'<span class="muted"> {e(fk.cardinality)}{"" if fk.on_delete == "NO ACTION" else " · " + e(fk.on_delete)}</span>'
            key = '<span class="key">PK</span>' if c.is_pk else ('<span class="key">UK</span>' if c.is_unique else "")
            notes = e(c.comment)
            if c.check:
                notes += f'<code class="chk">CHECK {e(c.check)}</code>'
            rows.append(f"<tr><td><code>{e(c.name)}</code> {key}</td><td>{e(c.type)}</td>"
                        f"<td>{'NOT NULL' if c.not_null else '<span class=muted>null</span>'}</td>"
                        f"<td>{e(c.default) if c.default else ''}</td><td>{ref}</td><td>{notes}</td></tr>")
        ix = [f"<li>{'UNIQUE ' if i.unique else ''}({e(', '.join(i.columns))}){' <span class=muted>WHERE ' + e(i.where) + '</span>' if i.where else ''}"
              f"{' <span class=muted>' + e(i.name) + '</span>' if i.name else ''}</li>"
              for i in t.indexes if i.source == "index"]
        rb = [f'<li><a href="#t-{e(r["table"])}">{e(r["table"])}</a> <span class="muted">({e(", ".join(r["columns"]))}, {e(r["cardinality"])})</span></li>'
              for r in t.referenced_by]
        fnd = ""
        if t.findings:
            items = "".join(f'<li class="{fmap[i].severity}"><a href="#{i}"><b>{md(fmap[i].title)}</b></a>'
                            f'{" <code>" + e(", ".join(fmap[i].columns)) + "</code>" if fmap[i].columns else ""}'
                            f' — {md(fmap[i].detail)}</li>' for i in t.findings)
            fnd = f'<div class="tfind"><ul>{items}</ul></div>'
        meta = (f'{len(t.columns)} cols · {"RLS on" if t.rls_enabled else "no RLS"}'
                f'{" · " + e(t.section) if t.section else ""} · line {t.source_line}')
        desc = f'<p class="desc">{e(" ".join(t.description))}</p>' if t.description else ""
        return (f'<section class="table" id="t-{e(t.name)}" data-name="{e(t.name)}" data-cols="{e(" ".join(c.name for c in t.columns))}">'
                f'<header><h3>{e(t.name)}</h3><span class="meta">{meta}</span></header>{desc}{fnd}'
                f'<table><thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Default</th><th>References</th><th>Notes</th></tr></thead>'
                f'<tbody>{"".join(rows)}</tbody></table>'
                f'<div class="cols2"><div><h4>Indexes</h4><ul>{"".join(ix) or "<li class=muted>none</li>"}</ul></div>'
                f'<div><h4>Referenced by</h4><ul>{"".join(rb) or "<li class=muted>nothing</li>"}</ul></div></div>'
                f'{"<p class=muted>Table checks: " + e("; ".join(t.checks)) + "</p>" if t.checks else ""}'
                f'</section>')

    body = []
    s = stats["findings"]
    body.append(f'<section id="overview"><h1>{e(db.get("title", "Database"))}</h1><p class="lead">{e(db.get("blurb", ""))}</p>'
                f'<p class="stats">{stats["tables"]} tables · {stats["columns"]} columns · {stats["foreign_keys"]} foreign keys · '
                f'{len(domains)} domains &nbsp;|&nbsp; <span class="error">{s["error"]} errors</span> · '
                f'<span class="warn">{s["warn"]} warnings</span> · <span class="info">{s["info"]} notes</span></p>'
                f'<p class="muted">Generated from <code>{e(source)}</code> on {dt.date.today().isoformat()}.</p></section>')
    conv = "".join(f"<li>{e(c)}</li>" for c in narratives.get("conventions", []))
    body.append(f'<section id="conventions"><h2>Conventions</h2><ul>{conv or "<li class=muted>none declared</li>"}</ul>'
                '<p class="muted">Conventions are claims. Findings below are where the schema breaks them.</p></section>')

    fitems = []
    for sev in ("error", "warn", "info"):
        group = [f for f in findings if f.severity == sev]
        if not group:
            continue
        fitems.append(f'<h3 class="{sev}">{SEV_LABEL[sev]}s ({len(group)})</h3>')
        for f in group:
            cols = f' <code>{e(", ".join(f.columns))}</code>' if f.columns else ""
            fix = f'<p><b>Fix</b> {md(f.suggestion)}</p>' if f.suggestion else ""
            sql = f'<pre>{e(f.fix_sql)}</pre>' if f.fix_sql else ""
            fitems.append(f'<article class="finding {sev}" id="{f.id}"><div class="fh"><span class="fid">{f.id}</span>'
                          f'<a href="#t-{e(f.table)}">{e(f.table)}</a>{cols}<span class="fcheck">{e(f.check)}</span></div>'
                          f'<h4>{md(f.title)}</h4><p>{md(f.detail)}</p>{fix}{sql}</article>')
    body.append(f'<section id="findings"><h2>Findings</h2>{"".join(fitems) or "<p class=muted>No findings.</p>"}</section>')

    for d in domains:
        secs = "".join(table_html(tables[n]) if n in tables else
                       f'<section class="table missing" id="t-{e(n)}"><header><h3>{e(n)}</h3></header><p class="error">Listed in narratives.json but not in the schema.</p></section>'
                       for n in d["tables"])
        body.append(f'<section class="domain" id="d-{e(d["key"])}"><h2>{e(d["title"])} <span class="muted">{len(d["tables"])} tables'
                    f'{" · tenant-scoped" if d.get("tenant_scoped") else ""}</span></h2><p class="lead">{e(d.get("blurb", ""))}</p>{secs}</section>')
    if unclaimed:
        body.append('<section class="domain" id="d-unclaimed"><h2>Unclaimed tables</h2><p class="lead">Present in the schema, absent from every domain.</p>'
                    + "".join(table_html(tables[n]) for n in unclaimed) + '</section>')

    css = """
:root{--bg:#fbfaf7;--ink:#1d2430;--mute:#6b7280;--rule:#e2ddd3;--panel:#ffffff;--acc:#1f5f8b;--err:#b3261e;--warn:#9a6700;--info:#3b6ea5;--errbg:#fbe9e7;--warnbg:#fff4d6;--infobg:#e8f0fa}
@media(prefers-color-scheme:dark){:root{--bg:#171a1f;--ink:#e6e3dc;--mute:#9aa0a8;--rule:#2c313a;--panel:#1e232a;--acc:#7cb3e0;--err:#f28b82;--warn:#f2c14e;--info:#8fb8ea;--errbg:#3a2220;--warnbg:#3a3220;--infobg:#1f2c3a}}
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
"""
    js = """
const q=document.querySelector('nav input');q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();
document.querySelectorAll('section.table').forEach(s=>{const hit=!v||s.dataset.name.includes(v)||s.dataset.cols.includes(v);s.classList.toggle('hidden',!hit);});});
"""
    page = (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{e(db.get("title", "Database"))} — schema &amp; design review</title><style>{css}</style></head><body>'
            f'<nav><p class="brand">{e(db.get("title", "Database"))}</p><p class="sub">{stats["tables"]} tables · {len(domains)} domains</p>'
            f'<input type="search" placeholder="Filter tables and columns"/>{"".join(nav)}</nav>'
            f'<main>{"".join(body)}</main><script>{js}</script></body></html>')
    with open(os.path.join(outdir, "index.html"), "w") as fh:
        fh.write(page)


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("schema", help="schema.sql (a single DDL file; concatenate migrations first if needed)")
    ap.add_argument("--narratives", help="narratives.json with domains, conventions and assertions")
    ap.add_argument("--out", default="docs/database", help="output directory (default docs/database)")
    ap.add_argument("--fail-on", choices=["error", "warn", "info", "never"], default="error",
                    help="exit 1 if findings at this severity or worse exist (default error)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    sql_text = open(args.schema, encoding="utf-8").read()
    narratives = json.load(open(args.narratives, encoding="utf-8")) if args.narratives else {}
    tables, extras = parse_schema(sql_text, args.schema)
    findings = Reviewer(tables, narratives).run()
    doc = model_to_json(tables, extras, narratives, findings, args.schema)

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "schema.json"), "w") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
    write_markdown(args.out, tables, narratives, findings, doc["stats"])
    write_html(args.out, tables, narratives, findings, doc["stats"], args.schema)

    s = doc["stats"]["findings"]
    if not args.quiet:
        print(f"{len(tables)} tables, {doc['stats']['foreign_keys']} FKs, {len(narratives.get('domains', []))} domains → {args.out}/")
        print(f"findings: {s['error']} error, {s['warn']} warn, {s['info']} info")
        for f in findings:
            if f.severity != "info":
                cols = f"({', '.join(f.columns)})" if f.columns else ""
                print(f"  [{f.severity:5}] {f.table}{cols}: {f.title}")
    rank = {"error": 0, "warn": 1, "info": 2, "never": 3}
    worst = min((rank[f.severity] for f in findings), default=3)
    return 1 if worst <= rank[args.fail_on] and args.fail_on != "never" else 0


if __name__ == "__main__":
    sys.exit(main())
