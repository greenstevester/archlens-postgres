# Work

Everything an organisation owns. Each org has exactly one profile; the assertion below deliberately says otherwise.

Tenant-scoped: yes

```mermaid
erDiagram
  widget {
    uuid id PK
    bigint org_id FK
    integer c01
    integer c02
    integer c03
    integer c04
    integer c05
    integer c06
    integer c07
    integer c08
    integer c09
    integer c10
    integer c11
    integer c12
    integer c13
    integer c14
    integer c15
    integer c16
    integer c17
    integer c18
    integer c19
    integer c20
    integer c21
    integer c22
    integer c23
    integer c24
    integer c25
    integer c26
    integer c27
    text extra
  }
  attachment {
    uuid id PK
    bigint org_id FK
    uuid widget_id FK
    uuid ticket_id FK
  }
  ticket {
    uuid id PK
    bigint org_id FK
    text email
    varchar_12 state
    smallint priority
    text label
    text assignee
    text alt_email
    timestamptz deleted_at
  }
  profile {
    uuid id PK
    bigint org_id FK UK
    text bio
  }
  region {
    bigint org_id PK FK
    char_3 code PK
    uuid lead_id FK
  }
  site {
    uuid id PK
    bigint org_id FK
    char_3 region FK
  }
  scratch {
    serial id PK
    text body
  }
  widget |o--o{ attachment : "widget_id"
  ticket |o--o{ attachment : "ticket_id"
  site |o--o{ region : "lead_id"
  region ||--o{ site : "org_id, region"
```

## widget

Schema-qualified, thirty columns wide, RLS enabled with no policy. Schema-qualified table.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | uuid | NOT NULL | gen_random_uuid() |  |  |
| `org_id` | bigint | NOT NULL |  | org.id |  |
| `c01` | integer |  |  |  |  |
| `c02` | integer |  |  |  |  |
| `c03` | integer |  |  |  |  |
| `c04` | integer |  |  |  |  |
| `c05` | integer |  |  |  |  |
| `c06` | integer |  |  |  |  |
| `c07` | integer |  |  |  |  |
| `c08` | integer |  |  |  |  |
| `c09` | integer |  |  |  |  |
| `c10` | integer |  |  |  |  |
| `c11` | integer |  |  |  |  |
| `c12` | integer |  |  |  |  |
| `c13` | integer |  |  |  |  |
| `c14` | integer |  |  |  |  |
| `c15` | integer |  |  |  |  |
| `c16` | integer |  |  |  |  |
| `c17` | integer |  |  |  |  |
| `c18` | integer |  |  |  |  |
| `c19` | integer |  |  |  |  |
| `c20` | integer |  |  |  |  |
| `c21` | integer |  |  |  |  |
| `c22` | integer |  |  |  |  |
| `c23` | integer |  |  |  |  |
| `c24` | integer |  |  |  |  |
| `c25` | integer |  |  |  |  |
| `c26` | integer |  |  |  |  |
| `c27` | integer |  |  |  |  |
| `extra` | text |  |  |  |  |

Indexes: (org_id)  
Referenced by: attachment  
RLS: enabled, policies: 

Findings:

- **Error** RLS enabled but no policy — With RLS on and no policy, non-owner roles see zero rows — usually discovered in staging as 'the table is empty'.
- **Note** Wide table (30 columns) — Tables this wide usually hide several entities (or a JSON column that wants to be one). Every row update rewrites the whole tuple; TOAST kicks in; indexes bloat.

## attachment

Either/or foreign keys guarded by a CHECK: the exclusive-arc check must stay quiet.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | uuid | NOT NULL | gen_random_uuid() |  |  |
| `org_id` | bigint | NOT NULL |  | org.id |  |
| `widget_id` | uuid |  |  | widget.id |  |
| `ticket_id` | uuid |  |  | ticket.id |  |

Indexes: none  
Referenced by: nothing  
RLS: off

Findings:

- **Warning** Foreign key without index — PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `org` must scan `attachment` to check the constraint, and every join from the parent side is a sequential scan.
- **Warning** Foreign key without index — PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `widget` must scan `attachment` to check the constraint, and every join from the parent side is a sequential scan.
- **Warning** Foreign key without index — PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `ticket` must scan `attachment` to check the constraint, and every join from the parent side is a sequential scan.
- **Note** Tenant FK relies on the default ON DELETE NO ACTION — Deleting a `org` row will fail while `attachment` rows exist. Fine if tenants are never hard-deleted; a surprise the day offboarding/GDPR erasure is built.
- **Error** Tenant table without row-level security — `attachment` carries `org_id` but RLS is not enabled, so isolation depends entirely on every query remembering the WHERE clause. One forgotten filter is a cross-tenant leak.

## ticket

