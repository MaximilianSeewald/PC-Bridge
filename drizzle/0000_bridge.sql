CREATE TABLE bridge_device (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_hash TEXT NOT NULL,
  last_seen INTEGER
);
--> statement-breakpoint
CREATE TABLE bridge_job (
  id TEXT PRIMARY KEY,
  device_hash TEXT NOT NULL,
  tool TEXT NOT NULL,
  challenge TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'done')),
  result TEXT
);
--> statement-breakpoint
CREATE INDEX bridge_job_queue ON bridge_job(device_hash, state, created_at);
