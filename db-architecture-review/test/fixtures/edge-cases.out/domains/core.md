# Core

Organisations, and a table the narrative still lists but the schema dropped.

Tenant-scoped: no

```mermaid
erDiagram
  org {
    bigserial id PK
    text name
    varchar_10 kind
    real fee
    numeric_14_2 weight
    text tags
    jsonb settings
    timestamp_3 created_at
    integer score
    double_precision ratio
    boolean active
    char_2 note
    smallint seq_no
    mood feeling
  }
```

## org

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | bigserial | NOT NULL |  |  |  |
| `name` | text | NOT NULL |  |  |  |
| `kind` | varchar(10) | NOT NULL | 'std' |  | CHECK present: no enum finding |
| `fee` | real |  |  |  | money as float (REAL branch) |
| `weight` | numeric(14, 2) | NOT NULL | 0 |  | zero default is omitted from the tree |
| `tags` | text[] | NOT NULL | ARRAY['a', 'b'] |  |  |
| `settings` | jsonb | NOT NULL | CAST('{}' AS jsonb) |  |  |
| `created_at` | timestamp(3) | NOT NULL | CURRENT_TIMESTAMP |  |  |
| `score` | integer | NOT NULL | -1 |  |  |
| `ratio` | double precision |  | 1.5 |  |  |
| `active` | boolean | NOT NULL | TRUE |  |  |
| `note` | char(2) |  | NULL |  |  |
| `seq_no` | smallint | NOT NULL | nextval('org_seq') |  |  |
| `feeling` | mood |  |  |  |  |

Indexes: none  
Referenced by: widget, attachment, ticket, profile, region  
RLS: off

Findings:

- **Note** TIMESTAMP without time zone — `created_at` stores wall-clock time with no zone. It reads back differently depending on the session's TimeZone, and DST transitions produce ambiguous values.
- **Error** Monetary value stored as float — `fee` is binary floating point. 0.1 + 0.2 ≠ 0.3; sums drift; reconciliation against the ledger will be off by cents.
- **Note** Hub table: referenced by 5 tables — Any change to its key, its delete semantics, or its partitioning touches every dependent. Migrations on hub tables need the longest lock windows and the most careful rollout.

## ghost_table

_Listed in narratives but missing from the schema._

