"""Sums up the orders of a JSON export (an example for the syntax coloring)."""

import json
from pathlib import Path


def total(path: Path) -> float:
    data = json.loads(path.read_text(encoding="utf-8"))
    amount = 0.0
    for order in data["orders"]:
        if order.get("paid"):
            amount += sum(item["qty"] * item["price"] for item in order["items"])
    return round(amount, 2)


if __name__ == "__main__":
    print(f"Paid orders: {total(Path('minified.json'))} EUR")
