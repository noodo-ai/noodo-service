CREATE TABLE IF NOT EXISTS trends_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL
);
INSERT INTO schema_migrations(version) VALUES(5);
