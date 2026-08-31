# Permissions (RBAC)

Roles per tenant, the global permission catalogue, and the two junction tables that tie users → roles → permissions.

Tenant-scoped: yes

```mermaid
erDiagram
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
  role ||--o{ role_permission : "role_id"
  permission ||--o{ role_permission : "permission_id"
  role ||--o{ user_role : "role_id"
```

## role

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | uuid | NOT NULL | gen_random_uuid() |  |  |
| `tenant_id` | uuid | NOT NULL |  | tenant.id |  |
| `name` | varchar(100) | NOT NULL |  |  |  |

Indexes: none  
Referenced by: role_permission, user_role  
RLS: enabled, policies: role_tenant_isolation

## permission

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `id` (PK) | uuid | NOT NULL | gen_random_uuid() |  |  |
| `code` (UK) | varchar(100) | NOT NULL |  |  |  |

Indexes: none  
Referenced by: role_permission  
RLS: off

## role_permission

Correct junction table: composite PK, both sides indexed.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `role_id` (PK) | uuid | NOT NULL |  | role.id |  |
| `permission_id` (PK) | uuid | NOT NULL |  | permission.id |  |

Indexes: (permission_id)  
Referenced by: nothing  
RLS: off

Findings:

- **Note** No `tenant_id`; tenant only reachable via 2 join(s) — `role_permission` belongs to a tenant only transitively (role_permission → role → tenant). Row-level security, per-tenant export/erasure, and per-tenant sharding all need that join. It works at 10 tenants and hurts at 1,000.

## user_role

⚠ FLAW: junction table with no primary key or unique — duplicate links possible.

| Column | Type | Null | Default | References | Notes |
|---|---|---|---|---|---|
| `user_id` | uuid | NOT NULL |  | users.id |  |
| `role_id` | uuid | NOT NULL |  | role.id |  |
| `granted_at` | timestamptz | NOT NULL | now() |  |  |

Indexes: none  
Referenced by: nothing  
RLS: off

Findings:

- **Error** No primary key — Without a primary key rows are not individually addressable: no safe UPDATE/DELETE of one row, no logical replication, ORMs misbehave, and duplicates are legal.
- **Warning** Foreign key without index — PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `users` must scan `user_role` to check the constraint, and every join from the parent side is a sequential scan.
- **Warning** Foreign key without index — PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `role` must scan `user_role` to check the constraint, and every join from the parent side is a sequential scan.
- **Error** Junction table allows duplicate links — `user_role` looks like a many-to-many link table but has no unique constraint across (role_id, user_id). The same pair can be inserted twice; every join through it will double-count.
- **Note** No `tenant_id`; tenant only reachable via 2 join(s) — `user_role` belongs to a tenant only transitively (user_role → users → tenant). Row-level security, per-tenant export/erasure, and per-tenant sharding all need that join. It works at 10 tenants and hurts at 1,000.

