CREATE TABLE backup_destinations (
	id integer PRIMARY KEY,
	name text NOT NULL UNIQUE,
	kind text NOT NULL CHECK (kind IN ('local', 's3', 'smb', 'nfs')),
	config_secret text NOT NULL,
	key_secret text NOT NULL,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE backup_plans (
	stack_id integer PRIMARY KEY REFERENCES stacks (id) ON DELETE CASCADE,
	destination_id integer NOT NULL REFERENCES backup_destinations (id),
	schedule text NOT NULL,
	mode text NOT NULL DEFAULT 'stop' CHECK (mode IN ('stop', 'live')),
	items text,
	keep_daily integer NOT NULL DEFAULT 7,
	keep_weekly integer NOT NULL DEFAULT 4,
	keep_monthly integer NOT NULL DEFAULT 6,
	enabled integer NOT NULL DEFAULT 1,
	next_run_at text
);
CREATE INDEX backup_plans_due_idx ON backup_plans (next_run_at) WHERE enabled = 1;

CREATE TABLE backups (
	id integer PRIMARY KEY,
	stack_id integer NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
	destination_id integer NOT NULL REFERENCES backup_destinations (id),
	set_path text NOT NULL,
	status text NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'interrupted')),
	trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
	mode text NOT NULL,
	bytes integer NOT NULL DEFAULT 0,
	items text NOT NULL DEFAULT '[]',
	output text NOT NULL DEFAULT '',
	user_id integer REFERENCES users (id) ON DELETE SET NULL,
	started_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	finished_at text,
	deleted_at text
);
CREATE INDEX backups_stack_idx ON backups (stack_id, id DESC);
CREATE UNIQUE INDEX backups_destination_set_idx ON backups (destination_id, set_path);
CREATE INDEX backups_running_idx ON backups (status) WHERE status = 'running';

CREATE TABLE backup_tasks (
	id integer PRIMARY KEY,
	backup_id integer NOT NULL REFERENCES backups (id) ON DELETE CASCADE,
	kind text NOT NULL CHECK (kind IN ('restore', 'verify')),
	status text NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'interrupted')),
	items text NOT NULL DEFAULT '[]',
	output text NOT NULL DEFAULT '',
	user_id integer REFERENCES users (id) ON DELETE SET NULL,
	started_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	finished_at text
);
CREATE INDEX backup_tasks_backup_idx ON backup_tasks (backup_id, id DESC);
CREATE INDEX backup_tasks_running_idx ON backup_tasks (status) WHERE status = 'running';
