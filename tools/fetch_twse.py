"""從臺灣證券交易所網站抓取加權指數日線，產生網頁使用的 data/taiex_data.js。

資料來源：證交所「發行量加權股價指數歷史資料」
https://www.twse.com.tw/zh/indices/taiex/mi-5min-hist.html

用法：
    # 補抓最新資料（從現有資料的最後一個月抓到本月）
    py tools/fetch_twse.py

    # 指定起訖月份重新抓取，並只保留到指定日期
    py tools/fetch_twse.py --start 2016-01 --end 2026-10 --until 2026-10-19

證交所會封鎖請求過於頻繁的 IP，每次請求之間預設間隔 3.5 秒，請勿調得太短。
"""

import argparse
import json
import re
import sys
import time
import urllib.request
from datetime import date, datetime
from pathlib import Path

OUTPUT = Path(__file__).resolve().parent.parent / "data" / "taiex_data.js"
API = "https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?response=json&date={yyyymm}01"
HEADERS = {"User-Agent": "Mozilla/5.0 (taiex-macd-game data updater)", "Accept": "application/json"}


def parse_month(text: str) -> date:
    if not re.fullmatch(r"\d{4}-\d{2}", text):
        raise argparse.ArgumentTypeError("月份格式須為 YYYY-MM")
    return datetime.strptime(text, "%Y-%m").date()


def parse_day(text: str) -> date:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        raise argparse.ArgumentTypeError("日期格式須為 YYYY-MM-DD")
    return datetime.strptime(text, "%Y-%m-%d").date()


def months(start: date, end: date):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def to_float(text: str) -> float:
    return round(float(text.replace(",", "")), 2)


def fetch_month(y: int, m: int) -> list[list]:
    url = API.format(yyyymm=f"{y}{m:02d}")
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("stat") != "OK":
        # 該月尚無資料（例如未來月份）時回傳空陣列
        return []
    rows = []
    for roc_date, o, h, l, c in payload["data"]:
        ry, rm, rd = (int(x) for x in roc_date.split("/"))
        day = date(ry + 1911, rm, rd).isoformat()
        o, h, l, c = (to_float(v) for v in (o, h, l, c))
        if not (h >= max(o, c) and l <= min(o, c) and l > 0):
            raise ValueError(f"{day} 的開高低收不合理：{o} {h} {l} {c}")
        rows.append([day, o, h, l, c])
    return rows


def load_existing() -> list[list]:
    if not OUTPUT.is_file():
        return []
    text = OUTPUT.read_text(encoding="utf-8")
    return json.loads(text[text.index("{"): text.rindex("}") + 1])["bars"]


def write_output(rows: list[list]) -> None:
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
        "// 由 tools/fetch_twse.py 自動產生，請勿手動修改\n"
        f"window.TAIEX_DATA = {body};\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="從證交所抓取加權指數日線給網頁使用")
    parser.add_argument("--start", type=parse_month, help="起始月份 YYYY-MM（預設：現有資料的最後一個月）")
    parser.add_argument("--end", type=parse_month, default=date.today().replace(day=1), help="結束月份 YYYY-MM（預設：本月）")
    parser.add_argument("--until", type=parse_day, help="只保留到此日期 YYYY-MM-DD")
    parser.add_argument("--replace", action="store_true", help="捨棄現有資料，只保留這次抓到的範圍")
    parser.add_argument("--delay", type=float, default=3.5, help="每次請求間隔秒數（預設 3.5，最少 2）")
    args = parser.parse_args()

    existing = [] if args.replace else load_existing()
    start = args.start
    if start is None:
        if not existing:
            parser.error("目前沒有資料，請用 --start 指定起始月份")
        start = parse_month(existing[-1][0][:7])
    if start > args.end:
        parser.error("起始月份不能晚於結束月份")
    delay = max(args.delay, 2.0)

    merged = {row[0]: row for row in existing}
    todo = list(months(start, args.end))
    for n, (y, m) in enumerate(todo, 1):
        rows = fetch_month(y, m)
        for row in rows:
            merged[row[0]] = row
        print(f"[{n}/{len(todo)}] {y}-{m:02d}：{len(rows)} 筆", flush=True)
        if n < len(todo):
            time.sleep(delay)

    result = [merged[d] for d in sorted(merged)]
    if args.until:
        result = [row for row in result if row[0] <= args.until.isoformat()]
    if not result:
        sys.exit("沒有取得任何資料")
    write_output(result)
    print(f"已寫入 {len(result)} 筆（{result[0][0]} ~ {result[-1][0]}）→ {OUTPUT}")


if __name__ == "__main__":
    main()
