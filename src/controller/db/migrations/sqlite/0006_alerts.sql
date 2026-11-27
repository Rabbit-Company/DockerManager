CREATE TABLE alert_channels (
	id integer PRIMARY KEY,
	name text NOT NULL UNIQUE,
	kind text NOT NULL CHECK (kind IN ('email', 'ntfy', 'discord', 'webhook')),
	config_secret text NOT NULL,
	enabled integer NOT NULL DEFAULT 1,
	last_sent_at text,
	last_error text,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE alert_rules (
	rule text PRIMARY KEY,
	enabled integer NOT NULL DEFAULT 1,
	threshold real,
	minutes integer,
	channels text
);

CREATE TABLE alerts (
	id integer PRIMARY KEY,
	rule text NOT NULL,
	target text NOT NULL,
	host_id integer REFERENCES hosts (id) ON DELETE CASCADE,
	severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
	title text NOT NULL,
	detail text,
	link text,
	status text NOT NULL CHECK (status IN ('firing', 'resolved', 'event')),
	started_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	resolved_at text
);
CREATE UNIQUE INDEX alerts_firing_idx ON alerts (rule, target) WHERE status = 'firing';
CREATE INDEX alerts_started_idx ON alerts (started_at DESC);
CREATE INDEX alerts_event_target_idx ON alerts (rule, target) WHERE status = 'event';
