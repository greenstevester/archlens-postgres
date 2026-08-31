-- ============================================================================
-- Sample portal schema — deliberately contains design flaws so the review
-- engine has something to find. Every flaw is marked with  ⚠ FLAW  in a comment.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE approval_state AS ENUM ('pending', 'approved', 'rejected');

-- ---------------------------------------------------------------------------
-- PHASE 1 — Multi-tenancy
-- ---------------------------------------------------------------------------

-- Top of the hierarchy. One row per hosting provider.
CREATE TABLE provider (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A customer organisation. Everything tenant-scoped hangs off this row.
CREATE TABLE tenant (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  UUID NOT NULL REFERENCES provider(id) ON DELETE RESTRICT,
  slug         VARCHAR(63) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'active',   -- ⚠ FLAW: enum-ish, no CHECK
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tenant_provider ON tenant(provider_id);

-- Per-tenant settings. Intended to be exactly one row per tenant.
CREATE TABLE tenant_settings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,  -- ⚠ FLAW: meant 1:1 but no UNIQUE
  timezone    VARCHAR(64) NOT NULL DEFAULT 'UTC',
  locale      VARCHAR(16) NOT NULL DEFAULT 'en',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tenant_settings_tenant ON tenant_settings(tenant_id);

-- Per-tenant auth config. Correctly modelled 1:1.
CREATE TABLE tenant_auth_config (
  tenant_id     UUID PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  oidc_issuer   TEXT,
  mfa_required  BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- PHASE 2 — Authentication & identity
-- ---------------------------------------------------------------------------

-- Portal users. Soft-deleted.
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  full_name   VARCHAR(255),
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email)   -- ⚠ FLAW: non-partial UNIQUE with soft delete
);
CREATE INDEX idx_users_tenant ON users(tenant_id);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  expires_at  TIMESTAMP NOT NULL,           -- ⚠ FLAW: timestamp without time zone
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sessions
  ADD CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
-- ⚠ FLAW: sessions.user_id has no index; no tenant_id column either

-- ---------------------------------------------------------------------------
-- PHASE 2 — Permissions
-- ---------------------------------------------------------------------------

CREATE TABLE role (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  UNIQUE (tenant_id, name)
);
ALTER TABLE role ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_tenant_isolation ON role USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE TABLE permission (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code  VARCHAR(100) NOT NULL UNIQUE
);

-- Correct junction table: composite PK, both sides indexed.
CREATE TABLE role_permission (
  role_id        UUID NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_id  UUID NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX idx_role_permission_permission ON role_permission(permission_id);

-- ⚠ FLAW: junction table with no primary key or unique — duplicate links possible.
CREATE TABLE user_role (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- PHASE 3 — GitHub integration
-- ---------------------------------------------------------------------------

-- Provider-level single-row App config. NOT tenant-scoped.
CREATE TABLE github_app_config (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                      BIGINT,
  app_slug                    VARCHAR(255),
  client_id                   VARCHAR(255),
  private_key_encrypted       TEXT,
  webhook_secret_encrypted    TEXT,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active',  -- ⚠ FLAW: enum-ish
  created_by                  UUID REFERENCES users(id),               -- ⚠ FLAW: nullable, unindexed FK
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-tenant installation mapping (tenant -> GitHub App installation).
CREATE TABLE github_app_installation (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  installation_id        BIGINT NOT NULL,        -- ⚠ FLAW: no UNIQUE(tenant_id, installation_id)
  account_login          VARCHAR(255),
  target_type            VARCHAR(20),            -- Organization | User   ⚠ FLAW: enum in a comment
  repository_selection   VARCHAR(20),            -- all | selected        ⚠ FLAW: enum in a comment
  suspended_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_gh_installation_tenant ON github_app_installation(tenant_id);
ALTER TABLE github_app_installation ENABLE ROW LEVEL SECURITY;
CREATE POLICY github_app_installation_tenant_isolation ON github_app_installation USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Raw webhook deliveries. No tenant_id — tenant is reachable via installation.
CREATE TABLE webhook_delivery (
  id               BIGSERIAL PRIMARY KEY,
  installation_id  UUID NOT NULL REFERENCES github_app_installation(id) ON DELETE CASCADE,
  delivery_guid    UUID NOT NULL,
  event_type       VARCHAR(64) NOT NULL,
  payload          JSONB NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ⚠ FLAW: installation_id unindexed; delivery_guid not unique (webhooks retry!)

-- ---------------------------------------------------------------------------
-- PHASE 4 — Approvals & audit
-- ---------------------------------------------------------------------------

CREATE TABLE service_request (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  title      VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_service_request_tenant ON service_request(tenant_id);
ALTER TABLE service_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_request_tenant_isolation ON service_request USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE TABLE deployment (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  target     VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_deployment_tenant ON deployment(tenant_id);
ALTER TABLE deployment ENABLE ROW LEVEL SECURITY;
CREATE POLICY deployment_tenant_isolation ON deployment USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- An approval is for EITHER a service request OR a deployment.
CREATE TABLE approval_request (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  service_request_id  UUID REFERENCES service_request(id),   -- ⚠ FLAW: exclusive arc without CHECK
  deployment_id       UUID REFERENCES deployment(id),
  requested_by        UUID NOT NULL REFERENCES users(id),
  approved_by         UUID REFERENCES users(id),
  state               approval_state NOT NULL DEFAULT 'pending',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_approval_tenant ON approval_request(tenant_id);
CREATE INDEX idx_approval_requested_by ON approval_request(requested_by);
ALTER TABLE approval_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY approval_request_tenant_isolation ON approval_request USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Append-only audit trail. actor may be a user or a system job.
CREATE TABLE audit_event (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenant(id),
  actor_type   VARCHAR(20) NOT NULL,     -- user | system   ⚠ FLAW: polymorphic ref, no FK
  actor_id     UUID,
  action       VARCHAR(100) NOT NULL,
  occurred_at  TIMESTAMP NOT NULL DEFAULT now(),   -- ⚠ FLAW: no time zone
  detail       JSONB
);
CREATE INDEX idx_audit_tenant_time ON audit_event(tenant_id, occurred_at);
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_event_tenant_isolation ON audit_event USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- ---------------------------------------------------------------------------
-- PHASE 5 — Billing
-- ---------------------------------------------------------------------------

CREATE TABLE invoice_line (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenant(id),
  description TEXT NOT NULL,
  amount      DOUBLE PRECISION NOT NULL,   -- ⚠ FLAW: money as float
  currency    CHAR(3) NOT NULL DEFAULT 'CHF',
  billed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoice_line_tenant ON invoice_line(tenant_id);
-- ⚠ FLAW: no RLS on invoice_line

-- ⚠ FLAW: orphan — nothing references it, it references nothing, and it is in
-- no domain in narratives.json.
CREATE TABLE legacy_import_staging (
  id       BIGSERIAL PRIMARY KEY,
  raw_row  TEXT,
  loaded   BOOLEAN DEFAULT false
);

COMMENT ON TABLE audit_event IS 'Append-only. Never UPDATE or DELETE rows here.';
COMMENT ON COLUMN github_app_config.private_key_encrypted IS 'AES-256-GCM via EncryptionService';
