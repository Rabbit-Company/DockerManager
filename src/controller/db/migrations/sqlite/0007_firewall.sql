CREATE TABLE firewall_policies (
	host_id integer PRIMARY KEY REFERENCES hosts (id) ON DELETE CASCADE,
	rules text NOT NULL DEFAULT '',
	host_default text NOT NULL DEFAULT 'accept' CHECK (host_default IN ('accept', 'drop')),
	container_default text NOT NULL DEFAULT 'accept' CHECK (container_default IN ('accept', 'drop')),
	ssh_port integer NOT NULL DEFAULT 22,
	status text NOT NULL DEFAULT 'off' CHECK (status IN ('off', 'pending', 'active', 'reverted', 'failed')),
	detail text,
	pending_token text,
	pending_until text,
	updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
