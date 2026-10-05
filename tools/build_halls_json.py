#!/usr/bin/env python3
"""ホールマスタ（CSV または conv.py が出力した halls.sql）から worker/halls.json を作る。
Worker に組み込んでホール検索をメモリ上で行うためのデータ（D1の読み込みを使わない）。
使い方: python3 tools/build_halls_json.py halls.sql worker/halls.json
"""
import csv, json, re, sys
from pathlib import Path

ROW_RE = re.compile(r"VALUES \('((?:[^']|'')*)','((?:[^']|'')*)',(-?[\d.]+),(-?[\d.]+),'((?:[^']|'')*)'\)")

def rows(src: Path):
    if src.suffix.lower() == ".csv":
        with src.open(encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                yield r["name"].strip(), r["address"].strip(), float(r["latitude"]), float(r["longitude"]), r["url"].strip()
    else:
        for line in src.read_text(encoding="utf-8").splitlines():
            m = ROW_RE.search(line)
            if m:
                n, a, lat, lng, u = m.groups()
                yield n.replace("''", "'"), a.replace("''", "'"), float(lat), float(lng), u.replace("''", "'")

def main():
    if len(sys.argv) != 3:
        print(__doc__); return 1
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    seen, out = set(), []
    for n, a, lat, lng, u in rows(src):
        if not u or u in seen: continue
        seen.add(u)
        out.append([n, a, round(lat, 7), round(lng, 7), u])
    dst.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Generated: {dst}  halls: {len(out)}  size: {dst.stat().st_size/1024:.0f} KB")

if __name__ == "__main__":
    raise SystemExit(main())
