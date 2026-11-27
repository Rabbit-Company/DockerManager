ALTER TABLE stacks ADD COLUMN moved_to integer REFERENCES stacks (id) ON DELETE SET NULL;
