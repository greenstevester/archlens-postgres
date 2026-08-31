# Multi-tenancy

The Provider → Tenant hierarchy every other table hangs off, with per-tenant settings and auth configuration. Each tenant has exactly one settings row and at most one auth config.

Tenant-scoped: no

```mermaid
erDiagram
  provider {
    uuid id PK
    varchar_255 name
    timestamptz created_at
  }
  tenant {
    uuid id PK
    uuid provider_id FK
    varchar_63 slug UK
    varchar_255 display_name
    varchar_20 status
    timestamptz created_at
    timestamptz updated_at
  }
  tenant_settings {
    uuid id PK
    uuid tenant_id FK
    varchar_64 timezone
    varchar_16 locale
    timestamptz updated_at
  }
  tenant_auth_config {
    uuid tenant_id PK FK
    text oidc_issuer
    boolean mfa_required
    timestamptz updated_at
  }
  provider ||--o{ tenant : "provider_id"
  tenant ||--o{ tenant_settings : "tenant_id"
  tenant ||--|| tenant_auth_config : "tenant_id"
```

## provider

Top of the hierarchy. One row per hosting provider.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | uuid | NOT NULL | gen_random_uuid() |  |  |
| `name` | varchar(255) | NOT NULL |  |  |  |
| `created_at` | timestamptz | NOT NULL | now() |  |  |

Indexes: none  
Referenced by: tenant  
RLS: off

## tenant

A customer organisation. Everything tenant-scoped hangs off this row.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | uuid | NOT NULL | gen_random_uuid() |  |  |
| `provider_id` | uuid | NOT NULL |  | provider.id |  |
| `slug` (UK) | varchar(63) | NOT NULL |  |  |  |
| `display_name` | varchar(255) | NOT NULL |  |  |  |
| `status` | varchar(20) | NOT NULL | 'active' |  |  |
| `created_at` | timestamptz | NOT NULL | now() |  |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |  |

Indexes: (provider_id)  
Referenced by: tenant_settings, tenant_auth_config, users, role, github_app_installation, service_request, deployment, approval_request, audit_event, invoice_line  
RLS: off

Findings:

- **Warning** Enum-like column with no CHECK — `status` is a short string that clearly takes a fixed set of values, but the database accepts anything. Typos become new states, and nobody can list the legal values without reading application code.
- **Note** Hub table: referenced by 10 tables — Any change to its key, its delete semantics, or its partitioning touches every dependent. Migrations on hub tables need the longest lock windows and the most careful rollout.

## tenant_settings

Per-tenant settings. Intended to be exactly one row per tenant.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | uuid | NOT NULL | gen_random_uuid() |  |  |
| `tenant_id` | uuid | NOT NULL |  | tenant.id |  |
| `timezone` | varchar(64) | NOT NULL | 'UTC' |  |  |
| `locale` | varchar(16) | NOT NULL | 'en' |  |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |  |

Indexes: (tenant_id)  
Referenced by: nothing  
RLS: off

Findings:

- **Error** Modelled 1:N but intended 1:1 — The narrative says each `tenant` has exactly one `tenant_settings`, but `tenant_id` is not UNIQUE, so the database happily stores five. Application code that does `.single()` or `LIMIT 1` will return an arbitrary row.

## tenant_auth_config

Per-tenant auth config. Correctly modelled 1:1.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `tenant_id` (PK) | uuid | NOT NULL |  | tenant.id |  |
| `oidc_issuer` | text |  |  |  |  |
| `mfa_required` | boolean | NOT NULL | FALSE |  |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |  |

Indexes: none  
Referenced by: nothing  
RLS: off

