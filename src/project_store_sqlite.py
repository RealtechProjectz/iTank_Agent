"""Read-only access to the previous SQLite project file.

PostgreSQL is the active project store. This module only reads
``output/project_store.sqlite`` so ``migrate_sqlite_to_postgres`` can copy
sites that were saved before that change. It does not create or update the
SQLite file.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


def legacy_database_path(root: Path | None = None) -> Path:
    """Return the old SQLite file path. Nothing in the app writes this file."""
    base = Path(root) if root is not None else Path(__file__).resolve().parents[1]
    return base / "output" / "project_store.sqlite"


def list_site_ids(database_path: Path | None = None) -> list[str]:
    path = _existing_path(database_path)
    if path is None:
        return []
    connection = _connect(path)
    try:
        rows = connection.execute(
            "SELECT stable_id FROM site_project ORDER BY stable_id"
        ).fetchall()
        return [str(row["stable_id"]) for row in rows]
    finally:
        connection.close()


def load_project(
    site_stable_id: str,
    *,
    database_path: Path | None = None,
) -> dict[str, Any] | None:
    """Return one site from the old SQLite file, or None when it is absent."""
    site_stable_id = str(site_stable_id or "").strip()
    path = _existing_path(database_path)
    if not site_stable_id or path is None:
        return None
    connection = _connect(path)
    try:
        site_row = connection.execute(
            "SELECT stable_id, name FROM site_project WHERE stable_id = ?",
            (site_stable_id,),
        ).fetchone()
        if site_row is None:
            return None
        worksheets = []
        auxiliary: dict[str, Any] = {}
        worksheet_rows = connection.execute(
            """
            SELECT stable_id, legacy_id, name, selected_components_json,
                   selected_connections_json
            FROM worksheet
            WHERE site_stable_id = ?
            ORDER BY display_order, legacy_id
            """,
            (site_stable_id,),
        ).fetchall()
        worksheet_ids: list[str] = []
        for row in worksheet_rows:
            worksheet_ids.append(str(row["stable_id"]))
            legacy_id = int(row["legacy_id"])
            sheet = {
                "stable_id": str(row["stable_id"]),
                "id": legacy_id,
                "name": str(row["name"] or ""),
                "selected_components": _load_json(row["selected_components_json"], []),
                "selected_connections": _load_json(row["selected_connections_json"], []),
                "component_instances": _load_components(connection, str(row["stable_id"])),
                "connection_identities": _load_connections(connection, str(row["stable_id"])),
                "annotations": _load_annotations(connection, str(row["stable_id"])),
            }
            worksheets.append(sheet)
            routes = _load_routes(connection, str(row["stable_id"]))
            if routes:
                auxiliary[f"manual_connection_overrides_{legacy_id}"] = routes
        return {
            "site_project": {
                "stable_id": str(site_row["stable_id"]),
                "name": str(site_row["name"] or "Site"),
                "worksheet_stable_ids": worksheet_ids,
            },
            "worksheets": worksheets,
            "auxiliary_state": auxiliary,
        }
    finally:
        connection.close()


def _existing_path(database_path: Path | None) -> Path | None:
    path = Path(database_path) if database_path is not None else legacy_database_path()
    if not path.is_file():
        return None
    return path


def _connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def _load_components(connection: sqlite3.Connection, worksheet_id: str) -> list[dict]:
    rows = connection.execute(
        """
        SELECT stable_id, catalog_name, legacy_node_id, instance_index, node_type, code
        FROM component_instance
        WHERE worksheet_stable_id = ?
        ORDER BY position, stable_id
        """,
        (worksheet_id,),
    ).fetchall()
    return [
        {
            "stable_id": str(row["stable_id"]),
            "catalog_name": str(row["catalog_name"] or ""),
            "legacy_node_id": str(row["legacy_node_id"] or ""),
            "instance_index": int(row["instance_index"] or 1),
            "node_type": str(row["node_type"] or ""),
            "code": str(row["code"] or ""),
        }
        for row in rows
    ]


def _load_connections(connection: sqlite3.Connection, worksheet_id: str) -> list[dict]:
    rows = connection.execute(
        """
        SELECT stable_id, legacy_id, source_stable_id, target_stable_id,
               source_node_id, target_node_id, relation
        FROM connection_identity
        WHERE worksheet_stable_id = ?
        ORDER BY position, legacy_id
        """,
        (worksheet_id,),
    ).fetchall()
    return [
        {
            "stable_id": str(row["stable_id"]),
            "legacy_id": str(row["legacy_id"] or ""),
            "source_stable_id": str(row["source_stable_id"] or ""),
            "target_stable_id": str(row["target_stable_id"] or ""),
            "source_node_id": str(row["source_node_id"] or ""),
            "target_node_id": str(row["target_node_id"] or ""),
            "relation": str(row["relation"] or "to"),
        }
        for row in rows
    ]


def _load_routes(connection: sqlite3.Connection, worksheet_id: str) -> dict[str, Any]:
    rows = connection.execute(
        """
        SELECT legacy_edge_id, points_json
        FROM route_geometry
        WHERE worksheet_stable_id = ?
        ORDER BY legacy_edge_id
        """,
        (worksheet_id,),
    ).fetchall()
    routes: dict[str, Any] = {}
    for row in rows:
        value = _load_json(row["points_json"], {})
        if isinstance(value, dict):
            routes[str(row["legacy_edge_id"])] = value
    return routes


def _load_annotations(connection: sqlite3.Connection, worksheet_id: str) -> list[dict]:
    rows = connection.execute(
        """
        SELECT payload_json
        FROM annotation
        WHERE worksheet_stable_id = ?
        ORDER BY position, legacy_note_id
        """,
        (worksheet_id,),
    ).fetchall()
    notes = []
    for row in rows:
        payload = _load_json(row["payload_json"], {})
        if isinstance(payload, dict):
            notes.append(payload)
    return notes


def _load_json(value: str, fallback: Any) -> Any:
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback
