-- Rule set storage for STORAGE=d1. One row holds the whole JSON document.
CREATE TABLE IF NOT EXISTS ruleset (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
