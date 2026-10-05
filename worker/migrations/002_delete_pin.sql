-- 削除キー（ユーザーが決めるパスワード）対応。001_v3.sql の後に1回だけ実行してください。
ALTER TABLE plans ADD COLUMN delete_pin TEXT;
ALTER TABLE plans ADD COLUMN delete_fail INTEGER NOT NULL DEFAULT 0;
