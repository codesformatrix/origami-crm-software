-- Optional AI draft request metering. Safe to run repeatedly.
CREATE TABLE IF NOT EXISTS ai_usage (
  usage_date TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0
);
