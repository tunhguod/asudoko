-- 削除キーの時間制ロック。002 の後に1回だけ実行してください。
ALTER TABLE plans ADD COLUMN delete_lock_until TEXT;
