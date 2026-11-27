CREATE TABLE stacks (
	id integer PRIMARY KEY,
	host_id integer NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
	name text NOT NULL,
	directory text,
	file text NOT NULL DEFAULT 'compose.yaml',
	adopted integer NOT NULL DEFAULT 0,
	current_version integer NOT NULL DEFAULT 0,
	deployed_version integer,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX stacks_host_name_idx ON stacks (host_id, name);

CREATE TABLE stack_versions (
	id integer PRIMARY KEY,
	stack_id integer NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
	number integer NOT NULL,
	compose text NOT NULL,
	env_secret text NOT NULL DEFAULT '',
	message text,
	user_id integer REFERENCES users (id) ON DELETE SET NULL,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX stack_versions_number_idx ON stack_versions (stack_id, number);

CREATE TABLE stack_deploys (
	id integer PRIMARY KEY,
	stack_id integer NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
	version integer,
	action text NOT NULL,
	status text NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'interrupted')),
	output text NOT NULL DEFAULT '',
	user_id integer REFERENCES users (id) ON DELETE SET NULL,
	started_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	finished_at text
);
CREATE INDEX stack_deploys_stack_idx ON stack_deploys (stack_id, id DESC);
CREATE INDEX stack_deploys_running_idx ON stack_deploys (status) WHERE status = 'running';
