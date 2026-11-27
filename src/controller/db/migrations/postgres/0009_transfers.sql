ALTER TABLE backups ADD COLUMN stack_version integer;

CREATE TABLE backup_transfers (
	id bigserial PRIMARY KEY,
	backup_id bigint NOT NULL REFERENCES backups (id) ON DELETE CASCADE,
	target_host_id bigint NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
	target_stack_id bigint REFERENCES stacks (id) ON DELETE SET NULL,
	status text NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'interrupted')),
	output text NOT NULL DEFAULT '',
	user_id bigint REFERENCES users (id) ON DELETE SET NULL,
	started_at timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz
);
CREATE INDEX backup_transfers_backup_idx ON backup_transfers (backup_id, id DESC);
CREATE INDEX backup_transfers_running_idx ON backup_transfers (status) WHERE status = 'running';

CREATE TABLE stack_moves (
	id bigserial PRIMARY KEY,
	source_stack_id bigint NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
	target_host_id bigint NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
	destination_id bigint NOT NULL REFERENCES backup_destinations (id),
	backup_id bigint REFERENCES backups (id) ON DELETE SET NULL,
	target_stack_id bigint REFERENCES stacks (id) ON DELETE SET NULL,
	status text NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'interrupted')),
	output text NOT NULL DEFAULT '',
	user_id bigint REFERENCES users (id) ON DELETE SET NULL,
	started_at timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz
);
CREATE INDEX stack_moves_source_idx ON stack_moves (source_stack_id, id DESC);
CREATE INDEX stack_moves_running_idx ON stack_moves (status) WHERE status = 'running';
