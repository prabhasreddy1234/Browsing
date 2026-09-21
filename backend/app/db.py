from __future__ import annotations

import json
import sqlite3
from typing import Optional

from .config import DATABASE_PATH


def get_connection() -> sqlite3.Connection:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_connection()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS benchmark_runs (
            id TEXT PRIMARY KEY,
            run_name TEXT,
            created_at TEXT,
            config TEXT,
            summary TEXT,
            results TEXT
        )
        """
    )
    conn.commit()
    conn.close()


def save_run(run_id: str, run_name: str, config: dict, summary: dict, results: list[dict]) -> None:
    conn = get_connection()
    conn.execute(
        """
        INSERT INTO benchmark_runs (id, run_name, created_at, config, summary, results)
        VALUES (?, ?, datetime('now'), ?, ?, ?)
        """,
        (
            run_id,
            run_name,
            json.dumps(config),
            json.dumps(summary),
            json.dumps(results),
        ),
    )
    conn.commit()
    conn.close()


def list_runs() -> list[dict]:
    conn = get_connection()
    rows = conn.execute(
        "SELECT id, run_name, created_at, config, summary, results FROM benchmark_runs ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_latest_run() -> Optional[dict]:
    rows = list_runs()
    return rows[0] if rows else None


def clear_runs() -> int:
    """Delete all stored benchmark runs. Returns how many were removed."""
    conn = get_connection()
    cursor = conn.execute("DELETE FROM benchmark_runs")
    conn.commit()
    removed = cursor.rowcount
    conn.close()
    return removed