Soft delete done right (partial unique), an expression index, CHECKs of every shape.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | uuid | NOT NULL | gen_random_uuid() |  |  |
| `org_id` | bigint | NOT NULL |  | org.id |  |
| `email` | text | NOT NULL |  |  |  |
| `state` | varchar(12) | NOT NULL | 'open' |  | open \| closed   (enum-ish, no CHECK) |
| `priority` | smallint | NOT NULL | 0 |  |  |
| `label` | text |  |  |  |  |
| `assignee` | text |  |  |  |  |
| `alt_email` | text |  | COALESCE(NULL, 'none@example.com') |  |  |
| `deleted_at` | timestamptz |  |  |  |  |

Indexes: UNIQUE (email) WHERE deleted_at IS NULL; (lower(email)); (org_id)  
Referenced by: attachment  
RLS: enabled, policies: ticket_isolation

Findings:

- **Warning** Enum-like column with no CHECK — `state` is a short string that clearly takes a fixed set of values, but the database accepts anything. Typos become new states, and nobody can list the legal values without reading application code. The comment lists `open | closed   (enum-ish, no CHECK)`, i.e. the values are known.

## profile

One profile per org, enforced by UNIQUE; the narrative wrongly claims many.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | uuid | NOT NULL | gen_random_uuid() |  |  |
| `org_id` (UK) | bigint | NOT NULL |  | org.id |  |
| `bio` | text |  |  |  |  |

Indexes: none  
Referenced by: nothing  
RLS: enabled, policies: profile_isolation

Findings:

- **Warning** Modelled 1:1 but intended 1:N — The narrative expects many `profile` per `org`, but the FK is UNIQUE, so the second child will fail to insert.
- **Note** Single-row configuration table — `profile` is documented as holding exactly one row. Nothing enforces that, and the day a second instance is needed (a second GitHub App, a staging vs prod config) every reader that does `SELECT * ... LIMIT 1` becomes wrong.

## region

Composite primary key, multi-column foreign key, and a two-table foreign-key cycle.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `org_id` (PK) | bigint | NOT NULL |  | org.id |  |
| `code` (PK) | char(3) | NOT NULL |  |  |  |
| `lead_id` | uuid |  |  | site.id |  |

Indexes: none  
Referenced by: site  
RLS: off

Findings:

- **Warning** Foreign key without index — PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `site` must scan `region` to check the constraint, and every join from the parent side is a sequential scan.
- **Note** Nullable foreign key — `region.lead_id` may be NULL, so the relationship to `site` is optional. That is legitimate (e.g. approved_by before approval) but often a modelling shrug: a row with no owner, or two nullable FKs that are secretly an either/or.
- **Note** Tenant FK relies on the default ON DELETE NO ACTION — Deleting a `org` row will fail while `region` rows exist. Fine if tenants are never hard-deleted; a surprise the day offboarding/GDPR erasure is built.
- **Error** Tenant table without row-level security — `region` carries `org_id` but RLS is not enabled, so isolation depends entirely on every query remembering the WHERE clause. One forgotten filter is a cross-tenant leak.
- **Warning** Foreign-key cycle — region → site → region. Rows must be inserted with a deferred constraint or a NULL-then-update dance; backups/restores and truncation have no valid order; ON DELETE CASCADE can loop.

## site

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | uuid | NOT NULL | gen_random_uuid() |  |  |
| `org_id` | bigint | NOT NULL |  | region.org_id |  |
| `region` | char(3) | NOT NULL |  | region.org_id |  |

Indexes: none  
Referenced by: region  
RLS: off

Findings:

- **Warning** Foreign key without index — PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `region` must scan `site` to check the constraint, and every join from the parent side is a sequential scan.
- **Error** Asserted natural key is not enforced — `(org_id, region)` is declared to identify a `site` row, but nothing enforces it. Retries, double-submits and webhook redeliveries create duplicates.
- **Error** Tenant table without row-level security — `site` carries `org_id` but RLS is not enabled, so isolation depends entirely on every query remembering the WHERE clause. One forgotten filter is a cross-tenant leak.

## scratch

Claimed by a tenant-scoped domain, but no org_id and no path to org.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | serial | NOT NULL |  |  |  |
| `body` | text |  |  |  |  |

Indexes: none  
Referenced by: nothing  
RLS: off

Findings:

- **Error** Asserted relationship has no foreign key — narratives.json says `org` → `scratch` is 1:1, but there is no FK from the child to the parent. The relationship exists only in application code.
- **Error** Tenant-scoped domain but no path to the tenant — `scratch` sits in a tenant-scoped domain yet neither has `org_id` nor references anything that leads to it. Its rows cannot be attributed to a tenant at all.
- **Note** Isolated table — `scratch` references nothing and nothing references it. Either it is a staging/log table (fine, say so), or it is dead, or it is the seed of a second data model growing beside the first.

