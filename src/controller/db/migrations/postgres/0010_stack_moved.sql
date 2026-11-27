ALTER TABLE stacks ADD COLUMN moved_to bigint REFERENCES stacks (id) ON DELETE SET NULL;
