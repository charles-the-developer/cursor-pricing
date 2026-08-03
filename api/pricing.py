"""Vercel serverless function -- GET /api/pricing.

Mirrors server.py's scraping logic. Kept self-contained (no imports from the
repo root) because Vercel's Python builder only reliably bundles the file
under api/ itself -- see server.py for the local-dev equivalent and keep the
two in sync if you change WANTED_MODELS or the parsing logic.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

PRICING_MD_URL = "https://cursor.com/docs/models-and-pricing.md"
PRICING_PAGE_URL = "https://cursor.com/docs/models-and-pricing"

WANTED_MODELS = [
    "Composer 2.5",
    "GPT-5.3 Codex",
    "Grok 4.5",
    "Kimi K2.7 Code",
    "GPT-5.6 Sol",
    "GPT-5.6 Terra",
    "GPT-5.6 Luna",
    "Claude Opus 5",
    "Claude Sonnet 5",
]

# Composer 2.5 and Grok 4.5 are Cursor's own "Cursor Models" pool. Their pricing
# renders through a client-side component on the docs page's "Grok 4.5 pricing"
# / "Composer pricing" sections and never appears in the "### Model pricing"
# markdown table parsed below, so it can't be scraped. Values captured by hand
# on 2026-08-03 -- if they look off, recheck them at PRICING_PAGE_URL.
CURSOR_MODELS_POOL_PRICING = {
    "Composer 2.5": {"input": 0.5, "cache_write": None, "cache_read": 0.2, "output": 2.5},
    "Grok 4.5": {"input": 2.0, "cache_write": None, "cache_read": 0.5, "output": 6.0},
}

MODEL_ALIASES: dict[str, str] = {}


def tokenize(name: str) -> tuple[str, ...]:
    return tuple(sorted(re.findall(r"[a-z]+|\d+\.?\d*", name.lower())))


def extract_model_name(cell: str) -> str:
    link_match = re.match(r"\[([^\]]+)\]", cell.strip())
    return link_match.group(1) if link_match else cell.strip()


def parse_price(value: str | None) -> float | None:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned or cleaned == "-":
        return None
    return float(cleaned.lstrip("$"))


def fetch_pricing_markdown() -> str:
    request = urllib.request.Request(
        PRICING_MD_URL,
        headers={"User-Agent": "cursor-pricing/1.0"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read().decode("utf-8")


def parse_pricing_table(markdown: str) -> list[dict]:
    lines = markdown.splitlines()
    start = next(
        (index for index, line in enumerate(lines) if line.strip() == "### Model pricing"),
        None,
    )
    if start is None:
        raise ValueError("Model pricing table not found on Cursor docs page")

    rows: list[dict] = []
    in_table = False

    for line in lines[start + 1 :]:
        if line.startswith("## "):
            break
        if not line.startswith("|"):
            if in_table:
                break
            continue

        cells = [cell.strip() for cell in line.split("|")[1:-1]]
        if len(cells) < 6:
            continue

        if cells[0].startswith(":") or cells[0] == "Model":
            in_table = True
            continue

        if re.fullmatch(r"-+", cells[0].replace(" ", "")):
            continue

        raw_name = extract_model_name(cells[0])
        variant = None
        if re.search(r"\(fast mode\)", raw_name, re.I):
            variant = "Fast"
            raw_name = re.sub(r"\s*\(fast mode\)\s*", "", raw_name, flags=re.I).strip()

        note = cells[6].strip() if len(cells) > 6 else None
        if note:
            note = note.replace("\\`", "`")

        rows.append(
            {
                "name": raw_name,
                "variant": variant,
                "input": parse_price(cells[2]),
                "cache_write": parse_price(cells[3]),
                "cache_read": parse_price(cells[4]),
                "output": parse_price(cells[5]),
                "note": note or None,
                "_tokens": tokenize(raw_name),
            }
        )

    if not rows:
        raise ValueError("No model rows parsed from pricing table")

    return rows


def find_model(wanted: str, rows: list[dict]) -> dict | None:
    alias = MODEL_ALIASES.get(wanted, wanted)
    wanted_tokens = tokenize(alias)

    for row in rows:
        if row["name"] == alias or row["name"] == wanted:
            return row

    for row in rows:
        if row["_tokens"] == wanted_tokens:
            return row

    for row in rows:
        if row["name"].lower() == wanted.lower() or row["name"].lower() == alias.lower():
            return row

    return None


def build_response() -> list[dict]:
    markdown = fetch_pricing_markdown()
    rows = parse_pricing_table(markdown)
    result: list[dict] = []

    for wanted in WANTED_MODELS:
        override = CURSOR_MODELS_POOL_PRICING.get(wanted)
        if override:
            result.append(
                {
                    "name": wanted,
                    "variant": None,
                    **override,
                    "note": f"Not in Cursor's scrapable pricing table (Cursor Models pool) -- verify at {PRICING_PAGE_URL}",
                }
            )
            continue

        match = find_model(wanted, rows)
        if match:
            result.append(
                {
                    "name": wanted,
                    "variant": match["variant"],
                    "input": match["input"],
                    "cache_write": match["cache_write"],
                    "cache_read": match["cache_read"],
                    "output": match["output"],
                    "note": match["note"],
                }
            )
        else:
            result.append(
                {
                    "name": wanted,
                    "variant": None,
                    "input": None,
                    "cache_write": None,
                    "cache_read": None,
                    "output": None,
                    "note": "not found on pricing page",
                }
            )

    return result


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        try:
            payload = build_response()
            self._send_json(200, payload)
        except urllib.error.URLError as exc:
            self._send_json(502, {"error": f"Could not reach Cursor docs: {exc.reason}"})
        except Exception as exc:  # noqa: BLE001 -- surface any scrape failure to the client
            self._send_json(500, {"error": str(exc)})

    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A002 -- match BaseHTTPRequestHandler signature
        print(f"[{self.log_date_time_string()}] {format % args}")
