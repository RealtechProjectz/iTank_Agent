"""PostgreSQL persistence for one site and its worksheets.

Session state remains the live editor. The PPT pickle sidecar remains the
file the SAVED list reopens. This module writes the same project snapshot to
PostgreSQL after that file is in place, and can read it back. It does not
draw routes, build a PPT, or replace ``sump_1`` / ``rule_N__...`` ids.

Connection settings come from the environment. A missing driver, a missing
setting, or a database error is raised to the caller. The PPT save catches
that error and leaves the pickle it already wrote unchanged.

The previous SQLite file is not opened here. ``migrate_sqlite_to_postgres``
copies it when someone runs that function on purpose.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from .stable_identity import parse_legacy_connection_id

_SCHEMA_VERSION = 1
_ANNOTATION_NAMESPACE = uuid.UUID("6f0c1a4e-9b3d-4f2a-8c71-0e5d9a2b7c44")
_ROUTE_NAMESPACE = uuid.UUID("c4a1e8d2-7b56-4e19-9f30-2d8a6b5c1e77")
_CANVAS_STATE_NOTE_ID = "__itank_canvas_state_v1__"
_CANVAS_STATE_AUXILIARY_KEYS = (
    "manual_component_overrides",
    "manual_connection_overrides",
    "deleted_connection_ids",
    "deleted_connection_pairs",
    "_canvas_live_components",
    "_last_worksheet_geometry",
    "_freeze_canvas_size",
    "_manual_draw_pairs",
    "oht_sensor_embeds",
    "_worksheet_viewport",
    "worksheet_viewport",
    "worksheet_canvas_view",
)
_SCHEMA_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_COMPONENT_IDENTITY_KEYS = (
    "stable_id",
    "catalog_name",
    "legacy_node_id",
    "instance_index",
    "node_type",
    "code",
)
_CONNECTION_IDENTITY_KEYS = (
    "stable_id",
    "legacy_id",
    "source_stable_id",
    "target_stable_id",
    "source_node_id",
    "target_node_id",
    "relation",
)

_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS schema_meta (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS site_project (
        stable_id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS worksheet (
        stable_id UUID PRIMARY KEY,
        site_project_id UUID NOT NULL REFERENCES site_project (stable_id) ON DELETE CASCADE,
        worksheet_number INTEGER NOT NULL,
        name TEXT NOT NULL,
        display_order INTEGER NOT NULL,
        selected_components JSONB NOT NULL,
        selected_connections JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS component_instance (
        stable_id UUID PRIMARY KEY,
        worksheet_id UUID NOT NULL REFERENCES worksheet (stable_id) ON DELETE CASCADE,
        legacy_node_id TEXT NOT NULL,
        catalog_name TEXT NOT NULL,
        component_type TEXT NOT NULL,
        instance_index INTEGER NOT NULL,
        code TEXT NOT NULL DEFAULT '',
        display_order INTEGER NOT NULL,
        position_x DOUBLE PRECISION,
        position_y DOUBLE PRECISION,
        box_x DOUBLE PRECISION,
        box_y DOUBLE PRECISION,
        box_width DOUBLE PRECISION,
        box_height DOUBLE PRECISION
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS connection_identity (
        stable_id UUID PRIMARY KEY,
        worksheet_id UUID NOT NULL REFERENCES worksheet (stable_id) ON DELETE CASCADE,
        source_component_id UUID NOT NULL REFERENCES component_instance (stable_id) ON DELETE CASCADE,
        target_component_id UUID NOT NULL REFERENCES component_instance (stable_id) ON DELETE CASCADE,
        legacy_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL DEFAULT '',
        target_node_id TEXT NOT NULL DEFAULT '',
        relation TEXT NOT NULL DEFAULT 'to',
        rule_identity TEXT NOT NULL DEFAULT '',
        rule_label TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL DEFAULT '',
        direction TEXT NOT NULL DEFAULT '',
        display_order INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS route_geometry (
        stable_id UUID PRIMARY KEY,
        worksheet_id UUID NOT NULL REFERENCES worksheet (stable_id) ON DELETE CASCADE,
        connection_id UUID REFERENCES connection_identity (stable_id) ON DELETE CASCADE,
        legacy_edge_id TEXT NOT NULL,
        points JSONB NOT NULL,
        mode TEXT NOT NULL DEFAULT '',
        hidden BOOLEAN NOT NULL DEFAULT FALSE,
        arrow_direction TEXT NOT NULL DEFAULT '',
        override_json JSONB NOT NULL,
        manual_override_information BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (worksheet_id, legacy_edge_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS annotation (
        stable_id UUID PRIMARY KEY,
        worksheet_id UUID NOT NULL REFERENCES worksheet (stable_id) ON DELETE CASCADE,
        legacy_note_id TEXT NOT NULL,
        display_order INTEGER NOT NULL,
        payload JSONB NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS worksheet_site_project_id_idx ON worksheet (site_project_id)",
    "CREATE INDEX IF NOT EXISTS component_instance_worksheet_id_idx ON component_instance (worksheet_id)",
    "CREATE INDEX IF NOT EXISTS component_instance_legacy_node_idx ON component_instance (worksheet_id, legacy_node_id)",
    "CREATE INDEX IF NOT EXISTS connection_identity_worksheet_id_idx ON connection_identity (worksheet_id)",
    "CREATE INDEX IF NOT EXISTS connection_identity_source_idx ON connection_identity (source_component_id)",
    "CREATE INDEX IF NOT EXISTS connection_identity_target_idx ON connection_identity (target_component_id)",
    "CREATE INDEX IF NOT EXISTS route_geometry_worksheet_id_idx ON route_geometry (worksheet_id)",
    "CREATE INDEX IF NOT EXISTS route_geometry_connection_id_idx ON route_geometry (connection_id)",
    "CREATE INDEX IF NOT EXISTS annotation_worksheet_id_idx ON annotation (worksheet_id)",
)


class ProjectStoreConfigError(RuntimeError):
    """PostgreSQL settings or driver are missing. The message has no password."""


class ProjectStoreError(RuntimeError):
    """A PostgreSQL read or write failed. The message has no password."""


def connection_dsn(dsn: str | None = None) -> str:
    """Build a libpq connection string from the environment.

    ``ITANK_POSTGRES_DSN`` wins when it is set. Otherwise host, database, and
    user are required. The password may be empty for local trust authentication.
    """
    if isinstance(dsn, str) and dsn.strip():
        return dsn.strip()
    _load_local_env()
    explicit = os.environ.get("ITANK_POSTGRES_DSN", "").strip()
    if explicit:
        return explicit
    host = os.environ.get("ITANK_POSTGRES_HOST", "").strip()
    database = os.environ.get("ITANK_POSTGRES_DB", "").strip()
    user = os.environ.get("ITANK_POSTGRES_USER", "").strip()
    if not host or not database or not user:
        raise ProjectStoreConfigError(
            "PostgreSQL is not configured. Set ITANK_POSTGRES_DSN, or set "
            "ITANK_POSTGRES_HOST, ITANK_POSTGRES_DB, and ITANK_POSTGRES_USER. "
            "ITANK_POSTGRES_PASSWORD, ITANK_POSTGRES_PORT, and "
            "ITANK_POSTGRES_SSLMODE are optional."
        )
    try:
        from psycopg.conninfo import make_conninfo
    except ImportError as exc:
        raise ProjectStoreConfigError(
            "PostgreSQL driver psycopg is not installed."
        ) from exc
    password = os.environ.get("ITANK_POSTGRES_PASSWORD", "")
    port = os.environ.get("ITANK_POSTGRES_PORT", "5432").strip() or "5432"
    settings = {
        "host": host,
        "port": port,
        "dbname": database,
        "user": user,
        "password": password,
        "connect_timeout": "5",
    }
    sslmode = os.environ.get("ITANK_POSTGRES_SSLMODE", "").strip()
    if sslmode:
        settings["sslmode"] = sslmode
    return make_conninfo(**settings)


def describe_connection(dsn: str | None = None) -> str:
    """Return the host and database name. The password is not included."""
    try:
        from psycopg.conninfo import conninfo_to_dict
    except ImportError as exc:
        raise ProjectStoreConfigError(
            "PostgreSQL driver psycopg is not installed."
        ) from exc
    info = conninfo_to_dict(connection_dsn(dsn))
    host = info.get("host") or "localhost"
    database = info.get("dbname") or ""
    return f"{host}/{database}"


def save_project(snapshot: dict[str, Any], *, dsn: str | None = None) -> str:
    """Store one site snapshot.

    Each connection and route is inserted or updated by its own stable id.
    Other connection rows on the same worksheet are left in place. Diagram
    images and PPT bytes are not stored.
    """
    site = _site_record(snapshot)
    if site is None:
        return ""
    worksheets = [
        sheet
        for sheet in list(snapshot.get("worksheets") or [])
        if isinstance(sheet, dict) and _uuid_text(sheet.get("stable_id"))
    ]
    auxiliary = snapshot.get("auxiliary_state")
    if not isinstance(auxiliary, dict):
        auxiliary = {}
    connection = None
    try:
        connection = _connect(dsn)
        with connection:
            _ensure_schema(connection)
            site_id = _uuid_text(site["stable_id"])
            connection.execute(
                """
                INSERT INTO site_project (stable_id, name)
                VALUES (%s::uuid, %s)
                ON CONFLICT (stable_id) DO UPDATE
                SET name = EXCLUDED.name, updated_at = NOW()
                """,
                (site_id, site["name"]),
            )
            _delete_removed_worksheets(connection, site_id, worksheets)
            for order, sheet in enumerate(worksheets):
                _insert_worksheet(connection, site_id, order, sheet, auxiliary)
        return site_id or ""
    except (ProjectStoreConfigError, ProjectStoreError):
        raise
    except Exception as exc:
        raise ProjectStoreError(_safe_error_text(exc)) from None
    finally:
        if connection is not None:
            connection.close()


def delete_site_project(site_stable_id: str, *, dsn: str | None = None) -> bool:
    """Delete one saved site and the rows that belong only to it.

    Worksheets, component instances, connection identities, route geometries,
    and annotations for that stable id are removed first, then the site row.
    Other projects are not updated.
    """
    site_stable_id = _uuid_text(site_stable_id) or ""
    if not site_stable_id:
        return False
    connection = None
    try:
        connection = _connect(dsn)
        with connection:
            _ensure_schema(connection)
            existing = connection.execute(
                """
                SELECT stable_id
                FROM site_project
                WHERE stable_id = %s::uuid
                """,
                (site_stable_id,),
            ).fetchone()
            if existing is None:
                return False
            worksheet_ids = """
                SELECT stable_id
                FROM worksheet
                WHERE site_project_id = %s::uuid
            """
            connection.execute(
                f"DELETE FROM route_geometry WHERE worksheet_id IN ({worksheet_ids})",
                (site_stable_id,),
            )
            connection.execute(
                f"DELETE FROM connection_identity WHERE worksheet_id IN ({worksheet_ids})",
                (site_stable_id,),
            )
            connection.execute(
                f"DELETE FROM annotation WHERE worksheet_id IN ({worksheet_ids})",
                (site_stable_id,),
            )
            connection.execute(
                f"DELETE FROM component_instance WHERE worksheet_id IN ({worksheet_ids})",
                (site_stable_id,),
            )
            connection.execute(
                "DELETE FROM worksheet WHERE site_project_id = %s::uuid",
                (site_stable_id,),
            )
            connection.execute(
                "DELETE FROM site_project WHERE stable_id = %s::uuid",
                (site_stable_id,),
            )
        return True
    except (ProjectStoreConfigError, ProjectStoreError):
        raise
    except Exception as exc:
        raise ProjectStoreError(_safe_error_text(exc)) from None
    finally:
        if connection is not None:
            connection.close()


def load_project(
    site_stable_id: str,
    *,
    dsn: str | None = None,
) -> dict[str, Any] | None:
    """Return one stored site hierarchy, or None when that site is absent."""
    site_stable_id = _uuid_text(site_stable_id) or ""
    if not site_stable_id:
        return None
    connection = None
    try:
        connection = _connect(dsn)
        with connection:
            _ensure_schema(connection)
            site_row = connection.execute(
                """
                SELECT stable_id, name, created_at, updated_at
                FROM site_project
                WHERE stable_id = %s::uuid
                """,
                (site_stable_id,),
            ).fetchone()
            if site_row is None:
                return None
            worksheets = []
            auxiliary: dict[str, Any] = {}
            worksheet_rows = connection.execute(
                """
                SELECT stable_id, worksheet_number, name, created_at, updated_at,
                       selected_components, selected_connections
                FROM worksheet
                WHERE site_project_id = %s::uuid
                ORDER BY display_order, worksheet_number
                """,
                (site_stable_id,),
            ).fetchall()
            worksheet_ids: list[str] = []
            for row in worksheet_rows:
                worksheet_id = str(row["stable_id"])
                worksheet_ids.append(worksheet_id)
                legacy_id = int(row["worksheet_number"])
                components = _load_components(connection, worksheet_id)
                sheet = {
                    "stable_id": worksheet_id,
                    "id": legacy_id,
                    "name": str(row["name"] or ""),
                    "created_at": _timestamp_text(row["created_at"]),
                    "updated_at": _timestamp_text(row["updated_at"]),
                    "selected_components": _load_json(row["selected_components"], []),
                    "selected_connections": _load_json(row["selected_connections"], []),
                    "component_instances": components,
                    "connection_identities": _load_connections(connection, worksheet_id),
                    "annotations": _load_annotations(connection, worksheet_id),
                }
                canvas_state = _load_canvas_state(connection, worksheet_id)
                if isinstance(canvas_state, dict):
                    stored_auxiliary = canvas_state.get("auxiliary_state")
                    if isinstance(stored_auxiliary, dict):
                        auxiliary.update(
                            {
                                str(key): value
                                for key, value in stored_auxiliary.items()
                            }
                        )
                    component_metadata = canvas_state.get("component_instances")
                    if isinstance(component_metadata, list):
                        metadata_by_legacy = {
                            str(item.get("legacy_node_id") or ""): item
                            for item in component_metadata
                            if isinstance(item, dict)
                            and str(item.get("legacy_node_id") or "")
                        }
                        for item in components:
                            saved_metadata = metadata_by_legacy.get(
                                str(item.get("legacy_node_id") or "")
                            )
                            if isinstance(saved_metadata, dict):
                                merged = dict(saved_metadata)
                                merged.update(item)
                                item.update(merged)
                    if isinstance(canvas_state.get("editor_saved_state"), dict):
                        sheet["editor_saved_state"] = canvas_state[
                            "editor_saved_state"
                        ]
                worksheets.append(sheet)
                component_overrides: dict[str, Any] = {}
                for item in components:
                    legacy_node_id = str(item.get("legacy_node_id") or "")
                    override = _override_from_component_record(item)
                    if legacy_node_id and override is not None:
                        component_overrides[legacy_node_id] = override
                if component_overrides:
                    key = f"manual_component_overrides_{legacy_id}"
                    saved_overrides = auxiliary.get(key)
                    merged_overrides = (
                        dict(saved_overrides)
                        if isinstance(saved_overrides, dict)
                        else {}
                    )
                    for node_id, placement in component_overrides.items():
                        current = merged_overrides.get(node_id)
                        if isinstance(current, dict):
                            merged_overrides[node_id] = {**current, **placement}
                        else:
                            merged_overrides[node_id] = placement
                    auxiliary[key] = merged_overrides
                routes = _load_routes(connection, worksheet_id)
                if routes:
                    routes_by_nodes: dict[str, Any] = {}
                    for record in routes.values():
                        if not isinstance(record, dict):
                            continue
                        source_node_id = str(record.get("source_node_id") or "")
                        target_node_id = str(record.get("target_node_id") or "")
                        if source_node_id and target_node_id:
                            routes_by_nodes.setdefault(
                                f"{source_node_id}__{target_node_id}",
                                record,
                            )
                            routes_by_nodes.setdefault(
                                f"{target_node_id}__{source_node_id}",
                                record,
                            )
                    for item in sheet["connection_identities"]:
                        if not isinstance(item, dict):
                            continue
                        legacy_edge_id = str(item.get("legacy_id") or "")
                        source_node_id = str(item.get("source_node_id") or "")
                        target_node_id = str(item.get("target_node_id") or "")
                        stored_route = routes.get(legacy_edge_id) or routes.get(
                            f"edge__{legacy_edge_id}"
                        )
                        if not isinstance(stored_route, dict):
                            stored_route = routes_by_nodes.get(
                                f"{source_node_id}__{target_node_id}"
                            )
                        if isinstance(stored_route, dict) and isinstance(
                            stored_route.get("points"), list
                        ):
                            item["points"] = stored_route["points"]
                            if legacy_edge_id and legacy_edge_id not in routes:
                                routes[legacy_edge_id] = dict(stored_route)
                if routes or isinstance(
                    auxiliary.get(f"manual_connection_overrides_{legacy_id}"),
                    dict,
                ):
                    key = f"manual_connection_overrides_{legacy_id}"
                    saved_routes = auxiliary.get(key)
                    merged_routes = (
                        dict(saved_routes)
                        if isinstance(saved_routes, dict)
                        else {}
                    )
                    for edge_id, route in routes.items():
                        current = merged_routes.get(edge_id)
                        if isinstance(current, dict):
                            merged_routes[edge_id] = {**current, **route}
                            if (
                                not isinstance(route.get("points"), list)
                                or len(route.get("points") or []) < 2
                            ) and isinstance(current.get("points"), list):
                                merged_routes[edge_id]["points"] = current["points"]
                        else:
                            merged_routes[edge_id] = route
                    auxiliary[key] = merged_routes
            return {
                "site_project": {
                    "stable_id": str(site_row["stable_id"]),
                    "name": str(site_row["name"] or "Site"),
                    "worksheet_stable_ids": worksheet_ids,
                    "created_at": _timestamp_text(site_row["created_at"]),
                    "updated_at": _timestamp_text(site_row["updated_at"]),
                },
                "worksheets": worksheets,
                "auxiliary_state": auxiliary,
            }
    except (ProjectStoreConfigError, ProjectStoreError):
        raise
    except Exception as exc:
        raise ProjectStoreError(_safe_error_text(exc)) from None
    finally:
        if connection is not None:
            connection.close()


def merge_missing_records(
    snapshot: dict[str, Any],
    worksheets: list[dict] | None = None,
    *,
    dsn: str | None = None,
) -> dict[str, Any]:
    """Fill permanent ids that an older snapshot does not contain.

    Saved route_geometry points are copied only onto edges that do not already
    have a polyline. An active worksheet path is left unchanged. A stored
    identity list is copied only when that worksheet's legacy component and
    connection lists still match, and only when the snapshot does not already
    have the list.
    """
    if not isinstance(snapshot, dict):
        return snapshot
    site = _site_record(snapshot)
    if site is None:
        return snapshot
    stored = load_project(site["stable_id"], dsn=dsn)
    if not stored:
        return snapshot
    stored_sheets = {
        str(sheet.get("stable_id") or ""): sheet
        for sheet in list(stored.get("worksheets") or [])
        if isinstance(sheet, dict)
    }
    target_sheets = worksheets if worksheets is not None else snapshot.get("worksheets")
    if isinstance(target_sheets, list):
        for sheet in target_sheets:
            if not isinstance(sheet, dict):
                continue
            saved = stored_sheets.get(str(sheet.get("stable_id") or ""))
            if not saved:
                continue
            same_components = list(sheet.get("selected_components") or []) == list(
                saved.get("selected_components") or []
            )
            same_connections = list(sheet.get("selected_connections") or []) == list(
                saved.get("selected_connections") or []
            )
            if same_components and saved.get("component_instances"):
                if "component_instances" not in sheet:
                    sheet["component_instances"] = [
                        _component_geometry_view(item)
                        for item in saved["component_instances"]
                    ]
                else:
                    # Overlay missing boxes/positions onto existing identity rows.
                    by_legacy = {
                        str(item.get("legacy_node_id") or ""): item
                        for item in saved["component_instances"]
                        if isinstance(item, dict)
                    }
                    merged_components = []
                    for item in list(sheet.get("component_instances") or []):
                        if not isinstance(item, dict):
                            continue
                        merged = dict(item)
                        saved_item = by_legacy.get(str(merged.get("legacy_node_id") or ""))
                        if isinstance(saved_item, dict):
                            if "box" not in merged and isinstance(saved_item.get("box"), list):
                                merged["box"] = list(saved_item["box"])
                            if "position" not in merged and isinstance(
                                saved_item.get("position"), dict
                            ):
                                merged["position"] = dict(saved_item["position"])
                            if (
                                not str(merged.get("display_mode") or "").strip()
                                and saved_item.get("display_mode") is not None
                            ):
                                merged["display_mode"] = _normalize_display_mode(
                                    saved_item.get("display_mode")
                                )
                        merged_components.append(merged)
                    sheet["component_instances"] = merged_components
            if (
                same_connections
                and "connection_identities" not in sheet
                and saved.get("connection_identities")
            ):
                sheet["connection_identities"] = [
                    _identity_view(item, _CONNECTION_IDENTITY_KEYS)
                    for item in saved["connection_identities"]
                ]
    stored_auxiliary = stored.get("auxiliary_state")
    if isinstance(stored_auxiliary, dict):
        snapshot_auxiliary = snapshot.get("auxiliary_state")
        if not isinstance(snapshot_auxiliary, dict):
            snapshot_auxiliary = {}
            snapshot["auxiliary_state"] = snapshot_auxiliary
        for state_key, stored_value in stored_auxiliary.items():
            key = str(state_key)
            if key.startswith("manual_component_overrides_"):
                snapshot_auxiliary[key] = _merge_component_overrides(
                    snapshot_auxiliary.get(key),
                    stored_value,
                )
                continue
            if not key.startswith("manual_connection_overrides_"):
                continue
            if not isinstance(stored_value, dict) or not stored_value:
                continue
            current_routes = snapshot_auxiliary.get(key)
            if not isinstance(current_routes, dict):
                snapshot_auxiliary[key] = dict(stored_value)
                continue
            merged_routes = dict(current_routes)
            for edge_id, stored_route in stored_value.items():
                if not isinstance(stored_route, dict) or not stored_route.get("points"):
                    continue
                current_route = merged_routes.get(str(edge_id))
                current_points = (
                    current_route.get("points") if isinstance(current_route, dict) else None
                )
                if isinstance(current_points, list) and len(current_points) >= 2:
                    continue
                merged_routes[str(edge_id)] = dict(stored_route)
            snapshot_auxiliary[key] = merged_routes
    return snapshot


def migrate_sqlite_to_postgres(
    sqlite_path: Path | None = None,
    *,
    dsn: str | None = None,
) -> list[str]:
    """Copy sites from the old SQLite file into PostgreSQL.

    This does not run during PPT save. The SQLite file is left in place.
    """
    from .project_store_sqlite import legacy_database_path, list_site_ids, load_project as load_sqlite

    path = Path(sqlite_path) if sqlite_path is not None else legacy_database_path()
    if not path.is_file():
        return []
    migrated: list[str] = []
    for site_id in list_site_ids(path):
        snapshot = load_sqlite(site_id, database_path=path)
        if not snapshot:
            continue
        save_project(snapshot, dsn=dsn)
        migrated.append(str(snapshot["site_project"]["stable_id"]))
    return migrated


def _connect(dsn: str | None):
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise ProjectStoreConfigError(
            "PostgreSQL driver psycopg is not installed."
        ) from exc
    return psycopg.connect(
        connection_dsn(dsn),
        connect_timeout=5,
        application_name="itank-project-store",
        row_factory=dict_row,
    )


def _ensure_schema(connection) -> None:
    import psycopg

    schema = _schema_name()
    connection.execute(
        psycopg.sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(
            psycopg.sql.Identifier(schema)
        )
    )
    connection.execute(
        psycopg.sql.SQL("SET search_path TO {}").format(psycopg.sql.Identifier(schema))
    )
    for statement in _SCHEMA_STATEMENTS:
        connection.execute(statement)
    connection.execute(
        """
        ALTER TABLE route_geometry
        ADD COLUMN IF NOT EXISTS manual_override_information BOOLEAN NOT NULL DEFAULT FALSE
        """
    )
    connection.execute(
        """
        ALTER TABLE component_instance
        ADD COLUMN IF NOT EXISTS display_mode TEXT NOT NULL DEFAULT 'icons'
        """
    )
    row = connection.execute("SELECT version FROM schema_meta LIMIT 1").fetchone()
    if row is None:
        connection.execute(
            "INSERT INTO schema_meta (version) VALUES (%s)",
            (_SCHEMA_VERSION,),
        )
        return
    if int(row["version"]) != _SCHEMA_VERSION:
        raise ProjectStoreError(
            f"PostgreSQL schema version is {row['version']}, expected {_SCHEMA_VERSION}."
        )


def _schema_name() -> str:
    _load_local_env()
    schema = os.environ.get("ITANK_POSTGRES_SCHEMA", "public").strip() or "public"
    if _SCHEMA_NAME_RE.fullmatch(schema) is None:
        raise ProjectStoreConfigError(
            "ITANK_POSTGRES_SCHEMA must be a single schema name."
        )
    return schema


def _delete_removed_worksheets(connection, site_id: str, worksheets: list[dict]) -> None:
    kept = [
        uuid.UUID(text)
        for sheet in worksheets
        if (text := _uuid_text(sheet.get("stable_id")))
    ]
    if not kept:
        connection.execute(
            "DELETE FROM worksheet WHERE site_project_id = %s::uuid",
            (site_id,),
        )
        return
    connection.execute(
        """
        DELETE FROM worksheet
        WHERE site_project_id = %s::uuid
          AND NOT (stable_id = ANY(%s::uuid[]))
        """,
        (site_id, [str(item) for item in kept]),
    )


def _insert_worksheet(
    connection,
    site_id: str,
    order: int,
    sheet: dict[str, Any],
    auxiliary: dict[str, Any],
) -> None:
    worksheet_id = _uuid_text(sheet.get("stable_id"))
    if worksheet_id is None:
        return
    try:
        legacy_id = int(sheet.get("id"))
    except (TypeError, ValueError):
        return
    from psycopg.types.json import Jsonb

    existing = connection.execute(
        """
        SELECT selected_connections
        FROM worksheet
        WHERE stable_id = %s::uuid
        """,
        (worksheet_id,),
    ).fetchone()
    selected_connections = _merge_id_list(
        _load_json(existing["selected_connections"], []) if existing is not None else [],
        list(sheet.get("selected_connections") or []),
    )
    connection.execute(
        """
        INSERT INTO worksheet (
            stable_id, site_project_id, worksheet_number, name, display_order,
            selected_components, selected_connections
        ) VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s)
        ON CONFLICT (stable_id) DO UPDATE SET
            site_project_id = EXCLUDED.site_project_id,
            worksheet_number = EXCLUDED.worksheet_number,
            name = EXCLUDED.name,
            display_order = EXCLUDED.display_order,
            selected_components = EXCLUDED.selected_components,
            selected_connections = EXCLUDED.selected_connections,
            updated_at = NOW()
        """,
        (
            worksheet_id,
            site_id,
            legacy_id,
            str(sheet.get("name") or f"Worksheet {legacy_id}"),
            int(order),
            Jsonb(list(sheet.get("selected_components") or [])),
            Jsonb(selected_connections),
        ),
    )
    # Annotations are replaced as a set. Connections, routes, and components
    # are upserted below so one new line cannot erase the others.
    connection.execute(
        "DELETE FROM annotation WHERE worksheet_id = %s::uuid",
        (worksheet_id,),
    )
    component_ids = _insert_components(connection, worksheet_id, legacy_id, sheet, auxiliary)
    connection_ids = _insert_connections(
        connection,
        worksheet_id,
        sheet,
        component_ids,
    )
    _insert_routes(
        connection,
        worksheet_id,
        legacy_id,
        connection_ids,
        auxiliary,
    )
    _insert_annotations(
        connection,
        worksheet_id,
        sheet,
        _worksheet_canvas_state(sheet, legacy_id, auxiliary),
    )


def _insert_components(
    connection,
    worksheet_id: str,
    legacy_id: int,
    sheet: dict[str, Any],
    auxiliary: dict[str, Any],
) -> set[str]:
    overrides = auxiliary.get(f"manual_component_overrides_{legacy_id}")
    if not isinstance(overrides, dict):
        overrides = {}
    inserted: set[str] = set()
    for display_order, item in enumerate(list(sheet.get("component_instances") or [])):
        if not isinstance(item, dict):
            continue
        stable_id = _uuid_text(item.get("stable_id"))
        if stable_id is None:
            continue
        legacy_node_id = str(item.get("legacy_node_id") or "")
        override = overrides.get(legacy_node_id)
        if not isinstance(override, dict):
            # Fall back to geometry stored on the component identity row.
            override = {}
            if isinstance(item.get("box"), (list, tuple)):
                override["box"] = item.get("box")
            row_position = item.get("position")
            if isinstance(row_position, dict):
                override["x"] = row_position.get("x")
                override["y"] = row_position.get("y")
            elif item.get("x") is not None or item.get("y") is not None:
                override["x"] = item.get("x")
                override["y"] = item.get("y")
        placement = _placement(override)
        display_mode = _normalize_display_mode(
            override.get("display_mode")
            or item.get("display_mode")
        )
        connection.execute(
            """
            INSERT INTO component_instance (
                stable_id, worksheet_id, legacy_node_id, catalog_name,
                component_type, instance_index, code, display_order,
                position_x, position_y, box_x, box_y, box_width, box_height,
                display_mode
            ) VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (stable_id) DO UPDATE SET
                legacy_node_id = EXCLUDED.legacy_node_id,
                catalog_name = EXCLUDED.catalog_name,
                component_type = EXCLUDED.component_type,
                instance_index = EXCLUDED.instance_index,
                code = EXCLUDED.code,
                display_order = EXCLUDED.display_order,
                position_x = EXCLUDED.position_x,
                position_y = EXCLUDED.position_y,
                box_x = EXCLUDED.box_x,
                box_y = EXCLUDED.box_y,
                box_width = EXCLUDED.box_width,
                box_height = EXCLUDED.box_height,
                display_mode = EXCLUDED.display_mode
            """,
            (
                stable_id,
                worksheet_id,
                legacy_node_id,
                str(item.get("catalog_name") or ""),
                str(item.get("node_type") or ""),
                int(item.get("instance_index") or 1),
                str(item.get("code") or ""),
                int(display_order),
                *placement,
                display_mode,
            ),
        )
        inserted.add(stable_id)
    return inserted


def _merge_id_list(existing: Any, incoming: Any) -> list[str]:
    """Append connection ids that are not already stored. Never drop one."""
    merged: list[str] = []
    seen: set[str] = set()
    for raw_id in list(existing or []) + list(incoming or []):
        connection_id = str(raw_id or "").strip()
        if not connection_id or connection_id in seen:
            continue
        seen.add(connection_id)
        merged.append(connection_id)
    return merged


def _upsert_connection_identity_row(
    connection,
    worksheet_id: str,
    stable_id: str,
    source_id: str,
    target_id: str,
    legacy_id: str,
    source_node_id: str,
    target_node_id: str,
    relation: str,
    rule_identity: str,
    rule_label: str,
    channel: str,
    direction: str,
    position: int,
) -> None:
    """Insert or update one connection. Other worksheet connections stay."""
    connection.execute(
        """
        INSERT INTO connection_identity (
            stable_id, worksheet_id, source_component_id, target_component_id,
            legacy_id, source_node_id, target_node_id, relation,
            rule_identity, rule_label, channel, direction, display_order
        ) VALUES (%s::uuid, %s::uuid, %s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (stable_id) DO UPDATE SET
            legacy_id = EXCLUDED.legacy_id,
            source_node_id = EXCLUDED.source_node_id,
            target_node_id = EXCLUDED.target_node_id,
            relation = EXCLUDED.relation,
            rule_identity = EXCLUDED.rule_identity,
            rule_label = EXCLUDED.rule_label,
            channel = EXCLUDED.channel,
            direction = EXCLUDED.direction,
            display_order = EXCLUDED.display_order,
            source_component_id = COALESCE(
                connection_identity.source_component_id,
                EXCLUDED.source_component_id
            ),
            target_component_id = COALESCE(
                connection_identity.target_component_id,
                EXCLUDED.target_component_id
            )
        WHERE connection_identity.worksheet_id = EXCLUDED.worksheet_id
        """,
        (
            stable_id,
            worksheet_id,
            source_id,
            target_id,
            legacy_id,
            source_node_id,
            target_node_id,
            relation,
            rule_identity,
            rule_label,
            channel,
            direction,
            int(position),
        ),
    )


def upsert_worksheet_connection(
    *,
    worksheet_stable_id: str,
    connection_record: dict[str, Any],
    dsn: str | None = None,
) -> bool:
    """Upsert one connection by its stable id and leave every other line stored."""
    worksheet_stable_id = _uuid_text(worksheet_stable_id) or ""
    if not worksheet_stable_id or not isinstance(connection_record, dict):
        return False
    stable_id = _uuid_text(connection_record.get("stable_id"))
    source_id = _uuid_text(connection_record.get("source_stable_id"))
    target_id = _uuid_text(connection_record.get("target_stable_id"))
    legacy_id = str(connection_record.get("legacy_id") or "").strip()
    if stable_id is None or source_id is None or target_id is None or not legacy_id:
        return False
    connection = None
    try:
        connection = _connect(dsn)
        with connection:
            _ensure_schema(connection)
            worksheet = connection.execute(
                """
                SELECT stable_id
                FROM worksheet
                WHERE stable_id = %s::uuid
                """,
                (worksheet_stable_id,),
            ).fetchone()
            if worksheet is None:
                return False
            present = connection.execute(
                """
                SELECT stable_id
                FROM component_instance
                WHERE stable_id IN (%s::uuid, %s::uuid)
                """,
                (source_id, target_id),
            ).fetchall()
            present_ids = {str(row["stable_id"]) for row in present}
            if source_id not in present_ids or target_id not in present_ids:
                return False
            parsed = parse_legacy_connection_id(legacy_id) or {}
            relation = str(connection_record.get("relation") or parsed.get("relation") or "to")
            rule_identity, rule_label, channel = _rule_metadata(legacy_id)
            _upsert_connection_identity_row(
                connection,
                worksheet_stable_id,
                stable_id,
                source_id,
                target_id,
                legacy_id,
                str(connection_record.get("source_node_id") or parsed.get("source") or ""),
                str(connection_record.get("target_node_id") or parsed.get("target") or ""),
                relation,
                str(connection_record.get("rule_identity") or rule_identity),
                str(connection_record.get("rule_label") or rule_label),
                str(connection_record.get("channel") or channel),
                str(connection_record.get("direction") or relation),
                int(connection_record.get("display_order") or 0),
            )
            stored = connection.execute(
                """
                SELECT selected_connections
                FROM worksheet
                WHERE stable_id = %s::uuid
                """,
                (worksheet_stable_id,),
            ).fetchone()
            merged_ids = _merge_id_list(
                _load_json(stored["selected_connections"], []) if stored is not None else [],
                [legacy_id],
            )
            from psycopg.types.json import Jsonb

            connection.execute(
                """
                UPDATE worksheet
                SET selected_connections = %s,
                    updated_at = NOW()
                WHERE stable_id = %s::uuid
                """,
                (Jsonb(merged_ids), worksheet_stable_id),
            )
            return True
    except (ProjectStoreConfigError, ProjectStoreError):
        raise
    except Exception as exc:
        raise ProjectStoreError(_safe_error_text(exc)) from None
    finally:
        if connection is not None:
            connection.close()


def _insert_connections(
    connection,
    worksheet_id: str,
    sheet: dict[str, Any],
    component_ids: set[str],
) -> dict[str, str]:
    inserted: dict[str, str] = {}
    position = 0
    for item in list(sheet.get("connection_identities") or []):
        if not isinstance(item, dict):
            continue
        stable_id = _uuid_text(item.get("stable_id"))
        source_id = _uuid_text(item.get("source_stable_id"))
        target_id = _uuid_text(item.get("target_stable_id"))
        legacy_id = str(item.get("legacy_id") or "").strip()
        if (
            stable_id is None
            or source_id is None
            or target_id is None
            or not legacy_id
            or source_id not in component_ids
            or target_id not in component_ids
        ):
            continue
        parsed = parse_legacy_connection_id(legacy_id) or {}
        relation = str(item.get("relation") or parsed.get("relation") or "to")
        rule_identity, rule_label, channel = _rule_metadata(legacy_id)
        if str(item.get("rule_label") or item.get("label") or "").strip():
            rule_label = str(item.get("rule_label") or item.get("label") or "").strip()
        if str(item.get("channel") or "").strip():
            channel = str(item.get("channel") or "").strip()
        if str(item.get("rule_identity") or "").strip():
            rule_identity = str(item.get("rule_identity") or "").strip()
        direction = str(item.get("direction") or relation)
        _upsert_connection_identity_row(
            connection,
            worksheet_id,
            stable_id,
            source_id,
            target_id,
            legacy_id,
            str(item.get("source_node_id") or parsed.get("source") or ""),
            str(item.get("target_node_id") or parsed.get("target") or ""),
            relation,
            rule_identity,
            rule_label,
            channel,
            direction,
            position,
        )
        inserted[legacy_id] = stable_id
        position += 1
    return inserted


def delete_connection_geometry(
    *,
    worksheet_stable_id: str,
    legacy_edge_id: str,
    dsn: str | None = None,
) -> bool:
    """Remove one connection and its saved route in a single database write."""
    worksheet_stable_id = _uuid_text(worksheet_stable_id) or ""
    legacy_edge_id = str(legacy_edge_id or "").strip()
    if not worksheet_stable_id or not legacy_edge_id:
        return False
    logical_id = legacy_edge_id[6:] if legacy_edge_id.startswith("edge__") else legacy_edge_id
    edge_ids = list(dict.fromkeys((legacy_edge_id, logical_id, f"edge__{logical_id}")))
    connection = None
    try:
        connection = _connect(dsn)
        with connection:
            _ensure_schema(connection)
            connection.execute(
                """
                DELETE FROM route_geometry
                WHERE worksheet_id = %s::uuid
                  AND legacy_edge_id = ANY(%s)
                """,
                (worksheet_stable_id, edge_ids),
            )
            connection.execute(
                """
                DELETE FROM connection_identity
                WHERE worksheet_id = %s::uuid
                  AND legacy_id = ANY(%s)
                """,
                (worksheet_stable_id, edge_ids),
            )
        return True
    except ProjectStoreConfigError:
        return False
    except (ProjectStoreError, Exception) as exc:
        if isinstance(exc, ProjectStoreError):
            raise
        raise ProjectStoreError(_safe_error_text(exc)) from None
    finally:
        if connection is not None:
            connection.close()


def save_component_placements(
    *,
    worksheet_stable_id: str,
    placements: dict[str, Any],
    dsn: str | None = None,
) -> bool:
    """Persist one or more component boxes for an existing worksheet.

    Updates only ``component_instance`` rows that already exist for the given
    legacy node ids. Missing worksheet/component rows are skipped so a first
    drag before the site is saved does not create orphan rows.
    """
    worksheet_stable_id = _uuid_text(worksheet_stable_id) or ""
    if not worksheet_stable_id or not isinstance(placements, dict) or not placements:
        return False
    connection = None
    try:
        connection = _connect(dsn)
        with connection:
            _ensure_schema(connection)
            worksheet = connection.execute(
                """
                SELECT stable_id
                FROM worksheet
                WHERE stable_id = %s::uuid
                """,
                (worksheet_stable_id,),
            ).fetchone()
            if worksheet is None:
                return False
            updated = False
            for legacy_node_id, raw in placements.items():
                node_id = str(legacy_node_id or "").strip()
                if not node_id or not isinstance(raw, dict):
                    continue
                placement = _placement(raw)
                display_mode = raw.get("display_mode")
                has_display_mode = display_mode is not None and str(display_mode).strip() != ""
                if all(value is None for value in placement) and not has_display_mode:
                    continue
                cursor = connection.execute(
                    """
                    UPDATE component_instance
                    SET position_x = COALESCE(%s, position_x),
                        position_y = COALESCE(%s, position_y),
                        box_x = COALESCE(%s, box_x),
                        box_y = COALESCE(%s, box_y),
                        box_width = COALESCE(%s, box_width),
                        box_height = COALESCE(%s, box_height),
                        display_mode = COALESCE(%s, display_mode)
                    WHERE worksheet_id = %s::uuid
                      AND legacy_node_id = %s
                    """,
                    (
                        *placement,
                        _normalize_display_mode(display_mode) if has_display_mode else None,
                        worksheet_stable_id,
                        node_id,
                    ),
                )
                if getattr(cursor, "rowcount", 0):
                    updated = True
            if updated:
                connection.execute(
                    """
                    UPDATE worksheet
                    SET updated_at = NOW()
                    WHERE stable_id = %s::uuid
                    """,
                    (worksheet_stable_id,),
                )
            return updated
    except ProjectStoreConfigError:
        return False
    except (ProjectStoreError, Exception) as exc:
        if isinstance(exc, ProjectStoreError):
            raise
        raise ProjectStoreError(_safe_error_text(exc)) from None
    finally:
        if connection is not None:
            connection.close()


def list_site_projects(*, dsn: str | None = None) -> list[dict[str, str]]:
    """Return saved sites newest-first for startup restore."""
    connection = None
    try:
        connection = _connect(dsn)
        with connection:
            _ensure_schema(connection)
            rows = connection.execute(
                """
                SELECT stable_id, name, updated_at
                FROM site_project
                ORDER BY updated_at DESC, created_at DESC
                """
            ).fetchall()
            return [
                {
                    "stable_id": str(row["stable_id"]),
                    "name": str(row["name"] or "Site"),
                    "updated_at": _timestamp_text(row["updated_at"]),
                }
                for row in rows
            ]
    except ProjectStoreConfigError:
        return []
    except Exception as exc:
        raise ProjectStoreError(_safe_error_text(exc)) from None
    finally:
        if connection is not None:
            connection.close()


def load_saved_component_placements(
    *,
    site_stable_id: str | None = None,
    worksheet_stable_id: str | None = None,
    dsn: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Return saved component boxes keyed by stable identity.

    Keys:
      - ``legacy_node_id`` (e.g. ``sump_1``)
      - ``catalog_name#instance_index`` (e.g. ``Sump#1``)

    Prefer ``worksheet_stable_id`` so a blank / new worksheet never inherits
    positions from another worksheet. Never scans "newest site" automatically —
    callers must pass the current site/worksheet. Connections are not returned.
    """
    site_id = _uuid_text(site_stable_id) or ""
    worksheet_id = _uuid_text(worksheet_stable_id) or ""
    if not site_id and not worksheet_id:
        return {}
    connection = None
    try:
        connection = _connect(dsn)
        with connection:
            _ensure_schema(connection)
            if worksheet_id:
                rows = connection.execute(
                    """
                    SELECT c.catalog_name, c.legacy_node_id, c.instance_index,
                           c.component_type, c.position_x, c.position_y,
                           c.box_x, c.box_y, c.box_width, c.box_height,
                           c.display_mode
                    FROM component_instance AS c
                    WHERE c.worksheet_id = %s::uuid
                    ORDER BY c.display_order, c.stable_id
                    """,
                    (worksheet_id,),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT c.catalog_name, c.legacy_node_id, c.instance_index,
                           c.component_type, c.position_x, c.position_y,
                           c.box_x, c.box_y, c.box_width, c.box_height,
                           c.display_mode
                    FROM component_instance AS c
                    INNER JOIN worksheet AS w
                      ON w.stable_id = c.worksheet_id
                    WHERE w.site_project_id = %s::uuid
                    ORDER BY w.display_order, c.display_order, c.stable_id
                    """,
                    (site_id,),
                ).fetchall()
            placements: dict[str, dict[str, Any]] = {}
            for row in rows:
                record = {
                    "catalog_name": str(row["catalog_name"] or ""),
                    "legacy_node_id": str(row["legacy_node_id"] or ""),
                    "instance_index": int(row["instance_index"] or 1),
                    "node_type": str(row["component_type"] or ""),
                    "display_mode": _normalize_display_mode(row.get("display_mode")),
                }
                if row["position_x"] is not None or row["position_y"] is not None:
                    record["position"] = {
                        "x": row["position_x"],
                        "y": row["position_y"],
                    }
                    record["x"] = row["position_x"]
                    record["y"] = row["position_y"]
                if None not in (
                    row["box_x"],
                    row["box_y"],
                    row["box_width"],
                    row["box_height"],
                ):
                    record["box"] = [
                        row["box_x"],
                        row["box_y"],
                        row["box_width"],
                        row["box_height"],
                    ]
                if "box" not in record and (
                    record.get("x") is None or record.get("y") is None
                ):
                    continue
                legacy = str(record.get("legacy_node_id") or "").strip()
                catalog = str(record.get("catalog_name") or "").strip()
                index = int(record.get("instance_index") or 1)
                if legacy and legacy not in placements:
                    placements[legacy] = dict(record)
                catalog_key = f"{catalog}#{index}"
                if catalog and catalog_key not in placements:
                    placements[catalog_key] = dict(record)
            return placements
    except ProjectStoreConfigError:
        return {}
    except Exception as exc:
        raise ProjectStoreError(_safe_error_text(exc)) from None
    finally:
        if connection is not None:
            connection.close()


def load_saved_route_geometry(
    *,
    worksheet_stable_id: str | None = None,
    dsn: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Return saved route polylines for one worksheet only.

    Used after the user manually selects endpoint components — never for a
    blank startup / blank worksheet preload.
    """
    worksheet_id = _uuid_text(worksheet_stable_id) or ""
    if not worksheet_id:
        return {}
    connection = None
    try:
        connection = _connect(dsn)
        with connection:
            _ensure_schema(connection)
            return _load_routes(connection, worksheet_id)
    except ProjectStoreConfigError:
        return {}
    except Exception as exc:
        raise ProjectStoreError(_safe_error_text(exc)) from None
    finally:
        if connection is not None:
            connection.close()


def save_manual_route_geometry(
    *,
    worksheet_stable_id: str,
    legacy_edge_id: str,
    points: list,
    mode: str,
    hidden: bool = False,
    arrow_direction: str = "",
    override: dict | None = None,
    dsn: str | None = None,
) -> bool:
    """Store one dragged or hand-drawn route without rewriting connections.

    The row is inserted or updated in ``route_geometry`` and
    ``manual_override_information`` is set true. ``connection_identity`` is
    only read so an existing source and target stay attached. This does not
    delete worksheet children or update those component ids.
    """
    worksheet_stable_id = _uuid_text(worksheet_stable_id) or ""
    legacy_edge_id = str(legacy_edge_id or "").strip()
    if not worksheet_stable_id or not legacy_edge_id:
        return False
    connection = None
    try:
        connection = _connect(dsn)
        with connection:
            _ensure_schema(connection)
            return _upsert_manual_route(
                connection,
                worksheet_stable_id,
                legacy_edge_id,
                list(points or []),
                str(mode or ""),
                bool(hidden),
                str(arrow_direction or ""),
                dict(override or {}),
            )
    except (ProjectStoreConfigError, ProjectStoreError):
        raise
    except Exception as exc:
        raise ProjectStoreError(_safe_error_text(exc)) from None
    finally:
        if connection is not None:
            connection.close()


def _upsert_manual_route(
    connection,
    worksheet_stable_id: str,
    legacy_edge_id: str,
    points: list,
    mode: str,
    hidden: bool,
    arrow_direction: str,
    override: dict,
) -> bool:
    worksheet = connection.execute(
        """
        SELECT stable_id
        FROM worksheet
        WHERE stable_id = %s::uuid
        """,
        (worksheet_stable_id,),
    ).fetchone()
    if worksheet is None:
        return False
    logical_id = legacy_edge_id[6:] if legacy_edge_id.startswith("edge__") else legacy_edge_id
    identity = connection.execute(
        """
        SELECT stable_id
        FROM connection_identity
        WHERE worksheet_id = %s::uuid
          AND legacy_id IN (%s, %s)
        LIMIT 1
        """,
        (worksheet_stable_id, logical_id, legacy_edge_id),
    ).fetchone()
    connection_id = str(identity["stable_id"]) if identity is not None else None
    from psycopg.types.json import Jsonb

    connection.execute(
        """
        INSERT INTO route_geometry (
            stable_id, worksheet_id, connection_id, legacy_edge_id,
            points, mode, hidden, arrow_direction, override_json,
            manual_override_information
        ) VALUES (
            %s::uuid, %s::uuid, CAST(%s AS uuid), %s,
            %s, %s, %s, %s, %s, TRUE
        )
        ON CONFLICT (stable_id) DO UPDATE SET
            points = EXCLUDED.points,
            mode = EXCLUDED.mode,
            hidden = EXCLUDED.hidden,
            arrow_direction = EXCLUDED.arrow_direction,
            override_json = EXCLUDED.override_json,
            manual_override_information = TRUE,
            connection_id = COALESCE(EXCLUDED.connection_id, route_geometry.connection_id)
        WHERE route_geometry.worksheet_id = EXCLUDED.worksheet_id
        """,
        (
            _route_row_id(worksheet_stable_id, legacy_edge_id),
            worksheet_stable_id,
            connection_id,
            legacy_edge_id,
            Jsonb(_json_ready(points)),
            mode,
            hidden,
            arrow_direction,
            Jsonb(_json_ready(override)),
        ),
    )
    return True


def _insert_routes(
    connection,
    worksheet_id: str,
    legacy_id: int,
    connection_ids: dict[str, str],
    auxiliary: dict[str, Any],
) -> None:
    overrides = auxiliary.get(f"manual_connection_overrides_{legacy_id}")
    if not isinstance(overrides, dict):
        return
    from psycopg.types.json import Jsonb

    for edge_id, value in overrides.items():
        legacy_edge_id = str(edge_id or "").strip()
        if not legacy_edge_id or not isinstance(value, dict):
            continue
        logical_id = legacy_edge_id[6:] if legacy_edge_id.startswith("edge__") else legacy_edge_id
        connection_id = connection_ids.get(logical_id) or connection_ids.get(legacy_edge_id)
        points = value.get("points") if isinstance(value.get("points"), list) else []
        mode = str(value.get("mode") or "")
        manual_override = (
            mode in {"manual_drag", "manual_draw", "header_branch", "sump_tank_bore_loop"}
            or bool(value.get("custom"))
        )
        connection.execute(
            """
            INSERT INTO route_geometry (
                stable_id, worksheet_id, connection_id, legacy_edge_id,
                points, mode, hidden, arrow_direction, override_json,
                manual_override_information
            ) VALUES (%s::uuid, %s::uuid, CAST(%s AS uuid), %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (stable_id) DO UPDATE SET
                points = CASE
                    WHEN EXCLUDED.manual_override_information THEN EXCLUDED.points
                    ELSE route_geometry.points
                END,
                mode = CASE
                    WHEN EXCLUDED.manual_override_information THEN EXCLUDED.mode
                    ELSE route_geometry.mode
                END,
                hidden = EXCLUDED.hidden,
                arrow_direction = EXCLUDED.arrow_direction,
                override_json = CASE
                    WHEN EXCLUDED.manual_override_information THEN EXCLUDED.override_json
                    ELSE route_geometry.override_json
                END,
                manual_override_information = route_geometry.manual_override_information
                    OR EXCLUDED.manual_override_information,
                connection_id = COALESCE(EXCLUDED.connection_id, route_geometry.connection_id)
            WHERE route_geometry.worksheet_id = EXCLUDED.worksheet_id
            """,
            (
                _route_row_id(worksheet_id, legacy_edge_id),
                worksheet_id,
                connection_id,
                legacy_edge_id,
                Jsonb(_json_ready(points)),
                mode,
                bool(value.get("hidden", False)),
                str(value.get("direction") or ""),
                Jsonb(_json_ready(value)),
                manual_override,
            ),
        )


def _worksheet_canvas_state(
    sheet: dict[str, Any],
    legacy_id: int,
    auxiliary: dict[str, Any],
) -> dict[str, Any]:
    """Build JSON-safe worksheet canvas metadata without changing the schema."""
    state: dict[str, Any] = {}
    for prefix in _CANVAS_STATE_AUXILIARY_KEYS:
        key = f"{prefix}_{int(legacy_id)}"
        if key in auxiliary:
            state[key] = _json_ready(auxiliary[key])
    component_instances = [
        _json_ready(dict(item))
        for item in list(sheet.get("component_instances") or [])
        if isinstance(item, dict)
    ]
    editor_state = sheet.get("editor_saved_state")
    editor_state = (
        dict(editor_state)
        if isinstance(editor_state, dict)
        else {}
    )
    editor_state.setdefault(
        "viewport",
        {"zoom": 1.0, "pan_x": 0.0, "pan_y": 0.0},
    )
    return {
        "version": 1,
        "auxiliary_state": state,
        "component_instances": component_instances,
        "editor_saved_state": _json_ready(editor_state),
    }


def _insert_annotations(
    connection,
    worksheet_id: str,
    sheet: dict[str, Any],
    canvas_state: dict[str, Any] | None = None,
) -> None:
    from psycopg.types.json import Jsonb

    for position, note in enumerate(list(sheet.get("annotations") or [])):
        if not isinstance(note, dict):
            continue
        legacy_note_id = str(note.get("id") if note.get("id") is not None else "")
        note_stable_id = _uuid_text(note.get("stable_id")) or _annotation_id(
            worksheet_id,
            legacy_note_id,
        )
        connection.execute(
            """
            INSERT INTO annotation (
                stable_id, worksheet_id, legacy_note_id, display_order, payload
            ) VALUES (%s::uuid, %s::uuid, %s, %s, %s)
            """,
            (
                note_stable_id,
                worksheet_id,
                legacy_note_id,
                int(position),
                Jsonb(_json_ready(dict(note))),
            ),
        )
    if isinstance(canvas_state, dict):
        connection.execute(
            """
            INSERT INTO annotation (
                stable_id, worksheet_id, legacy_note_id, display_order, payload
            ) VALUES (%s::uuid, %s::uuid, %s, %s, %s)
            """,
            (
                _annotation_id(worksheet_id, _CANVAS_STATE_NOTE_ID),
                worksheet_id,
                _CANVAS_STATE_NOTE_ID,
                len(list(sheet.get("annotations") or [])),
                Jsonb(_json_ready({
                    "_itank_canvas_state": canvas_state,
                })),
            ),
        )


def _load_components(connection, worksheet_id: str) -> list[dict]:
    rows = connection.execute(
        """
        SELECT stable_id, catalog_name, legacy_node_id, instance_index,
               component_type, code, position_x, position_y,
               box_x, box_y, box_width, box_height, display_mode
        FROM component_instance
        WHERE worksheet_id = %s::uuid
        ORDER BY display_order, stable_id
        """,
        (worksheet_id,),
    ).fetchall()
    loaded = []
    for row in rows:
        record = {
            "stable_id": str(row["stable_id"]),
            "catalog_name": str(row["catalog_name"] or ""),
            "legacy_node_id": str(row["legacy_node_id"] or ""),
            "instance_index": int(row["instance_index"] or 1),
            "node_type": str(row["component_type"] or ""),
            "code": str(row["code"] or ""),
            "display_mode": _normalize_display_mode(row.get("display_mode")),
        }
        if row["position_x"] is not None or row["position_y"] is not None:
            record["position"] = {
                "x": row["position_x"],
                "y": row["position_y"],
            }
        if None not in (
            row["box_x"],
            row["box_y"],
            row["box_width"],
            row["box_height"],
        ):
            record["box"] = [
                row["box_x"],
                row["box_y"],
                row["box_width"],
                row["box_height"],
            ]
        loaded.append(record)
    return loaded


def _load_connections(connection, worksheet_id: str) -> list[dict]:
    rows = connection.execute(
        """
        SELECT stable_id, legacy_id, source_component_id, target_component_id,
               source_node_id, target_node_id, relation, rule_identity,
               rule_label, channel, direction
        FROM connection_identity
        WHERE worksheet_id = %s::uuid
        ORDER BY display_order, legacy_id
        """,
        (worksheet_id,),
    ).fetchall()
    return [
        {
            "stable_id": str(row["stable_id"]),
            "legacy_id": str(row["legacy_id"] or ""),
            "source_stable_id": str(row["source_component_id"]),
            "target_stable_id": str(row["target_component_id"]),
            "source_node_id": str(row["source_node_id"] or ""),
            "target_node_id": str(row["target_node_id"] or ""),
            "relation": str(row["relation"] or "to"),
            "rule_identity": str(row["rule_identity"] or ""),
            "rule_label": str(row["rule_label"] or ""),
            "channel": str(row["channel"] or ""),
            "direction": str(row["direction"] or ""),
        }
        for row in rows
    ]


def _load_routes(connection, worksheet_id: str) -> dict[str, Any]:
    rows = connection.execute(
        """
        SELECT route.legacy_edge_id,
               route.connection_id,
               route.points,
               route.mode,
               route.hidden,
               route.arrow_direction,
               route.override_json,
               link.stable_id AS connection_stable_id,
               link.legacy_id AS connection_legacy_id,
               link.source_component_id,
               link.target_component_id,
               link.source_node_id,
               link.target_node_id
        FROM route_geometry AS route
        LEFT JOIN connection_identity AS link
          ON link.stable_id = route.connection_id
         AND link.worksheet_id = route.worksheet_id
        WHERE route.worksheet_id = %s::uuid
        ORDER BY route.legacy_edge_id
        """,
        (worksheet_id,),
    ).fetchall()
    routes: dict[str, Any] = {}
    for row in rows:
        value = _load_json(row["override_json"], {})
        record = dict(value) if isinstance(value, dict) else {}
        stored_points = _load_json(row["points"], [])
        if not isinstance(stored_points, list) or len(stored_points) < 2:
            stored_points = record.get("points")
        if not isinstance(stored_points, list) or len(stored_points) < 2:
            continue
        exact_points = []
        for point in stored_points:
            try:
                exact_points.append([float(point[0]), float(point[1])])
            except (TypeError, ValueError, IndexError):
                exact_points = []
                break
        if len(exact_points) < 2:
            continue
        record["points"] = exact_points
        record["stored_geometry"] = True
        if row["mode"]:
            record["mode"] = str(row["mode"])
        record["hidden"] = bool(row["hidden"])
        if row["arrow_direction"]:
            record["direction"] = str(row["arrow_direction"])
        if row["connection_stable_id"]:
            record["connection_stable_id"] = str(row["connection_stable_id"])
        if row["source_component_id"]:
            record["source_component_id"] = str(row["source_component_id"])
        if row["target_component_id"]:
            record["target_component_id"] = str(row["target_component_id"])
        source_node_id = str(row["source_node_id"] or record.get("source") or "")
        target_node_id = str(row["target_node_id"] or record.get("target") or "")
        if source_node_id:
            record["source"] = source_node_id
            record["source_node_id"] = source_node_id
        if target_node_id:
            record["target"] = target_node_id
            record["target_node_id"] = target_node_id
        legacy_edge_id = str(row["legacy_edge_id"] or "")
        if legacy_edge_id:
            routes[legacy_edge_id] = record
        connection_legacy_id = str(row["connection_legacy_id"] or "")
        if connection_legacy_id and connection_legacy_id not in routes:
            routes[connection_legacy_id] = record
    return routes


def _load_annotations(connection, worksheet_id: str) -> list[dict]:
    rows = connection.execute(
        """
        SELECT payload
        FROM annotation
        WHERE worksheet_id = %s::uuid
        ORDER BY display_order, legacy_note_id
        """,
        (worksheet_id,),
    ).fetchall()
    notes = []
    for row in rows:
        payload = _load_json(row["payload"], {})
        if isinstance(payload, dict) and "_itank_canvas_state" not in payload:
            notes.append(payload)
    return notes


def _load_canvas_state(connection, worksheet_id: str) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT payload
        FROM annotation
        WHERE worksheet_id = %s::uuid
          AND legacy_note_id = %s
        """,
        (worksheet_id, _CANVAS_STATE_NOTE_ID),
    ).fetchone()
    payload = _load_json(row["payload"], {}) if row is not None else {}
    state = payload.get("_itank_canvas_state") if isinstance(payload, dict) else None
    return state if isinstance(state, dict) else None


def _rule_metadata(legacy_id: str) -> tuple[str, str, str]:
    parsed = parse_legacy_connection_id(legacy_id)
    if parsed is None:
        return "", "", ""
    kind = str(parsed.get("kind") or "")
    label = ""
    channel = ""
    if kind.startswith("rule_"):
        try:
            index = int(kind.split("_", 1)[1]) - 1
        except ValueError:
            index = -1
        if index >= 0:
            try:
                from .component_catalog import ALLOWED_CONNECTION_RULES

                rule = ALLOWED_CONNECTION_RULES[index]
            except Exception:
                rule = None
            if rule is not None:
                label = str(getattr(rule, "label", "") or "")
                channel = str(getattr(rule, "channel", "") or "")
    return kind, label, channel


def _placement(raw: Any) -> tuple:
    if not isinstance(raw, dict):
        return (None, None, None, None, None, None)
    position_x = _optional_float(raw.get("x"))
    position_y = _optional_float(raw.get("y"))
    box = raw.get("box")
    numbers = [None, None, None, None]
    if isinstance(box, (list, tuple)) and len(box) == 4:
        parsed = [_optional_float(value) for value in box]
        if all(value is not None for value in parsed):
            numbers = parsed
    return (position_x, position_y, *numbers)


def _normalize_display_mode(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in {"acronyms", "acronym", "letters", "letter", "symbols", "symbol"}:
        return "acronyms"
    return "icons"


def _identity_view(item: dict, keys: tuple[str, ...]) -> dict:
    return {key: item.get(key) for key in keys}


def _component_geometry_view(item: dict) -> dict:
    """Identity plus any saved canvas position/box for restore."""
    record = _identity_view(item, _COMPONENT_IDENTITY_KEYS)
    box = item.get("box")
    if isinstance(box, (list, tuple)) and len(box) == 4:
        try:
            record["box"] = [float(value) for value in box]
        except (TypeError, ValueError):
            pass
    position = item.get("position")
    if isinstance(position, dict):
        record["position"] = {
            "x": position.get("x"),
            "y": position.get("y"),
        }
    if item.get("display_mode") is not None:
        record["display_mode"] = _normalize_display_mode(item.get("display_mode"))
    return record


def _override_from_component_record(item: dict) -> dict | None:
    """Build a manual_component_overrides entry from a stored component row."""
    if not isinstance(item, dict):
        return None
    box = item.get("box")
    position = item.get("position") if isinstance(item.get("position"), dict) else {}
    override: dict[str, Any] = {
        "restored": True,
        "moved": True,
        "display_mode": _normalize_display_mode(item.get("display_mode")),
    }
    if isinstance(box, (list, tuple)) and len(box) == 4:
        try:
            numbers = [float(value) for value in box]
        except (TypeError, ValueError):
            numbers = []
        if len(numbers) == 4 and numbers[2] > 0 and numbers[3] > 0:
            override["box"] = numbers
            override["x"] = numbers[0] + numbers[2] / 2.0
            override["y"] = numbers[1] + numbers[3] / 2.0
    if "box" not in override:
        x = _optional_float(position.get("x"))
        if x is None:
            x = _optional_float(item.get("x"))
        y = _optional_float(position.get("y"))
        if y is None:
            y = _optional_float(item.get("y"))
        if x is None or y is None:
            return None
        override["x"] = x
        override["y"] = y
        # Renderers apply only 4-tuple boxes. Synthesize one from the saved
        # center so Postgres-only restores do not fall back to catalog presets.
        width = _optional_float(item.get("box_width")) or 0.9
        height = _optional_float(item.get("box_height")) or 0.7
        if width <= 0:
            width = 0.9
        if height <= 0:
            height = 0.7
        override["box"] = [x - width / 2.0, y - height / 2.0, width, height]
    return override


def _merge_component_overrides(
    current: Any,
    stored: Any,
) -> dict[str, Any]:
    """Prefer live boxes; fill missing placements from PostgreSQL."""
    merged: dict[str, Any] = {}
    if isinstance(current, dict):
        for node_id, raw in current.items():
            if isinstance(raw, dict):
                merged[str(node_id)] = dict(raw)
    if not isinstance(stored, dict):
        return merged
    for node_id, raw in stored.items():
        if not isinstance(raw, dict):
            continue
        key = str(node_id)
        existing = merged.get(key)
        existing_box = (
            existing.get("box") if isinstance(existing, dict) else None
        )
        if isinstance(existing_box, (list, tuple)) and len(existing_box) == 4:
            if (
                isinstance(existing, dict)
                and not str(existing.get("display_mode") or "").strip()
                and str(raw.get("display_mode") or "").strip()
            ):
                existing["display_mode"] = _normalize_display_mode(
                    raw.get("display_mode")
                )
            continue
        merged[key] = dict(raw)
        merged[key]["restored"] = True
        merged[key]["moved"] = True
    return merged


def _site_record(snapshot: dict[str, Any]) -> dict[str, str] | None:
    site = snapshot.get("site_project")
    if not isinstance(site, dict):
        return None
    stable_id = _uuid_text(site.get("stable_id"))
    if stable_id is None:
        return None
    return {
        "stable_id": stable_id,
        "name": str(site.get("name") or "Site"),
    }


def _annotation_id(worksheet_stable_id: str, legacy_note_id: str) -> str:
    return str(
        uuid.uuid5(
            _ANNOTATION_NAMESPACE,
            f"{worksheet_stable_id}:{legacy_note_id}",
        )
    )


def _route_row_id(worksheet_stable_id: str, legacy_edge_id: str) -> str:
    return str(
        uuid.uuid5(
            _ROUTE_NAMESPACE,
            f"{worksheet_stable_id}:{legacy_edge_id}",
        )
    )


def _uuid_text(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        uuid.UUID(text)
    except ValueError:
        return None
    return text


def _optional_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _timestamp_text(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value or "")


def _load_local_env() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(override=False)


def _safe_error_text(exc: BaseException) -> str:
    text = f"{type(exc).__name__}: {exc}"
    password = os.environ.get("ITANK_POSTGRES_PASSWORD", "")
    if password:
        text = text.replace(password, "****")
    return text


def _load_json(value: Any, fallback: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def _json_ready(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_ready(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_ready(item) for item in value]
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    return str(value)


def main(argv: list[str] | None = None) -> int:
    """Copy one old SQLite file into PostgreSQL. This is not called by the app."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Copy the old SQLite project store into PostgreSQL."
    )
    parser.add_argument("sqlite_path", nargs="?", default=None)
    args = parser.parse_args(argv)
    try:
        path = Path(args.sqlite_path) if args.sqlite_path else None
        migrated = migrate_sqlite_to_postgres(path)
    except (ProjectStoreConfigError, ProjectStoreError) as exc:
        print(_safe_error_text(exc), file=sys.stderr)
        return 1
    print(f"Migrated {len(migrated)} site(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
