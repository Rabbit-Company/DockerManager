CREATE TABLE backup_destinations (
	id bigserial PRIMARY KEY,
	name text NOT NULL UNIQUE,
	kind text NOT NULL CHECK (kind IN ('local', 's3', 'smb', 'nfs')),
	config_secret text NOT NULL,
	key_secret text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE backup_plans (
	stack_id bigint PRIMARY KEY REFERENCES stacks (id) ON DELETE CASCADE,
	destination_id bigint NOT NULL REFERENCES backup_destinations (id),
	schedule text NOT NULL,
	mode text NOT NULL DEFAULT 'stop' CHECK (mode IN ('stop', 'live')),
	items text,
	keep_daily integer NOT NULL DEFAULT 7,
	keep_weekly integer NOT NULL DEFAULT 4,
	keep_monthly integer NOT NULL DEFAULT 6,
	enabled integer NOT NULL DEFAULT 1,
	next_run_at timestamptz
);
CREATE INDEX backup_plans_due_idx ON backup_plans (next_run_at) WHERE enabled = 1;

CREATE TABLE backups (
	id bigserial PRIMARY KEY,
	stack_id bigint NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
	destination_id bigint NOT NULL REFERENCES backup_destinations (id),
	set_path text NOT NULL,
	status text NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'interrupted')),
	trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
	mode text NOT NULL,
	bytes bigint NOT NULL DEFAULT 0,
	items text NOT NULL DEFAULT '[]',
	output text NOT NULL DEFAULT '',
	user_id bigint REFERENCES users (id) ON DELETE SET NULL,
	started_at timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz,
	deleted_at timestamptz
);
CREATE INDEX backups_stack_idx ON backups (stack_id, id DESC);
CREATE UNIQUE INDEX backups_destination_set_idx ON backups (destination_id, set_path);
CREATE INDEX backups_running_idx ON backups (status) WHERE status = 'running';

CREATE TABLE backup_tasks (
	id bigserial PRIMARY KEY,
	backup_id bigint NOT NULL REFERENCES backups (id) ON DELETE CASCADE,
	kind text NOT NULL CHECK (kind IN ('restore', 'verify')),
	status text NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'interrupted')),
	items text NOT NULL DEFAULT '[]',
	output text NOT NULL DEFAULT '',
	user_id bigint REFERENCES users (id) ON DELETE SET NULL,
	started_at timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz
);
CREATE INDEX backup_tasks_backup_idx ON backup_tasks (backup_id, id DESC);
CREATE INDEX backup_tasks_running_idx ON backup_tasks (status) WHERE status = 'running';
