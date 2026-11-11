/** Migração inicial do esquema RemoteX (PostgreSQL). */
export const version = '001_init';
export const sql = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{8}$'),
  kind text NOT NULL CHECK (kind IN ('host', 'client')),
  name text NOT NULL,
  platform text NOT NULL DEFAULT '',
  app_version text NOT NULL DEFAULT '',
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  token_hash text NOT NULL,
  public_key text,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  last_ip text
);
CREATE INDEX IF NOT EXISTS devices_owner_idx ON devices(owner_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  host_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  client_ip text,
  status text NOT NULL,
  auth_method text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  end_reason text
);
CREATE INDEX IF NOT EXISTS sessions_host_idx ON sessions(host_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_client_idx ON sessions(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  target text,
  ip text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log(at DESC);
`;
