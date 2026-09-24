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
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_activity (
            id TEXT PRIMARY KEY,
            mode TEXT NOT NULL,
            query TEXT NOT NULL,
            selected_tool TEXT,
            total_time_ms REAL DEFAULT 0,
            total_cost REAL DEFAULT 0,
            total_input_tokens INTEGER DEFAULT 0,
            total_output_tokens INTEGER DEFAULT 0,
            decision_latency_ms REAL DEFAULT 0,
            decision_cost REAL DEFAULT 0,
            created_at TEXT
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


def save_agent_activity(activity: dict) -> None:
    conn = get_connection()
    conn.execute(
        """
        INSERT INTO agent_activity (
            id, mode, query, selected_tool, total_time_ms, total_cost,
            total_input_tokens, total_output_tokens, decision_latency_ms,
            decision_cost, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        """,
        (
            activity["id"], activity["mode"], activity["query"],
            activity.get("selected_tool"), activity.get("total_time_ms", 0),
            activity.get("total_cost", 0), activity.get("total_input_tokens", 0),
            activity.get("total_output_tokens", 0), activity.get("decision_latency_ms", 0),
            activity.get("decision_cost", 0),
        ),
    )
    conn.commit()
    conn.close()


def list_agent_activity() -> list[dict]:
    conn = get_connection()
    rows = conn.execute("SELECT * FROM agent_activity ORDER BY created_at DESC").fetchall()
    conn.close()
    return [dict(row) for row in rows]


def clear_agent_activity() -> int:
    conn = get_connection()
    cursor = conn.execute("DELETE FROM agent_activity")
    conn.commit()
    removed = cursor.rowcount
    conn.close()
    return removed
