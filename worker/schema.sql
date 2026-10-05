-- 新規構築用スキーマ（既存DBには migrations/ を適用してください）
CREATE TABLE IF NOT EXISTS halls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  url TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_halls_url ON halls(url);
CREATE INDEX IF NOT EXISTS idx_halls_name ON halls(name);
CREATE INDEX IF NOT EXISTS idx_halls_address ON halls(address);
CREATE INDEX IF NOT EXISTS idx_halls_latlng ON halls(latitude,longitude);

CREATE TABLE IF NOT EXISTS plans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  play_date TEXT NOT NULL,
  hall_id INTEGER NOT NULL,
  nickname TEXT,
  comment TEXT,
  machine TEXT,
  delete_key TEXT,   -- 投稿したブラウザ用の自動キー（ハッシュ）
  delete_pin TEXT,   -- ユーザーが決めた削除キー（ハッシュ）
  delete_fail INTEGER NOT NULL DEFAULT 0,
  delete_lock_until TEXT, -- 削除キーを連続で間違えたときのロック期限（UTC）
  created_at TEXT NOT NULL,
  FOREIGN KEY(hall_id) REFERENCES halls(id)
);
CREATE INDEX IF NOT EXISTS idx_plans_date ON plans(play_date,hall_id);
