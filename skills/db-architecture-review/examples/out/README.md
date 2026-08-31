# Portal database

Multi-tenant self-service portal. Provider → Tenant hierarchy; every tenant-scoped table carries tenant_id and is protected by row-level security.

19 tables · 95 columns · 22 foreign keys · 8 errors · 18 warnings · 12 notes

See [FINDINGS.md](FINDINGS.md) for the design review.

## Conventions

- Primary keys are UUID v4 (gen_random_uuid()) except append-only logs, which use BIGSERIAL.
- Every tenant-scoped table has a tenant_id column and an RLS policy keyed on app.tenant_id.
- Timestamps are TIMESTAMPTZ.
- Enum-like columns carry a CHECK constraint or use a PostgreSQL ENUM type.
- Soft delete uses deleted_at; uniqueness on soft-deleted tables must be partial (WHERE deleted_at IS NULL).

## Domains

| Domain | Tables | Findings |
|---|---|---|
| [Multi-tenancy](domains/tenant.md) | 4 | 3 |
| [Authentication & identity](domains/auth.md) | 2 | 5 |
| [Permissions (RBAC)](domains/permission.md) | 4 | 6 |
| [GitHub integration](domains/github.md) | 3 | 10 |
| [Approvals & audit](domains/approvals.md) | 4 | 9 |
| [Billing](domains/billing.md) | 1 | 3 |

Unclaimed tables: `legacy_import_staging`

## Diagram

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
  users {
    uuid id PK
    uuid tenant_id FK
    text email UK
    varchar_255 full_name
    timestamptz deleted_at
    timestamptz created_at
  }
  sessions {
    uuid id PK
    uuid user_id FK
    timestamp expires_at
    timestamptz created_at
  }
  role {
    uuid id PK
    uuid tenant_id FK
    varchar_100 name
  }
  permission {
    uuid id PK
    varchar_100 code UK
  }
  role_permission {
    uuid role_id PK FK
    uuid permission_id PK FK
  }
  user_role {
    uuid user_id FK
    uuid role_id FK
    timestamptz granted_at
  }
  github_app_config {
    uuid id PK
    bigint app_id
    varchar_255 app_slug
    varchar_255 client_id
    text private_key_encrypted
    text webhook_secret_encrypted
    varchar_20 status
    uuid created_by FK
    timestamptz created_at
    timestamptz updated_at
  }
  github_app_installation {
    uuid id PK
    uuid tenant_id FK
    bigint installation_id
    varchar_255 account_login
    varchar_20 target_type
    varchar_20 repository_selection
    timestamptz suspended_at
    timestamptz created_at
  }
  webhook_delivery {
    bigserial id PK
    uuid installation_id FK
    uuid delivery_guid
    varchar_64 event_type
    jsonb payload
    timestamptz received_at
  }
  service_request {
    uuid id PK
    uuid tenant_id FK
    varchar_255 title
    timestamptz created_at
  }
  deployment {
    uuid id PK
    uuid tenant_id FK
    varchar_255 target
    timestamptz created_at
  }
  approval_request {
    uuid id PK
    uuid tenant_id FK
    uuid service_request_id FK
    uuid deployment_id FK
    uuid requested_by FK
    uuid approved_by FK
    approval_state state
    timestamptz created_at
  }
  audit_event {
    bigserial id PK
    uuid tenant_id FK
    varchar_20 actor_type
    uuid actor_id
    varchar_100 action
    timestamp occurred_at
    jsonb detail
  }
  invoice_line {
    uuid id PK
    uuid tenant_id FK
    text description
    double_precision amount
    char_3 currency
    timestamptz billed_at
  }
  legacy_import_staging {
    bigserial id PK
    text raw_row
    boolean loaded
  }
  provider ||--o{ tenant : "provider_id"
  tenant ||--o{ tenant_settings : "tenant_id"
  tenant ||--|| tenant_auth_config : "tenant_id"
  tenant ||--o{ users : "tenant_id"
  users ||--o{ sessions : "user_id"
  tenant ||--o{ role : "tenant_id"
  role ||--o{ role_permission : "role_id"
  permission ||--o{ role_permission : "permission_id"
  users ||--o{ user_role : "user_id"
  role ||--o{ user_role : "role_id"
  users |o--o{ github_app_config : "created_by"
  tenant ||--o{ github_app_installation : "tenant_id"
  github_app_installation ||--o{ webhook_delivery : "installation_id"
  tenant ||--o{ service_request : "tenant_id"
  tenant ||--o{ deployment : "tenant_id"
  tenant ||--o{ approval_request : "tenant_id"
  service_request |o--o{ approval_request : "service_request_id"
  deployment |o--o{ approval_request : "deployment_id"
  users ||--o{ approval_request : "requested_by"
  users |o--o{ approval_request : "approved_by"
  tenant ||--o{ audit_event : "tenant_id"
  tenant ||--o{ invoice_line : "tenant_id"
```
