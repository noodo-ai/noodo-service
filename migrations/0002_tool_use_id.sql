ALTER TABLE tool_calls ADD COLUMN providerToolUseId TEXT NOT NULL DEFAULT '';
INSERT INTO schema_migrations VALUES(2);
