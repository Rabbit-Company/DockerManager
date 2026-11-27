CREATE TABLE metrics_raw (
	host_id bigint NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
	target text NOT NULL,
	ts bigint NOT NULL,
	cpu double precision,
	cpu_max double precision,
	mem double precision,
	mem_max double precision,
	mem_limit double precision,
	net_rx double precision,
	net_tx double precision,
	blk_read double precision,
	blk_write double precision,
	pids double precision,
	samples bigint NOT NULL DEFAULT 1,
	PRIMARY KEY (host_id, target, ts)
);
CREATE INDEX metrics_raw_ts_idx ON metrics_raw (ts);

CREATE TABLE metrics_1m (
	host_id bigint NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
	target text NOT NULL,
	ts bigint NOT NULL,
	cpu double precision,
	cpu_max double precision,
	mem double precision,
	mem_max double precision,
	mem_limit double precision,
	net_rx double precision,
	net_tx double precision,
	blk_read double precision,
	blk_write double precision,
	pids double precision,
	samples bigint NOT NULL DEFAULT 1,
	PRIMARY KEY (host_id, target, ts)
);
CREATE INDEX metrics_1m_ts_idx ON metrics_1m (ts);

CREATE TABLE metrics_1h (
	host_id bigint NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
	target text NOT NULL,
	ts bigint NOT NULL,
	cpu double precision,
	cpu_max double precision,
	mem double precision,
	mem_max double precision,
	mem_limit double precision,
	net_rx double precision,
	net_tx double precision,
	blk_read double precision,
	blk_write double precision,
	pids double precision,
	samples bigint NOT NULL DEFAULT 1,
	PRIMARY KEY (host_id, target, ts)
);
CREATE INDEX metrics_1h_ts_idx ON metrics_1h (ts);

CREATE TABLE metric_rollups (
	level text PRIMARY KEY,
	done_until bigint NOT NULL
);
