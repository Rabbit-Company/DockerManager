CREATE TABLE firewall_policies (
	host_id bigint PRIMARY KEY REFERENCES hosts (id) ON DELETE CASCADE,
	rules text NOT NULL DEFAULT '',
	host_default text NOT NULL DEFAULT 'accept' CHECK (host_default IN ('accept', 'drop')),
	container_default text NOT NULL DEFAULT 'accept' CHECK (container_default IN ('accept', 'drop')),
	ssh_port integer NOT NULL DEFAULT 22,
	status text NOT NULL DEFAULT 'off' CHECK (status IN ('off', 'pending', 'active', 'reverted', 'failed')),
	detail text,
	pending_token text,
	pending_until timestamptz,
	updated_at timestamptz NOT NULL DEFAULT now()
);
