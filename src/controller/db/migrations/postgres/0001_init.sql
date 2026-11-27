CREATE TABLE users (
	id bigserial PRIMARY KEY,
	username text NOT NULL UNIQUE,
	password_hash text NOT NULL,
	totp_secret text NOT NULL,
	totp_last_step bigint NOT NULL DEFAULT 0,
	role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator', 'viewer')),
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
	id text PRIMARY KEY,
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	csrf text NOT NULL,
	mfa_pending integer NOT NULL DEFAULT 1,
	ip text,
	user_agent text,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE hosts (
	id bigserial PRIMARY KEY,
	name text NOT NULL,
	join_token_hash text UNIQUE,
	join_expires_at timestamptz,
	secret_hash text,
	hostname text,
	facts text,
	enrolled_at timestamptz,
	last_seen_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
	id bigserial PRIMARY KEY,
	user_id bigint REFERENCES users (id) ON DELETE SET NULL,
	host_id bigint REFERENCES hosts (id) ON DELETE SET NULL,
	action text NOT NULL,
	target text,
	ok integer NOT NULL DEFAULT 1,
	detail text,
	ip text,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_host_idx ON audit_log (host_id, created_at DESC);
