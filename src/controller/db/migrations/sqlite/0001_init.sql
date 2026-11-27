CREATE TABLE users (
	id integer PRIMARY KEY,
	username text NOT NULL UNIQUE,
	password_hash text NOT NULL,
	totp_secret text NOT NULL,
	totp_last_step integer NOT NULL DEFAULT 0,
	role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator', 'viewer')),
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
	id text PRIMARY KEY,
	user_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	csrf text NOT NULL,
	mfa_pending integer NOT NULL DEFAULT 1,
	ip text,
	user_agent text,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	expires_at text NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE hosts (
	id integer PRIMARY KEY,
	name text NOT NULL,
	join_token_hash text UNIQUE,
	join_expires_at text,
	secret_hash text,
	hostname text,
	facts text,
	enrolled_at text,
	last_seen_at text,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE audit_log (
	id integer PRIMARY KEY,
	user_id integer REFERENCES users (id) ON DELETE SET NULL,
	host_id integer REFERENCES hosts (id) ON DELETE SET NULL,
	action text NOT NULL,
	target text,
	ok integer NOT NULL DEFAULT 1,
	detail text,
	ip text,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_host_idx ON audit_log (host_id, created_at DESC);
