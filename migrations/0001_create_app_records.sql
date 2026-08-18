CREATE TABLE IF NOT EXISTS app_records (
  collection TEXT NOT NULL CHECK (collection IN ('toys', 'clients', 'quotes', 'settings')),
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS idx_app_records_collection
  ON app_records (collection, updated_at);
