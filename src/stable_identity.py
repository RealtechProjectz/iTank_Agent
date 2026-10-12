"""Permanent ids for worksheets, component instances, and connections.

Legacy ids stay in place:

- worksheet switching still uses the integer worksheet id
- components still use ``sump_1`` / ``oht_1`` node ids and ``Sump 1`` labels
- connections still use ``rule_N__...`` and ``pair__...`` ids

``stable_id`` values are UUIDs. They survive a diagram rebuild and the
deletion of a different instance. Old saved worksheets that have no stable
ids receive them on load; their existing legacy ids are left unchanged.
"""

from __future__ import annotations

import re
import uuid
from typing import Any, Iterable

_CONNECTION_ID_RE = re.compile(
    r"^(?P<kind>rule_\d+|pair)__(?P<source>.+?)__(?P<relation>to|link)__(?P<target>.+)$"
)


def new_stable_id() -> str:
    return str(uuid.uuid4())


def empty_site_project() -> dict[str, Any]:
    return {
        "stable_id": new_stable_id(),
        "name": "Site",
        "worksheet_stable_ids": [],
    }


def ensure_site_project(existing: Any) -> dict[str, Any]:
    """Return a site record, preserving a saved stable id when one exists."""
    if isinstance(existing, dict) and str(existing.get("stable_id") or "").strip():
        project = dict(existing)
        project["stable_id"] = str(project["stable_id"]).strip()
        project["name"] = str(project.get("name") or "Site")
        project["worksheet_stable_ids"] = [
            str(item)
            for item in list(project.get("worksheet_stable_ids") or [])
            if str(item or "").strip()
        ]
        return project
    return empty_site_project()


def ensure_worksheet_identity(sheet: dict) -> dict:
    """Add a permanent worksheet id without changing its integer id or name."""
    if not isinstance(sheet, dict):
        return sheet
    if not str(sheet.get("stable_id") or "").strip():
        sheet["stable_id"] = new_stable_id()
    else:
        sheet["stable_id"] = str(sheet["stable_id"]).strip()
    if not isinstance(sheet.get("component_instances"), list):
        sheet["component_instances"] = []
    if not isinstance(sheet.get("connection_identities"), list):
        sheet["connection_identities"] = []
    return sheet


def parse_legacy_connection_id(value: Any) -> dict[str, str] | None:
    """Recognize a current or saved rule_/pair_ connection id.

    ``edge__`` is accepted and removed. Anything else, including topology
    branch ids, is left untouched by returning None.
    """
    text = str(value or "").strip()
    if text.startswith("edge__"):
        text = text[6:]
    match = _CONNECTION_ID_RE.match(text)
    if match is None:
        return None
    return {
        "legacy_id": text,
        "kind": match.group("kind"),
        "source": match.group("source"),
        "relation": match.group("relation"),
        "target": match.group("target"),
    }


def _instances_for(selected_names: Iterable[str]):
    from .component_catalog import _selected_instances

    return _selected_instances(list(selected_names or []))


def _clean_records(records: Any) -> list[dict]:
    cleaned: list[dict] = []
    for item in list(records or []):
        if not isinstance(item, dict):
            continue
        name = str(item.get("catalog_name") or "").strip()
        if not name:
            continue
        cleaned.append(dict(item))
    return cleaned


def _drop_occurrence(
    records: list[dict],
    catalog_name: str,
    occurrence_index: int,
) -> tuple[list[dict], list[str]]:
    """Remove one already-counted occurrence and return its legacy node id."""
    kept: list[dict] = []
    removed: list[str] = []
    seen = 0
    for record in records:
        if str(record.get("catalog_name") or "") != catalog_name:
            kept.append(record)
            continue
        if seen == int(occurrence_index):
            legacy = str(record.get("legacy_node_id") or "").strip()
            if legacy:
                removed.append(legacy)
            seen += 1
            continue
        seen += 1
        kept.append(record)
    return kept, removed


