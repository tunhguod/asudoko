-- 既存のD1（v2）を v3 にアップグレードする。1回だけ実行してください。
ALTER TABLE plans ADD COLUMN machine TEXT;
ALTER TABLE plans ADD COLUMN delete_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_halls_url ON halls(url);
CREATE INDEX IF NOT EXISTS idx_halls_latlng ON halls(latitude,longitude);
DROP INDEX IF EXISTS idx_plans_date;
CREATE INDEX IF NOT EXISTS idx_plans_date ON plans(play_date,hall_id);
