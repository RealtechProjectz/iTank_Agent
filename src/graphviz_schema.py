"""Cached Graphviz orthogonal layout for the live worksheet.

The chart is rebuilt from the active connection pairs. Identical graphs reuse
the last layout, so Streamlit reruns and widget traffic do not shell out to
``dot`` again.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from functools import lru_cache
from typing import Iterable

FLOW_BLUE = "#123DBD"
_LAYOUT_CACHE: dict[str, dict] = {}


def _dot_executable() -> str | None:
    configured = str(os.environ.get("GRAPHVIZ_DOT", "") or "").strip()
    if configured and os.path.isfile(configured):
        return configured
    found = shutil.which("dot")
    if found:
        return found
    for candidate in (
        r"C:\Program Files\Graphviz\bin\dot.exe",
        r"C:\Program Files (x86)\Graphviz\bin\dot.exe",
    ):
        if os.path.isfile(candidate):
            return candidate
    return None


def build_orthogonal_graph(nodes: list[tuple[str, str]], edges: list[tuple[str, str, str]]):
    """Compile a hierarchical Graphviz graph from the current pairs."""
    import graphviz

    graph = graphviz.Digraph(name="worksheet", engine="dot")
    graph.attr(
        splines="ortho",
        nodesep="0.6",
        ranksep="0.8",
        rankdir="LR",
        pad="0.2",
    )
    graph.attr(
        "node",
        shape="box",
        style="filled",
        fontname="Helvetica",
        color="#00f2fe",
        fillcolor="#172a45",
        fontcolor="#ffffff",
    )
    graph.attr("edge", penwidth="2.5", color=FLOW_BLUE)

    for node_id, label in nodes:
        graph.node(str(node_id), label=str(label or node_id))
    for edge_id, source, target in edges:
        graph.edge(str(source), str(target), key=str(edge_id))
    return graph


def _layout_signature(nodes, edges) -> str:
    payload = json.dumps(
        {"nodes": nodes, "edges": edges},
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _parse_plain(text: str) -> dict:
    """Parse ``dot -Tplain`` into node centers and edge polylines.

    Plain coordinates are inches with Y growing upward.
    """
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    bounds = (0.0, 0.0, 1.0, 1.0)
    for raw in text.splitlines():
        parts = raw.split()
        if not parts:
            continue
        kind = parts[0]
        if kind == "graph" and len(parts) >= 4:
            bounds = (0.0, 0.0, float(parts[2]), float(parts[3]))
        elif kind == "node" and len(parts) >= 6:
            nodes[parts[1]] = {
                "x": float(parts[2]),
                "y": float(parts[3]),
                "w": float(parts[4]),
                "h": float(parts[5]),
            }
        elif kind == "edge" and len(parts) >= 4:
            count = int(parts[3])
            coords = parts[4:4 + count * 2]
            points = [
                [float(coords[i]), float(coords[i + 1])]
                for i in range(0, len(coords) - 1, 2)
            ]
            edges.append({
                "source": parts[1],
                "target": parts[2],
                "points": points,
            })
    return {"bounds": bounds, "nodes": nodes, "edges": edges}


@lru_cache(maxsize=64)
def _render_plain(signature: str, dot_source: str) -> str | None:
    dot = _dot_executable()
    if not dot:
        return None
    try:
        import graphviz
    except Exception:
        return None
    try:
        return str(graphviz.Source(dot_source, engine="dot").pipe(format="plain").decode("utf-8"))
    except Exception:
        return None


def _to_canvas(x: float, y: float, bounds, canvas_width: float, canvas_height: float):
    _min_x, _min_y, width, height = bounds
    width = max(float(width), 0.1)
    height = max(float(height), 0.1)
    margin_x = canvas_width * 0.06
    margin_y = canvas_height * 0.08
    usable_w = max(canvas_width - 2 * margin_x, 0.1)
    usable_h = max(canvas_height - 2 * margin_y, 0.1)
    canvas_x = margin_x + (float(x) / width) * usable_w
    canvas_y = margin_y + ((height - float(y)) / height) * usable_h
    return canvas_x, canvas_y


def _face_center(box, toward_x: float, toward_y: float) -> list[float]:
    x, y, w, h = [float(v) for v in box]
    cx, cy = x + w / 2.0, y + h / 2.0
    dx, dy = toward_x - cx, toward_y - cy
    if abs(dx) >= abs(dy):
        return [x + w, cy] if dx >= 0 else [x, cy]
    return [x + w / 2.0, y + h] if dy >= 0 else [x + w / 2.0, y]


def _orthogonalize(points: list[list[float]]) -> list[list[float]]:
    if len(points) < 2:
        return points
    cleaned = [points[0]]
    for point in points[1:]:
        prev = cleaned[-1]
        if abs(point[0] - prev[0]) < 1e-6 and abs(point[1] - prev[1]) < 1e-6:
            continue
        if abs(point[0] - prev[0]) > 1e-6 and abs(point[1] - prev[1]) > 1e-6:
            cleaned.append([point[0], prev[1]])
        cleaned.append(point)
    return cleaned


def _snap_endpoints(points, source_box, target_box) -> list[list[float]]:
    if not points:
        return points
    start_hint = points[1] if len(points) > 1 else points[0]
    end_hint = points[-2] if len(points) > 1 else points[-1]
    start = _face_center(source_box, start_hint[0], start_hint[1])
    end = _face_center(target_box, end_hint[0], end_hint[1])
    middle = points[1:-1] if len(points) > 2 else []
    return _orthogonalize([start, *middle, end])


def layout_active_connections(
    nodes: Iterable[tuple[str, str]],
    edges: Iterable[tuple[str, str, str]],
    canvas_width: float,
    canvas_height: float,
) -> dict | None:
    """Return canvas boxes and orthogonal polylines for the active pairs.

    ``None`` means Graphviz is unavailable. Callers keep the existing routes.
    """
    node_list = [(str(node_id), str(label or node_id)) for node_id, label in nodes]
    edge_list = [
        (str(edge_id), str(source), str(target))
        for edge_id, source, target in edges
        if source and target
    ]
    node_list = sorted(set(node_list))
    edge_list = sorted(set(edge_list))
    if len(node_list) < 2 or not edge_list:
        return None

    signature = _layout_signature(node_list, edge_list)
    cached = _LAYOUT_CACHE.get(signature)
    if cached is not None:
        return cached

    if _dot_executable() is None:
        return None

    try:
        graph = build_orthogonal_graph(node_list, edge_list)
    except Exception:
        return None
    plain = _render_plain(signature, graph.source)
    if not plain:
        return None

    parsed = _parse_plain(plain)
    bounds = parsed["bounds"]
    boxes: dict[str, list[float]] = {}
    for node_id, node in parsed["nodes"].items():
        cx, cy = _to_canvas(node["x"], node["y"], bounds, canvas_width, canvas_height)
        width = max(0.9, min(1.6, float(node["w"])))
        height = max(0.7, min(1.2, float(node["h"])))
        boxes[node_id] = [cx - width / 2.0, cy - height / 2.0, width, height]

    routes: dict[str, list[list[float]]] = {}
    used: dict[tuple[str, str], int] = {}
    for edge in parsed["edges"]:
        pair = (edge["source"], edge["target"])
        index = used.get(pair, 0)
        used[pair] = index + 1
        matches = [
            edge_id
            for edge_id, source, target in edge_list
            if source == pair[0] and target == pair[1]
        ]
        if index >= len(matches):
            continue
        points = [
            list(_to_canvas(x, y, bounds, canvas_width, canvas_height))
            for x, y in edge["points"]
        ]
        source_box = boxes.get(pair[0])
        target_box = boxes.get(pair[1])
        if source_box and target_box and len(points) >= 2:
            points = _snap_endpoints(points, source_box, target_box)
        routes[matches[index]] = points

    result = {"boxes": boxes, "routes": routes}
    _LAYOUT_CACHE[signature] = result
    return result


def apply_worksheet_graph(
    routes: list[dict],
    box_map: dict,
    canvas_width: float,
    canvas_height: float,
    labels: dict[str, str],
    pinned_ids: Iterable[str] = (),
    manual_edge_ids: Iterable[str] = (),
) -> None:
    """Write the cached Graphviz layout into the live worksheet routes.

    Manual drag overrides are left untouched. A cache hit does no Graphviz work.
    """
    pinned = {str(node_id) for node_id in pinned_ids}
    manual = {str(edge_id) for edge_id in manual_edge_ids}
    active = []
    for route in routes:
        if not isinstance(route, dict) or route.get("hidden") or route.get("dotted"):
            continue
        source = str(route.get("source", "") or "")
        target = str(route.get("target", "") or "")
        edge_id = str(route.get("edge_id", "") or "")
        if not source or not target or not edge_id:
            continue
        active.append((edge_id, source, target))
    if not active:
        return

    node_ids = sorted({node for _edge, source, target in active for node in (source, target)})
    nodes = [(node_id, str(labels.get(node_id) or node_id)) for node_id in node_ids]
    layout = layout_active_connections(nodes, active, canvas_width, canvas_height)
    if not layout:
        return

    for node_id, graph_box in layout["boxes"].items():
        if node_id in pinned:
            continue
        current = box_map.get(node_id)
        cx = float(graph_box[0]) + float(graph_box[2]) / 2.0
        cy = float(graph_box[1]) + float(graph_box[3]) / 2.0
        if isinstance(current, (list, tuple)) and len(current) == 4:
            width, height = float(current[2]), float(current[3])
        else:
            width, height = float(graph_box[2]), float(graph_box[3])
        box_map[node_id] = [cx - width / 2.0, cy - height / 2.0, width, height]

    for route in routes:
        edge_id = str(route.get("edge_id", "") or "")
        if edge_id in manual or route.get("hidden") or route.get("dotted"):
            continue
        points = layout["routes"].get(edge_id)
        source_box = box_map.get(str(route.get("source", "") or ""))
        target_box = box_map.get(str(route.get("target", "") or ""))
        if not points or not source_box or not target_box:
            continue
        snapped = _snap_endpoints(points, source_box, target_box)
        if len(snapped) < 2:
            continue
        route["points"] = snapped
        route["original_points"] = [list(point) for point in snapped]
