"""從 stock.db 匯出加權指數（TAIEX）日線資料，產生網頁使用的 data/taiex_data.js。

用法：
    py tools/export_taiex.py <stock.db 路徑>

例如：
    py tools/export_taiex.py ../stock/stock.db

資料格式為 [日期, 開, 高, 低, 收] 的陣列。輸出成 .js（而非 .json），
是為了讓瀏覽器直接以 file:// 開啟 index.html 時也能載入資料。
"""

import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path

OUTPUT = Path(__file__).resolve().parent.parent / "data" / "taiex_data.js"


def load_rows(db_path: Path) -> list[list]:
    # 以唯讀模式開啟，避免誤改資料庫
    uri = f"{db_path.resolve().as_uri()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        cur = conn.execute(
            "SELECT id, open, high, low, close FROM TAIEX "
            "WHERE close IS NOT NULL AND close > 0 ORDER BY id"
        )
        rows = []
        for date_id, o, h, l, c in cur:
            date = datetime.strptime(str(date_id), "%Y%m%d").strftime("%Y-%m-%d")
            rows.append([date, round(o, 2), round(h, 2), round(l, 2), round(c, 2)])
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="匯出 TAIEX 日線資料給網頁使用")
    parser.add_argument("db", type=Path, help="stock.db 的路徑")
    args = parser.parse_args()

    if not args.db.is_file():
        parser.error(f"找不到資料庫：{args.db}")

    rows = load_rows(args.db)
    if not rows:
        parser.error("TAIEX 資料表沒有資料")

    payload = {
        "symbol": "TAIEX",
        "name": "臺灣加權股價指數",
        "source": "臺灣證券交易所",
        "generated": datetime.now().strftime("%Y-%m-%d"),
        "fields": ["date", "open", "high", "low", "close"],
        "bars": rows,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    OUTPUT.write_text(
        "// 由 tools/export_taiex.py 自動產生，請勿手動修改\n"
        f"window.TAIEX_DATA = {body};\n",
        encoding="utf-8",
    )
    print(f"已匯出 {len(rows)} 筆（{rows[0][0]} ~ {rows[-1][0]}）→ {OUTPUT}")


if __name__ == "__main__":
    main()