def _drop_legacy_node_ids(
    records: list[dict],
    legacy_ids: Iterable[str],
) -> tuple[list[dict], list[str]]:
    """Remove component rows by exact legacy node id (e.g. ``lls_2`` only)."""
    banned = {
        str(node_id).strip()
        for node_id in list(legacy_ids or [])
        if str(node_id or "").strip()
    }
    if not banned:
        return list(records or []), []
    kept: list[dict] = []
    removed: list[str] = []
    for record in list(records or []):
        legacy = str(record.get("legacy_node_id") or "").strip()
        if legacy and legacy in banned:
            removed.append(legacy)
            continue
        kept.append(record)
    return kept, removed


def sync_worksheet_identities(
    sheet: dict,
    selected_names: Iterable[str],
    selected_connection_ids: Iterable[str],
    *,
    removed_occurrence: tuple[str, int] | None = None,
    removed_legacy_ids: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Attach permanent ids to the current component and connection lists.

    Returns node-id renames and removed node ids so session maps that still
    key on ``sump_1`` can follow a surviving instance. When nothing was
    renumbered the maps are empty and callers leave session state as it is.

    Prefer ``removed_legacy_ids`` (exact instance ids such as ``lls_2``) over
    index-based ``removed_occurrence``, which can drop the wrong sibling.
    """
    ensure_worksheet_identity(sheet)
    records = _clean_records(sheet.get("component_instances"))
    removed_node_ids: list[str] = []
    legacy_ban = {
        str(node_id).strip()
        for node_id in list(removed_legacy_ids or [])
        if str(node_id or "").strip()
    }
    if legacy_ban:
        records, removed_now = _drop_legacy_node_ids(records, legacy_ban)
        removed_node_ids.extend(removed_now)
    elif removed_occurrence is not None:
        catalog_name, occurrence_index = removed_occurrence
        records, removed_now = _drop_occurrence(
            records,
            str(catalog_name or "").strip(),
            int(occurrence_index),
        )
        removed_node_ids.extend(removed_now)

    grouped: dict[str, list[dict]] = {}
    for record in records:
        grouped.setdefault(str(record.get("catalog_name") or ""), []).append(record)

    instances = _instances_for(selected_names)
    cursors = {name: 0 for name in grouped}
    new_records: list[dict] = []
    renames: dict[str, str] = {}
    live_node_ids: set[str] = set()

    for instance in instances:
        name = instance.definition.name
        slots = grouped.get(name, [])
        cursor = cursors.get(name, 0)
        previous = slots[cursor] if cursor < len(slots) else None
        cursors[name] = cursor + 1
        stable_id = ""
        old_node_id = ""
        if isinstance(previous, dict):
            stable_id = str(previous.get("stable_id") or "").strip()
            old_node_id = str(previous.get("legacy_node_id") or "").strip()
        if not stable_id:
            stable_id = new_stable_id()
        new_node_id = instance.node_id
        live_node_ids.add(new_node_id)
        if old_node_id and old_node_id != new_node_id and old_node_id not in removed_node_ids:
            renames[old_node_id] = new_node_id
        record = {
            "stable_id": stable_id,
            "catalog_name": name,
            "legacy_node_id": new_node_id,
            "instance_index": int(instance.instance_index),
            "node_type": str(instance.definition.node_type or ""),
            "code": str(instance.definition.code or ""),
        }
        # Keep calibrated canvas geometry and presentation mode across identity
        # sync so a delete/rebuild cannot reset Acronym Box back to icons.
        if isinstance(previous, dict):
            previous_box = previous.get("box")
            if isinstance(previous_box, (list, tuple)) and len(previous_box) == 4:
                record["box"] = [float(value) for value in previous_box]
            previous_position = previous.get("position")
            if isinstance(previous_position, dict):
                record["position"] = dict(previous_position)
            elif "x" in previous or "y" in previous:
                record["position"] = {
                    "x": previous.get("x"),
                    "y": previous.get("y"),
                }
            previous_mode = str(previous.get("display_mode") or "").strip().lower()
            if previous_mode in {
                "acronyms",
                "acronym",
                "letters",
                "letter",
                "symbols",
                "symbol",
                "icons",
                "icon",
            }:
                record["display_mode"] = (
                    "acronyms"
                    if previous_mode
                    in {"acronyms", "acronym", "letters", "letter", "symbols", "symbol"}
                    else "icons"
                )
        new_records.append(record)

    selected_name_set = {
        str(name or "").strip()
        for name in list(selected_names or [])
        if str(name or "").strip()
    }
    scoped_delete = bool(legacy_ban)
    for name, slots in grouped.items():
        cursor = cursors.get(name, 0)
        leftovers = slots[cursor:]
        if not leftovers:
            continue
        # Scoped instance delete (exact legacy ids): only mark leftovers as
        # removed for catalog types still present in the selection. Types absent
        # from a partial selection snapshot are preserved so deleting lls_2
        # cannot cascade into Bore→SMC / OHT→LLS1 by treating SMC as removed.
        if scoped_delete and name not in selected_name_set:
            for record in leftovers:
                if isinstance(record, dict):
                    new_records.append(dict(record))
                    legacy = str(record.get("legacy_node_id") or "").strip()
                    if legacy:
                        live_node_ids.add(legacy)
            continue
        for record in leftovers:
            legacy = str(record.get("legacy_node_id") or "").strip()
            if legacy and legacy not in live_node_ids:
                removed_node_ids.append(legacy)

    # Drop uses the deleted instance's old node id. A survivor may be
    # renumbered onto that same string afterwards, so do not remove a rename
    # just because its new id collides with a deleted id.
    removed_set = {node_id for node_id in removed_node_ids if node_id}
    if scoped_delete:
        # Never expand a scoped delete beyond the explicit instance ids.
        removed_set = {node_id for node_id in removed_set if node_id in legacy_ban}
    renames = {
        old_id: new_id
        for old_id, new_id in renames.items()
        if old_id and new_id and old_id not in removed_set
    }

    sheet["component_instances"] = new_records
    rewritten_connections = rewrite_connection_id_list(
        list(selected_connection_ids or []),
        renames,
        removed_set,
    )
    sheet["connection_identities"] = _sync_connection_identities(
        sheet.get("connection_identities"),
        rewritten_connections,
        new_records,
    )
    return {
        "renames": renames,
        "removed_node_ids": sorted(removed_set),
        "selected_connections": rewritten_connections,
    }


def _endpoint_key(parsed: dict[str, str], node_to_stable: dict[str, str]) -> tuple[str, str, str] | None:
    source = node_to_stable.get(parsed["source"])
    target = node_to_stable.get(parsed["target"])
    if not source or not target:
        return None
    return (source, target, parsed["relation"])


def _sync_connection_identities(
    existing: Any,
    selected_connection_ids: list[str],
    component_records: list[dict],
) -> list[dict]:
    node_to_stable = {
        str(record.get("legacy_node_id") or ""): str(record.get("stable_id") or "")
        for record in component_records
        if str(record.get("legacy_node_id") or "") and str(record.get("stable_id") or "")
    }
    by_legacy: dict[str, dict] = {}
    by_endpoints: dict[tuple[str, str, str], dict] = {}
    for item in list(existing or []):
        if not isinstance(item, dict):
            continue
        stable_id = str(item.get("stable_id") or "").strip()
        legacy_id = str(item.get("legacy_id") or "").strip()
        if not stable_id or not legacy_id:
            continue
        record = dict(item)
        record["stable_id"] = stable_id
        by_legacy[legacy_id] = record
        source_stable = str(record.get("source_stable_id") or "")
        target_stable = str(record.get("target_stable_id") or "")
        relation = str(record.get("relation") or "to")
        if source_stable and target_stable:
            by_endpoints[(source_stable, target_stable, relation)] = record

    synced: list[dict] = []
    seen_legacy: set[str] = set()
    for raw_id in selected_connection_ids:
        parsed = parse_legacy_connection_id(raw_id)
        if parsed is None or parsed["legacy_id"] in seen_legacy:
            continue
        seen_legacy.add(parsed["legacy_id"])
        previous = by_legacy.get(parsed["legacy_id"])
        endpoint_key = _endpoint_key(parsed, node_to_stable)
        if previous is not None and endpoint_key is not None:
            previous_key = (
                str(previous.get("source_stable_id") or ""),
                str(previous.get("target_stable_id") or ""),
                str(previous.get("relation") or "to"),
            )
            # A renumbered survivor can reuse a deleted instance's legacy node
            # id. Match the permanent components in that case, not the old string.
            if previous_key != endpoint_key:
                previous = by_endpoints.get(endpoint_key)
        elif previous is None and endpoint_key is not None:
            previous = by_endpoints.get(endpoint_key)
        source_stable = node_to_stable.get(parsed["source"], "")
        target_stable = node_to_stable.get(parsed["target"], "")
        if not source_stable or not target_stable:
            continue
        stable_id = ""
        if isinstance(previous, dict):
            stable_id = str(previous.get("stable_id") or "").strip()
        if not stable_id:
            stable_id = new_stable_id()
        synced.append(
            {
                "stable_id": stable_id,
                "legacy_id": parsed["legacy_id"],
                "source_stable_id": source_stable,
                "target_stable_id": target_stable,
                "source_node_id": parsed["source"],
                "target_node_id": parsed["target"],
                "relation": parsed["relation"],
            }
        )
    return synced


def rewrite_connection_like(value: Any, renames: dict[str, str]) -> str:
    text = str(value or "").strip()
    prefix = ""
    body = text
    if body.startswith("edge__"):
        prefix = "edge__"
        body = body[6:]
    parsed = parse_legacy_connection_id(body)
    if parsed is None:
        return text
    source = renames.get(parsed["source"], parsed["source"])
    target = renames.get(parsed["target"], parsed["target"])
    return f"{prefix}{parsed['kind']}__{source}__{parsed['relation']}__{target}"


def connection_uses_node(value: Any, node_ids: set[str]) -> bool:
    if not node_ids:
        return False
    text = str(value or "").strip()
    if text in node_ids:
        return True
    parsed = parse_legacy_connection_id(text)
    if parsed is None:
        return False
    return parsed["source"] in node_ids or parsed["target"] in node_ids


def rewrite_connection_id_list(
    connection_ids: Iterable[str],
    renames: dict[str, str],
    removed_node_ids: set[str],
) -> list[str]:
    rewritten: list[str] = []
    seen: set[str] = set()
    for raw_id in list(connection_ids or []):
        text = str(raw_id or "").strip()
        if not text or connection_uses_node(text, removed_node_ids):
            continue
        text = rewrite_connection_like(text, renames)
        if text in seen:
            continue
        seen.add(text)
        rewritten.append(text)
    return rewritten


def _rewrite_keyed_map(
    mapping: Any,
    renames: dict[str, str],
    removed_node_ids: set[str],
    *,
    endpoint_fields: bool = False,
) -> dict:
    result: dict = {}
    for raw_key, raw_value in dict(mapping or {}).items():
        key = str(raw_key)
        if key.startswith("manual__"):
            parts = key[len("manual__"):].split("__", 1)
            if len(parts) == 2:
                source, target = parts
                if source in removed_node_ids or target in removed_node_ids:
                    continue
                key = (
                    f"manual__{renames.get(source, source)}"
                    f"__{renames.get(target, target)}"
                )
        value = raw_value
        if endpoint_fields and isinstance(raw_value, dict):
            source = str(raw_value.get("source") or "").strip()
            target = str(raw_value.get("target") or "").strip()
            # Prefer explicit endpoints over key-string matching so a shared
            # topology key cannot wipe an unrelated Bore→SMC / LLS1→OHT route.
            if source or target:
                if source in removed_node_ids or target in removed_node_ids:
                    continue
                value = dict(raw_value)
                if source in renames:
                    value["source"] = renames[source]
                if target in renames:
                    value["target"] = renames[target]
            elif key in removed_node_ids or connection_uses_node(key, removed_node_ids):
                continue
        elif key in removed_node_ids or connection_uses_node(key, removed_node_ids):
            continue
        if key in renames:
            new_key = renames[key]
        else:
            new_key = rewrite_connection_like(key, renames)
        if endpoint_fields and isinstance(value, dict) and "id" in value and str(value.get("id") or "") == key:
            value["id"] = new_key
        result[new_key] = value
    return result


def _rewrite_embed_list(embeds: Any, renames: dict[str, str], removed_node_ids: set[str]) -> list:
    rewritten = []
    for item in list(embeds or []):
        if not isinstance(item, dict):
            continue
        tank_id = str(item.get("tank_id") or "")
        sensor_id = str(item.get("sensor_id") or "")
        if tank_id in removed_node_ids or sensor_id in removed_node_ids:
            continue
        updated = dict(item)
        if tank_id in renames:
            updated["tank_id"] = renames[tank_id]
        if sensor_id in renames:
            updated["sensor_id"] = renames[sensor_id]
        rewritten.append(updated)
    return rewritten


def _rewrite_draw_pairs(pairs: Any, renames: dict[str, str], removed_node_ids: set[str]) -> dict:
    rewritten: dict = {}
    for raw_key, raw_value in dict(pairs or {}).items():
        source = ""
        target = ""
        if isinstance(raw_value, dict):
            source = str(raw_value.get("source") or "")
            target = str(raw_value.get("target") or "")
        if not source or not target:
            parts = str(raw_key).split("|", 1)
            if len(parts) == 2:
                source = source or parts[0]
                target = target or parts[1]
        if source in removed_node_ids or target in removed_node_ids:
            continue
        source = renames.get(source, source)
        target = renames.get(target, target)
        value = dict(raw_value) if isinstance(raw_value, dict) else raw_value
        if isinstance(value, dict):
            value["source"] = source
            value["target"] = target
        rewritten[f"{source}|{target}"] = value
    return rewritten


def apply_runtime_identity_maps(
    identity_result: dict[str, Any],
    *,
    selected_connections: list | None = None,
    connection_transport_settings: dict | None = None,
    route_overrides: dict | None = None,
    component_overrides: dict | None = None,
    deleted_connection_ids: list | None = None,
    explicit_connection_ids: list | None = None,
    oht_sensor_embeds: list | None = None,
    manual_draw_pairs: dict | None = None,
    canvas_components: dict | None = None,
    inline_flow_meter_settings: dict | None = None,
) -> dict[str, Any]:
    """Rewrite legacy node tokens inside the existing worksheet maps.

    Keys that do not use a node id or a rule_/pair_ connection id are copied
    through unchanged. Empty rename/removal results return the same containers.
    """
    renames = dict(identity_result.get("renames") or {})
    removed = set(identity_result.get("removed_node_ids") or [])
    if not renames and not removed:
        return {
            "selected_connections": list(selected_connections or []),
            "connection_transport_settings": dict(connection_transport_settings or {}),
            "route_overrides": dict(route_overrides or {}),
            "component_overrides": dict(component_overrides or {}),
            "deleted_connection_ids": list(deleted_connection_ids or []),
            "explicit_connection_ids": list(explicit_connection_ids or []),
            "oht_sensor_embeds": list(oht_sensor_embeds or []),
            "manual_draw_pairs": dict(manual_draw_pairs or {}),
            "canvas_components": dict(canvas_components or {}),
            "inline_flow_meter_settings": dict(inline_flow_meter_settings or {}),
            "changed": False,
        }

    next_connections = list(identity_result.get("selected_connections") or [])
    if not next_connections and selected_connections:
        next_connections = rewrite_connection_id_list(
            selected_connections,
            renames,
            removed,
        )
    canvas = _rewrite_keyed_map(canvas_components, renames, removed, endpoint_fields=True)
    return {
        "selected_connections": next_connections,
        "connection_transport_settings": _rewrite_keyed_map(
            connection_transport_settings,
            renames,
            removed,
        ),
        "route_overrides": _rewrite_keyed_map(
            route_overrides,
            renames,
            removed,
            endpoint_fields=True,
        ),
        "component_overrides": _rewrite_keyed_map(
            component_overrides,
            renames,
            removed,
            endpoint_fields=True,
        ),
        "deleted_connection_ids": rewrite_connection_id_list(
            list(deleted_connection_ids or []),
            renames,
            removed,
        ),
        "explicit_connection_ids": rewrite_connection_id_list(
            list(explicit_connection_ids or []),
            renames,
            removed,
        ),
        "oht_sensor_embeds": _rewrite_embed_list(oht_sensor_embeds, renames, removed),
        "manual_draw_pairs": _rewrite_draw_pairs(manual_draw_pairs, renames, removed),
        "canvas_components": canvas,
        "inline_flow_meter_settings": _rewrite_keyed_map(
            inline_flow_meter_settings,
            renames,
            removed,
        ),
        "changed": True,
    }


def assign_diagram_stable_ids(diagram, sheet: dict | None):
    """Copy stored permanent ids onto a diagram without changing routes.

    The returned diagram is a deep copy so a cached DiagramSpec is not mutated.
    Legacy ``node.id`` and ``edge.id`` / ``edge.source`` / ``edge.target`` stay
    exactly as the builder emitted them.
    """
    if diagram is None or not isinstance(sheet, dict):
        return diagram
    try:
        stamped = diagram.model_copy(deep=True)
    except Exception:
        return diagram

    node_ids = {
        str(record.get("legacy_node_id") or ""): str(record.get("stable_id") or "")
        for record in list(sheet.get("component_instances") or [])
        if isinstance(record, dict)
    }
    connections = {
        str(record.get("legacy_id") or ""): record
        for record in list(sheet.get("connection_identities") or [])
        if isinstance(record, dict) and str(record.get("legacy_id") or "")
    }
    for node in list(getattr(stamped, "nodes", []) or []):
        stable_id = node_ids.get(str(getattr(node, "id", "") or ""), "")
        if stable_id:
            node.stable_id = stable_id
    for edge in list(getattr(stamped, "edges", []) or []):
        source_id = str(getattr(edge, "source", "") or "")
        target_id = str(getattr(edge, "target", "") or "")
        edge.source_stable_id = node_ids.get(source_id, "") or str(
            getattr(edge, "source_stable_id", "") or ""
        )
        edge.target_stable_id = node_ids.get(target_id, "") or str(
            getattr(edge, "target_stable_id", "") or ""
        )
        legacy = ""
        for candidate in (
            getattr(edge, "logical_edge_id", ""),
            getattr(edge, "id", ""),
        ):
            parsed = parse_legacy_connection_id(candidate)
            if parsed is not None:
                legacy = parsed["legacy_id"]
                break
        record = connections.get(legacy)
        if isinstance(record, dict) and str(record.get("stable_id") or ""):
            edge.stable_id = str(record["stable_id"])
    return stamped


def refresh_site_worksheet_index(project: dict, worksheets: Iterable[dict]) -> dict:
    """Record worksheet stable ids in display order. Does not switch worksheets."""
    project = ensure_site_project(project)
    project["worksheet_stable_ids"] = [
        str(sheet.get("stable_id") or "")
        for sheet in list(worksheets or [])
        if isinstance(sheet, dict) and str(sheet.get("stable_id") or "").strip()
    ]
    return project
