ALTER TABLE conversations ADD COLUMN deletedAt INTEGER;
INSERT INTO schema_migrations VALUES(3);
