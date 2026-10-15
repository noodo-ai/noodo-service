CREATE TABLE resource_categories (
  id TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(ownerId, name)
);
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
  categoryId TEXT REFERENCES resource_categories(id) ON DELETE SET NULL,
  topic TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX resources_owner ON resources(ownerId, updatedAt);
CREATE INDEX resources_public ON resources(visibility, updatedAt);
CREATE TABLE resource_files (
  id TEXT PRIMARY KEY,
  resourceId TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content BLOB NOT NULL
);
CREATE INDEX resource_files_parent ON resource_files(resourceId);
CREATE TABLE resource_views (
  resourceId TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  viewerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewedAt INTEGER NOT NULL,
  PRIMARY KEY(resourceId, viewerId)
);
CREATE INDEX resource_views_recent ON resource_views(viewedAt, resourceId);
INSERT INTO schema_migrations VALUES(4);
