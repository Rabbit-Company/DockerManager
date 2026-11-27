CREATE TABLE registry_credentials (
	id bigserial PRIMARY KEY,
	registry text NOT NULL UNIQUE,
	username text NOT NULL,
	secret text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE image_digests (
	registry text NOT NULL,
	repository text NOT NULL,
	tag text NOT NULL,
	digest text,
	error text,
	checked_at timestamptz NOT NULL,
	PRIMARY KEY (registry, repository, tag)
);

CREATE TABLE image_tags (
	registry text NOT NULL,
	repository text NOT NULL,
	tags text NOT NULL DEFAULT '',
	error text,
	checked_at timestamptz NOT NULL,
	PRIMARY KEY (registry, repository)
);

CREATE TABLE stack_services (
	stack_id bigint NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
	service text NOT NULL,
	policy text NOT NULL DEFAULT 'minor' CHECK (policy IN ('off', 'patch', 'minor', 'major')),
	auto text NOT NULL DEFAULT 'off' CHECK (auto IN ('off', 'patch', 'minor')),
	PRIMARY KEY (stack_id, service)
);
