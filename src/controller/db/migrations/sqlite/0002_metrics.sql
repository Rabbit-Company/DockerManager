CREATE TABLE metrics_raw (
	host_id integer NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
	target text NOT NULL,
	ts integer NOT NULL,
	cpu real,
	cpu_max real,
	mem real,
	mem_max real,
	mem_limit real,
	net_rx real,
	net_tx real,
	blk_read real,
	blk_write real,
	pids real,
	samples integer NOT NULL DEFAULT 1,
	PRIMARY KEY (host_id, target, ts)
) WITHOUT ROWID;
CREATE INDEX metrics_raw_ts_idx ON metrics_raw (ts);

CREATE TABLE metrics_1m (
	host_id integer NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
	target text NOT NULL,
	ts integer NOT NULL,
	cpu real,
	cpu_max real,
	mem real,
	mem_max real,
	mem_limit real,
	net_rx real,
	net_tx real,
	blk_read real,
	blk_write real,
	pids real,
	samples integer NOT NULL DEFAULT 1,
	PRIMARY KEY (host_id, target, ts)
) WITHOUT ROWID;
CREATE INDEX metrics_1m_ts_idx ON metrics_1m (ts);

CREATE TABLE metrics_1h (
	host_id integer NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
	target text NOT NULL,
	ts integer NOT NULL,
	cpu real,
	cpu_max real,
	mem real,
	mem_max real,
	mem_limit real,
	net_rx real,
	net_tx real,
	blk_read real,
	blk_write real,
	pids real,
	samples integer NOT NULL DEFAULT 1,
	PRIMARY KEY (host_id, target, ts)
) WITHOUT ROWID;
CREATE INDEX metrics_1h_ts_idx ON metrics_1h (ts);

CREATE TABLE metric_rollups (
	level text PRIMARY KEY,
	done_until integer NOT NULL
);
