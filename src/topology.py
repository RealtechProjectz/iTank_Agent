from __future__ import annotations

"""Rendering-independent topology normalization for generated diagrams.

The module deliberately knows nothing about component names, images or UI labels.
It operates on graph metadata only:

* ``topology_channel`` groups edges that belong to the same physical/logical
  connection family (process, sensor, control, communication, ...).
* ``NodeTopologyMeta.behavior == 'inline'`` marks a component that may sit in
  series on a channel before a downstream fan-out.
* fan-out is converted to a main line plus a distribution spine;
* fan-in is converted to a collection spine plus one final line;
* generated junction nodes are routing infrastructure, not user components.

This separation lets future component types participate without adding routing
``if component == ...`` statements.  New components only need catalog metadata.
"""

from collections import defaultdict
import math
from dataclasses import dataclass
from statistics import median
from typing import Iterable

from .models import DiagramEdge, DiagramNode, DiagramSpec


@dataclass(frozen=True)
class NodeTopologyMeta:
    behavior: str = "standard"
    inline_channel: str = ""
    layout_zone: str = "auto"
    stable_order: int = 0
    # Optional user placement intent for metadata-driven auto-inline devices.
    # Values are generic topology concepts rather than component names:
    #   automatic        -> choose the cleanest eligible branch automatically
    #   source_side      -> insert before a source fan-out / feeder
    #   destination_side -> insert on the selected/nearest terminal branch
    inline_placement: str = "automatic"
    inline_attach_id: str = ""


def _slug(value: str) -> str:
    chars: list[str] = []
    for char in str(value).lower():
        if char.isalnum():
            chars.append(char)
        elif chars and chars[-1] != "_":
            chars.append("_")
    return "".join(chars).strip("_") or "node"


def _clamp(value: float, lo: float = 0.025, hi: float = 0.975) -> float:
    return min(hi, max(lo, float(value)))


def _edge_channel(edge: DiagramEdge) -> str:
    # Empty channels intentionally remain isolated so sketch/AI edges are not
    # grouped accidentally.  Component Selection rules set explicit channels.
    value = str(getattr(edge, "topology_channel", "") or "").strip()
    return value


def _directed_edge(edge: DiagramEdge) -> DiagramEdge:
    """Return a source->target representation without changing unknown links."""
    if edge.direction != "target_to_source":
        return edge
    return edge.model_copy(
        update={
            "source": edge.target,
            "target": edge.source,
            "direction": "source_to_target",
            "source_side": edge.target_side,
            "target_side": edge.source_side,
            "source_anchor": edge.target_anchor,
            "target_anchor": edge.source_anchor,
        }
    )


def _clone_edge(
    edge: DiagramEdge,
    *,
    edge_id: str,
    source: str,
    target: str,
    label: str | None = None,
    role: str,
    logical_edge_id: str | None = None,
) -> DiagramEdge:
    return edge.model_copy(
        update={
            "id": edge_id,
            "source": source,
            "target": target,
            "label": edge.label if label is None else label,
            "direction": "source_to_target",
            "source_side": None,
            "target_side": None,
            "source_anchor": None,
            "target_anchor": None,
            "waypoints": [],
            "locked_route": True,
            "route_hint": "direct",
            "topology_role": role,
            "logical_edge_id": logical_edge_id or edge.logical_edge_id or edge.id,
        }
    )


def _node_sort_key(node_id: str, metadata: dict[str, NodeTopologyMeta]) -> tuple:
    meta = metadata.get(node_id, NodeTopologyMeta())
    return (meta.stable_order, node_id)


def _make_junction(
    *,
    junction_id: str,
    x: float,
    y: float,
    role: str,
    channel: str,
) -> DiagramNode:
    return DiagramNode(
        id=junction_id,
        label="",
        node_type="junction",
        x=_clamp(x),
        y=_clamp(y),
        width=0.02,
        height=0.02,
        details=[f"TopologyRole: {role}", f"Channel: {channel}"],
        topology_role=role,
        layout_zone="auto",
        confidence=1.0,
    )


def _common_label(edges: Iterable[DiagramEdge]) -> str:
    labels = [str(edge.label or "").strip() for edge in edges]
    labels = [value for value in labels if value]
    if not labels:
        return ""
    first = labels[0]
    return first if all(value == first for value in labels) else ""


def _distribution_points(
    source_node: DiagramNode,
    target_nodes: list[DiagramNode],
) -> list[tuple[float, float]]:
    """Create a clean reference-style manifold through a target field.

    This rule is universal and component-independent.  The target geometry decides
    whether the manifold is horizontal or vertical.  The trunk sits on the side
    of the target row or column that faces the feeder, with a short branch into
    each destination and one elbow from the feeder into that trunk.
    """
    if not target_nodes:
        return []

    xs = [float(node.x) for node in target_nodes]
    ys = [float(node.y) for node in target_nodes]
    x_span = max(xs) - min(xs) if len(xs) > 1 else 0.0
    y_span = max(ys) - min(ys) if len(ys) > 1 else 0.0
    # Fixed reference-standard trunk offset. Branch count must not change the
    # connection grammar; larger fan-outs receive more physical canvas width
    # instead of a different manifold offset or wrapping pattern.
    clearance = 0.120

    if x_span >= y_span:
        ordered = sorted(target_nodes, key=lambda node: (node.x, node.y, node.id))
        target_y = median([float(node.y) for node in ordered])
        source_y = float(source_node.y)
        # Keep the trunk between the target row and the feeder, so each branch
        # is a short drop and the feeder meets that trunk with one elbow.
        toward = 1.0 if source_y >= target_y else -1.0
        trunk_y = _clamp(target_y + toward * clearance)
        return [(_clamp(float(node.x)), trunk_y) for node in ordered]

    ordered = sorted(target_nodes, key=lambda node: (node.y, node.x, node.id))
    target_x = median([float(node.x) for node in ordered])
    source_x = float(source_node.x)
    toward = 1.0 if source_x >= target_x else -1.0
    trunk_x = _clamp(target_x + toward * clearance)
    return [(trunk_x, _clamp(float(node.y))) for node in ordered]


def _collection_points(
    source_nodes: list[DiagramNode],
    target_node: DiagramNode,
) -> list[tuple[float, float]]:
    if not source_nodes:
        return []
    xs = [float(node.x) for node in source_nodes]
    ys = [float(node.y) for node in source_nodes]
    x_span = max(xs) - min(xs) if len(xs) > 1 else 0.0
    y_span = max(ys) - min(ys) if len(ys) > 1 else 0.0

    if x_span >= y_span:
        ordered = sorted(source_nodes, key=lambda node: (node.x, node.y, node.id))
        source_y = median([float(node.y) for node in ordered])
        target_y = float(target_node.y)
        offset = 0.055 if source_y <= target_y else -0.055
        trunk_y = _clamp(source_y + offset)
        return [(_clamp(float(node.x)), trunk_y) for node in ordered]

    ordered = sorted(source_nodes, key=lambda node: (node.y, node.x, node.id))
    source_x = median([float(node.x) for node in ordered])
    target_x = float(target_node.x)
    offset = 0.055 if source_x <= target_x else -0.055
    trunk_x = _clamp(source_x + offset)
    return [(trunk_x, _clamp(float(node.y))) for node in ordered]


def _dedupe_edges(edges: list[DiagramEdge]) -> list[DiagramEdge]:
    result: list[DiagramEdge] = []
    seen: set[tuple] = set()
    for edge in edges:
        key = (
            edge.source,
            edge.target,
            edge.direction,
            _edge_channel(edge),
            str(getattr(edge, "topology_role", "") or ""),
            str(edge.label or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        result.append(edge)
    return result


def _apply_inline_series(
    edges: list[DiagramEdge],
    metadata: dict[str, NodeTopologyMeta],
) -> list[DiagramEdge]:
    """Move same-channel fan-out behind explicitly metadata-marked inline nodes."""
    grouped: dict[tuple[str, str], list[DiagramEdge]] = defaultdict(list)
    untouched: list[DiagramEdge] = []

    for raw_edge in edges:
        edge = _directed_edge(raw_edge)
        channel = _edge_channel(edge)
        if edge.direction == "unknown" or not channel:
            untouched.append(raw_edge)
            continue
        grouped[(edge.source, channel)].append(edge)

    result: list[DiagramEdge] = list(untouched)
    for (source_id, channel), group in grouped.items():
        if len(group) <= 1:
            result.extend(group)
            continue

        inline_edges = [
            edge for edge in group
            if metadata.get(edge.target, NodeTopologyMeta()).behavior == "inline"
        ]
        payload_edges = [edge for edge in group if edge not in inline_edges]

        # Only infer a series gateway when there is something downstream to feed.
        # Parallel selections made entirely of inline devices remain parallel.
        if not inline_edges or not payload_edges:
            result.extend(group)
            continue

        inline_edges.sort(key=lambda edge: _node_sort_key(edge.target, metadata))
        previous = source_id
        for index, edge in enumerate(inline_edges):
            result.append(
                _clone_edge(
                    edge,
                    edge_id=f"series__{_slug(source_id)}__{_slug(channel)}__{index + 1}",
                    source=previous,
                    target=edge.target,
                    role="series",
                )
            )
            previous = edge.target

        for edge in payload_edges:
            result.append(
                _clone_edge(
                    edge,
                    edge_id=f"series_payload__{_slug(edge.id)}",
                    source=previous,
                    target=edge.target,
                    role="logical",
                )
            )

    return _dedupe_edges(result)



def _apply_auto_inline_components(
    nodes: list[DiagramNode],
    edges: list[DiagramEdge],
    metadata: dict[str, NodeTopologyMeta],
) -> list[DiagramEdge]:
    """Insert metadata-marked devices into real channel paths.

    The implementation is topology-driven and independent of component names.
    ``inline_placement`` can optionally guide where an auto-inline item goes:

    * ``source_side`` inserts the item once in the feeder before a fan-out;
    * ``destination_side`` inserts it on one terminal/load branch;
    * ``automatic`` preserves the existing nearest/terminal distribution logic.

    Multiple destination-side items are spread across distinct terminal branches
    before any branch receives a second inline item. This is what keeps many Tank
    branches clean while remaining reusable for any future inline device/load.
    """
    if not nodes or not edges:
        return edges

    node_lookup = {node.id: node for node in nodes}
    channel_inline_nodes: dict[str, list[str]] = defaultdict(list)
    for node_id, meta in metadata.items():
        channel = str(meta.inline_channel or "").strip()
        if meta.behavior == "auto_inline" and channel and node_id in node_lookup:
            # Flow meters and motorized valves stay unconnected until the user
            # explicitly selects the second component of the pair.
            if _piping_role(node_lookup[node_id]) in {"fm", "mv"}:
                continue
            channel_inline_nodes[channel].append(node_id)

    if not channel_inline_nodes:
        return edges

    result = list(edges)

    def directed_channel_edges(channel: str) -> list[DiagramEdge]:
        values: list[DiagramEdge] = []
        for raw in result:
            edge = _directed_edge(raw)
            if edge.direction == "unknown" or _edge_channel(edge) != channel:
                continue
            if edge.source not in node_lookup or edge.target not in node_lookup:
                continue
            if node_lookup[edge.source].node_type == "junction" or node_lookup[edge.target].node_type == "junction":
                continue
            values.append(edge)
        return values

    def weak_components(channel_edges: list[DiagramEdge]) -> list[set[str]]:
        adjacency: dict[str, set[str]] = defaultdict(set)
        ids: set[str] = set()
        for edge in channel_edges:
            ids.update((edge.source, edge.target))
            adjacency[edge.source].add(edge.target)
            adjacency[edge.target].add(edge.source)
        components: list[set[str]] = []
        remaining = set(ids)
        while remaining:
            seed = min(remaining, key=lambda node_id: _node_sort_key(node_id, metadata))
            remaining.remove(seed)
            stack = [seed]
            component: set[str] = set()
            while stack:
                current = stack.pop()
                component.add(current)
                for neighbour in adjacency.get(current, set()):
                    if neighbour in remaining:
                        remaining.remove(neighbour)
                        stack.append(neighbour)
            components.append(component)
        components.sort(
            key=lambda ids: min((_node_sort_key(node_id, metadata) for node_id in ids), default=(999999, ""))
        )
        return components

    def insert_source_side_chain(
        channel: str,
        inline_ids: list[str],
        channel_edges: list[DiagramEdge],
    ) -> set[str]:
        """Insert source-side inline items before a selected feeder fan-out."""
        if not inline_ids or not channel_edges:
            return set()

        indegree: dict[str, int] = defaultdict(int)
        outgoing: dict[str, list[DiagramEdge]] = defaultdict(list)
        for edge in channel_edges:
            indegree[edge.target] += 1
            indegree.setdefault(edge.source, indegree.get(edge.source, 0))
            outgoing[edge.source].append(edge)

        source_candidates = [node_id for node_id, outs in outgoing.items() if outs]
        root_candidates = [node_id for node_id in source_candidates if indegree.get(node_id, 0) == 0]
        if root_candidates:
            source_candidates = root_candidates
        source_candidates.sort(key=lambda node_id: _node_sort_key(node_id, metadata))
        if not source_candidates:
            return set()

        grouped: dict[str, list[str]] = defaultdict(list)
        for inline_id in inline_ids:
            meta = metadata.get(inline_id, NodeTopologyMeta())
            requested = str(meta.inline_attach_id or "").strip()
            # Explicit source attachment is generic: any selected process source
            # (including Well -> OHT) is handled exactly like every other feeder.
            if requested in outgoing:
                source_id = requested
            else:
                node = node_lookup[inline_id]
                source_id = min(
                    source_candidates,
                    key=lambda candidate: (
                        ((float(node_lookup[candidate].x) - float(node.x)) ** 2
                         + (float(node_lookup[candidate].y) - float(node.y)) ** 2) ** 0.5,
                        _node_sort_key(candidate, metadata),
                    ),
                )
            grouped[source_id].append(inline_id)

        inserted: set[str] = set()
        nonlocal_result = list(result)
        for source_id, meter_ids in grouped.items():
            host_edges = [edge for edge in directed_channel_edges(channel) if edge.source == source_id]
            if not host_edges:
                continue
            meter_ids.sort(key=lambda node_id: _node_sort_key(node_id, metadata))
            template = host_edges[0]
            logical_ids = "|".join(sorted(edge.logical_edge_id or edge.id for edge in host_edges))

            replacement: list[DiagramEdge] = []
            previous = source_id
            for index, inline_id in enumerate(meter_ids, start=1):
                replacement.append(
                    _clone_edge(
                        template,
                        edge_id=f"auto_inline_source__{_slug(source_id)}__{_slug(channel)}__{index}",
                        source=previous,
                        target=inline_id,
                        label=template.label if index == 1 else "",
                        role="series",
                        logical_edge_id=logical_ids,
                    )
                )
                previous = inline_id
                inserted.add(inline_id)

            for edge in host_edges:
                replacement.append(
                    _clone_edge(
                        edge,
                        edge_id=f"auto_inline_source_payload__{_slug(edge.id)}",
                        source=previous,
                        target=edge.target,
                        label="",
                        role="logical",
                        logical_edge_id=edge.logical_edge_id or edge.id,
                    )
                )

            host_ids = {edge.id for edge in host_edges}
            next_values: list[DiagramEdge] = []
            for raw in nonlocal_result:
                directed = _directed_edge(raw)
                if directed.id in host_ids:
                    continue
                next_values.append(raw)
            next_values.extend(replacement)
            nonlocal_result = _dedupe_edges(next_values)

        if inserted:
            result[:] = nonlocal_result
        return inserted

    for channel, inline_ids in channel_inline_nodes.items():
        channel_edges = directed_channel_edges(channel)
        if not channel_edges:
            continue

        participating = {
            endpoint
            for edge in channel_edges
            for endpoint in (edge.source, edge.target)
        }
        pending = [node_id for node_id in inline_ids if node_id not in participating]
        if not pending:
            continue
        pending.sort(key=lambda node_id: _node_sort_key(node_id, metadata))

        source_side_ids = [
            node_id for node_id in pending
            if metadata.get(node_id, NodeTopologyMeta()).inline_placement == "source_side"
        ]
        inserted_source = insert_source_side_chain(channel, source_side_ids, channel_edges)
        pending = [node_id for node_id in pending if node_id not in inserted_source]
        if not pending:
            continue

        channel_edges = directed_channel_edges(channel)
        components = weak_components(channel_edges)
        if not components:
            continue

        component_edges: list[list[DiagramEdge]] = [
            [edge for edge in channel_edges if edge.source in ids and edge.target in ids]
            for ids in components
        ]
        component_centers: list[tuple[float, float]] = []
        for ids in components:
            xs = [float(node_lookup[node_id].x) for node_id in ids]
            ys = [float(node_lookup[node_id].y) for node_id in ids]
            component_centers.append((sum(xs) / len(xs), sum(ys) / len(ys)))

        assignments: list[list[str]] = [[] for _ in components]
        if len(components) == 1:
            assignments[0].extend(pending)
        else:
            for node_id in pending:
                meta = metadata.get(node_id, NodeTopologyMeta())
                requested = str(meta.inline_attach_id or "").strip()
                requested_component = next(
                    (index for index, ids in enumerate(components) if requested and requested in ids),
                    None,
                )
                if requested_component is not None:
                    assignments[requested_component].append(node_id)
                    continue
                node = node_lookup[node_id]
                best_index = min(
                    range(len(components)),
                    key=lambda index: (
                        len(assignments[index]) * 0.18
                        + ((float(node.x) - component_centers[index][0]) ** 2
                           + (float(node.y) - component_centers[index][1]) ** 2) ** 0.5,
                        index,
                    ),
                )
                assignments[best_index].append(node_id)

        replacements_by_host_id: dict[str, list[DiagramEdge]] = {}

        for comp_index, assigned_inline in enumerate(assignments):
            if not assigned_inline:
                continue
            candidates = list(component_edges[comp_index])
            if not candidates:
                continue

            outdegree: dict[str, int] = defaultdict(int)
            indegree: dict[str, int] = defaultdict(int)
            outgoing: dict[str, list[str]] = defaultdict(list)
            for edge in candidates:
                outdegree[edge.source] += 1
                indegree[edge.target] += 1
                outgoing[edge.source].append(edge.target)
                indegree.setdefault(edge.source, indegree.get(edge.source, 0))
                outdegree.setdefault(edge.target, outdegree.get(edge.target, 0))

            terminal_edges = [edge for edge in candidates if outdegree.get(edge.target, 0) == 0]
            preferred_hosts = terminal_edges or candidates
            used_count: dict[str, int] = defaultdict(int)
            host_assignments: dict[str, list[str]] = defaultdict(list)

            for node_id in sorted(assigned_inline, key=lambda nid: _node_sort_key(nid, metadata)):
                node = node_lookup[node_id]
                meta = metadata.get(node_id, NodeTopologyMeta())
                requested = str(meta.inline_attach_id or "").strip()

                eligible = preferred_hosts
                if meta.inline_placement == "destination_side" and requested:
                    explicit = [edge for edge in terminal_edges if edge.target == requested]
                    if explicit:
                        eligible = explicit
                elif meta.inline_placement == "destination_side":
                    eligible = terminal_edges or preferred_hosts

                def host_score(edge: DiagramEdge) -> tuple:
                    source_node = node_lookup[edge.source]
                    target_node = node_lookup[edge.target]
                    mid_x = (float(source_node.x) + float(target_node.x)) / 2.0
                    mid_y = (float(source_node.y) + float(target_node.y)) / 2.0
                    distance = ((mid_x - float(node.x)) ** 2 + (mid_y - float(node.y)) ** 2) ** 0.5
                    # Spread meters across distinct branches before serial stacking.
                    return (
                        used_count[edge.id],
                        distance,
                        _node_sort_key(edge.target, metadata),
                        edge.id,
                    )

                best_host = min(eligible, key=host_score)
                host_assignments[best_host.id].append(node_id)
                used_count[best_host.id] += 1

            for host in candidates:
                assigned_here = host_assignments.get(host.id, [])
                if not assigned_here:
                    continue
                previous = host.source
                logical_id = host.logical_edge_id or host.id
                replacement: list[DiagramEdge] = []
                ordered_inline = sorted(assigned_here, key=lambda node_id: _node_sort_key(node_id, metadata))
                for index, inline_id in enumerate(ordered_inline, start=1):
                    replacement.append(
                        _clone_edge(
                            host,
                            edge_id=f"auto_inline__{_slug(logical_id)}__{_slug(host.id)}__{index}",
                            source=previous,
                            target=inline_id,
                            label=host.label if index == 1 else "",
                            role="series",
                            logical_edge_id=logical_id,
                        )
                    )
                    previous = inline_id
                replacement.append(
                    _clone_edge(
                        host,
                        edge_id=f"auto_inline__{_slug(logical_id)}__{_slug(host.id)}__out",
                        source=previous,
                        target=host.target,
                        label="" if ordered_inline else host.label,
                        role="series",
                        logical_edge_id=logical_id,
                    )
                )
                replacements_by_host_id[host.id] = replacement

        if replacements_by_host_id:
            next_result: list[DiagramEdge] = []
            for raw in result:
                directed = _directed_edge(raw)
                if directed.id in replacements_by_host_id:
                    continue
                next_result.append(raw)
            for replacement in replacements_by_host_id.values():
                next_result.extend(replacement)
            result = _dedupe_edges(next_result)

    return _dedupe_edges(result)

def _position_inline_gateways(
    nodes: list[DiagramNode],
    edges: list[DiagramEdge],
    metadata: dict[str, NodeTopologyMeta],
) -> list[DiagramNode]:
    """Place inferred inline gateways between their upstream source and load field.

    This is graph-role based, not component-name based.  Any future catalog item
    marked ``behavior='inline'`` receives the same treatment.
    """
    node_lookup = {node.id: node for node in nodes}
    updated = dict(node_lookup)

    series_edges = [edge for edge in edges if edge.topology_role == "series"]
    for edge in series_edges:
        target_meta = metadata.get(edge.target, NodeTopologyMeta())
        if target_meta.behavior not in {"inline", "auto_inline"}:
            continue
        source_node = updated.get(edge.source)
        target_node = updated.get(edge.target)
        if source_node is None or target_node is None:
            continue
        channel = _edge_channel(edge)
        downstream_ids = [
            candidate.target
            for candidate in edges
            if candidate.source == edge.target
            and _edge_channel(candidate) == channel
            and candidate.target in updated
            and candidate.target != edge.source
        ]
        if not downstream_ids:
            continue

        downstream_nodes = [updated[node_id] for node_id in downstream_ids]
        cx = sum(float(node.x) for node in downstream_nodes) / len(downstream_nodes)
        cy = sum(float(node.y) for node in downstream_nodes) / len(downstream_nodes)
        sx = float(source_node.x)
        sy = float(source_node.y)

        placement = str(target_meta.inline_placement or "automatic").strip().lower()
        ratio = 0.36
        if placement == "destination_side":
            ratio = 0.72
        elif placement == "source_side":
            ratio = 0.30

        px = sx + (cx - sx) * ratio
        py = sy + (cy - sy) * ratio

        # For explicit placement intent, align the inline device on the dominant
        # feeder/load axis.  This keeps a tank-side meter directly on that tank's
        # pipe instead of drifting diagonally between branches.  Automatic mode
        # preserves the existing placement behavior.
        if placement in {"source_side", "destination_side"}:
            if abs(cy - sy) >= abs(cx - sx):
                if placement == "destination_side" and len(downstream_nodes) == 1:
                    px = float(downstream_nodes[0].x)
                elif placement == "source_side":
                    px = sx
            else:
                if placement == "destination_side" and len(downstream_nodes) == 1:
                    py = float(downstream_nodes[0].y)
                elif placement == "source_side":
                    py = sy

        updated[edge.target] = target_node.model_copy(
            update={"x": _clamp(px), "y": _clamp(py)}
        )

    return [updated[node.id] for node in nodes]


def _reserve_reference_riser_clearance(
    nodes: list[DiagramNode],
    edges: list[DiagramEdge],
    metadata: dict[str, NodeTopologyMeta],
) -> list[DiagramNode]:
    """Reserve a small overhead routing corridor for bottom-source water links.

    The fixed reference pattern is: bottom source -> vertical riser -> horizontal
    overhead run -> downward entry into the upper destination. If a destination
    has been placed too close to the top content boundary, there is physically no
    room for that final downward entry. This pass only moves such an upper load
    down enough to preserve the existing reference connection pattern.

    The rule is metadata/channel/geometry based and does not check component names.
    """
    if not nodes or not edges:
        return nodes
    lookup = {node.id: node for node in nodes}
    updated = dict(lookup)
    min_target_y = 0.245
    process_channels = {"process", "water", "hydraulic", "fluid"}

    for raw_edge in edges:
        edge = _directed_edge(raw_edge)
        if edge.direction == "unknown" or _edge_channel(edge).lower() not in process_channels:
            continue
        source = updated.get(edge.source)
        target = updated.get(edge.target)
        if source is None or target is None or target.node_type == "junction":
            continue
        source_meta = metadata.get(edge.source, NodeTopologyMeta())
        if source_meta.layout_zone != "fixed_bottom_source":
            continue
        if float(target.y) >= float(source.y) - 0.08:
            continue
        if float(target.y) < min_target_y:
            updated[target.id] = target.model_copy(update={"y": min_target_y})

    return [updated[node.id] for node in nodes]


def _stabilize_large_fanout_layout(
    nodes: list[DiagramNode],
    edges: list[DiagramEdge],
    metadata: dict[str, NodeTopologyMeta],
    *,
    threshold: int = 6,
) -> list[DiagramNode]:
    """Preserve one fixed reference-style fan-out structure at every scale.

    Small fan-outs already use the desired reference structure, so they are left
    untouched.  For large fan-outs this pass only *extends the same structure*:

    * a source-to-load field that is mainly vertical keeps every branch root on
      one horizontal band (one manifold + independent vertical drops/rises);
    * a source-to-load field that is mainly horizontal keeps every branch root on
      one vertical band (one manifold + independent horizontal branches);
    * the complete private subgraph owned by each branch is translated together,
      so a Tank and its Flow Meter / Transmitter / Sensor children remain grouped;
    * the algorithm never switches to a grid or another visual grammar merely
      because the number of branches increases.

    The rule is topology/geometry based and therefore applies to future component
    types without checking names such as Sump, Well, Tank, Bore or Flow Meter.
    """
    if len(nodes) < threshold or not edges:
        return nodes

    node_lookup = {node.id: node for node in nodes}
    directed_edges = [
        _directed_edge(edge)
        for edge in edges
        if edge.direction != "unknown"
        and _edge_channel(edge)
        and edge.source in node_lookup
        and edge.target in node_lookup
        and node_lookup[edge.source].node_type != "junction"
        and node_lookup[edge.target].node_type != "junction"
    ]
    if not directed_edges:
        return nodes

    outgoing: dict[str, list[DiagramEdge]] = defaultdict(list)
    for edge in directed_edges:
        outgoing[edge.source].append(edge)

    fanouts: list[tuple[str, str, list[str]]] = []
    for source_id, source_edges in outgoing.items():
        by_channel: dict[str, list[str]] = defaultdict(list)
        for edge in source_edges:
            by_channel[_edge_channel(edge)].append(edge.target)
        for channel, targets in by_channel.items():
            unique_targets = sorted(
                set(targets),
                key=lambda node_id: _node_sort_key(node_id, metadata),
            )
            if len(unique_targets) >= threshold:
                fanouts.append((source_id, channel, unique_targets))

    if not fanouts:
        return nodes

    fanouts.sort(key=lambda item: (-len(item[2]), _node_sort_key(item[0], metadata), item[1]))
    updated = dict(node_lookup)
    moved_global: set[str] = set()

    for source_id, _channel, branch_roots in fanouts:
        if source_id not in updated:
            continue
        branch_root_set = set(branch_roots)

        # Determine the private downstream subgraph owned by each branch. Shared
        # nodes are deliberately not moved so collectors/controllers common to
        # several branches retain their existing global position.
        reach_by_root: dict[str, set[str]] = {}
        owner_count: dict[str, int] = defaultdict(int)
        for root_id in branch_roots:
            reached: set[str] = {root_id}
            stack: list[tuple[str, int]] = [(root_id, 0)]
            while stack:
                current, depth = stack.pop()
                if depth >= 6:
                    continue
                for edge in outgoing.get(current, []):
                    target_id = edge.target
                    if target_id == source_id:
                        continue
                    if target_id in branch_root_set and target_id != root_id:
                        continue
                    target_node = updated.get(target_id)
                    if target_node is None or target_node.node_type == "junction":
                        continue
                    if target_id in reached:
                        continue
                    reached.add(target_id)
                    stack.append((target_id, depth + 1))
            reach_by_root[root_id] = reached
            for node_id in reached:
                owner_count[node_id] += 1

        clusters: list[tuple[str, list[str], tuple[float, float, float, float]]] = []
        for root_id in branch_roots:
            owned = [
                node_id
                for node_id in reach_by_root[root_id]
                if owner_count[node_id] == 1 and node_id not in moved_global
            ]
            if root_id not in owned:
                owned.append(root_id)
            owned = sorted(set(owned), key=lambda node_id: _node_sort_key(node_id, metadata))
            xs = [float(updated[node_id].x) for node_id in owned if node_id in updated]
            ys = [float(updated[node_id].y) for node_id in owned if node_id in updated]
            if xs and ys:
                clusters.append((root_id, owned, (min(xs), min(ys), max(xs), max(ys))))

        if len(clusters) < threshold:
            continue

        source_node = updated[source_id]
        root_xs = [float(updated[root_id].x) for root_id, _owned, _box in clusters]
        root_ys = [float(updated[root_id].y) for root_id, _owned, _box in clusters]
        target_cx = sum(root_xs) / len(root_xs)
        target_cy = sum(root_ys) / len(root_ys)
        dx = target_cx - float(source_node.x)
        dy = target_cy - float(source_node.y)

        # Fixed reference standard: a source/input unit in the fixed-bottom band
        # feeding an upper load field always uses one upward riser plus one
        # horizontal overhead manifold. This is metadata-driven rather than tied
        # to Sump/Well/Bore/Tank names, so future source/load concepts inherit the
        # exact same connection-line structure automatically.
        source_meta = metadata.get(source_id, NodeTopologyMeta())
        roots_are_above = all(
            float(updated[root_id].y) < float(source_node.y)
            for root_id in branch_roots
        )
        reference_bottom_feeder = (
            source_meta.layout_zone == "fixed_bottom_source"
            and roots_are_above
        )
        vertical_feeder = reference_bottom_feeder or abs(dy) >= abs(dx)
        # Preserve deterministic logical branch order. The number of branches
        # never changes the visual grammar or reorders repeated destinations.
        ordered_clusters = sorted(
            clusters,
            key=lambda item: _node_sort_key(item[0], metadata),
        )

        if vertical_feeder:
            # One row forever: increasing branch count expands the physical canvas
            # in renderers.py rather than wrapping the targets into a new pattern.
            # In the fixed reference source-riser pattern, leave a clear left
            # routing gutter between the bottom source and the first upper load.
            # Other fan-outs keep their existing spacing.
            x_lo, x_hi = (0.18, 0.92) if reference_bottom_feeder else (0.10, 0.92)
            row_y = median(root_ys)
            if abs(float(source_node.y) - row_y) < 0.12:
                row_y = _clamp(float(source_node.y) - 0.34 if dy < 0 else float(source_node.y) + 0.34)

            count = len(ordered_clusters)
            for index, (_root_id, owned, box) in enumerate(ordered_clusters):
                target_x = (x_lo + x_hi) / 2.0 if count <= 1 else x_lo + (x_hi - x_lo) * (index / (count - 1))
                old_cx = (box[0] + box[2]) / 2.0
                root_id = ordered_clusters[index][0]
                root_y = float(updated[root_id].y)
                shift_x = target_x - old_cx
                shift_y = row_y - root_y
                for node_id in owned:
                    node = updated[node_id]
                    updated[node_id] = node.model_copy(
                        update={
                            "x": _clamp(float(node.x) + shift_x),
                            "y": _clamp(float(node.y) + shift_y),
                        }
                    )
                    moved_global.add(node_id)
        else:
            # Rotated equivalent of the same reference grammar: one column forever.
            y_lo, y_hi = 0.10, 0.90
            column_x = median(root_xs)
            if abs(float(source_node.x) - column_x) < 0.12:
                column_x = _clamp(float(source_node.x) + 0.34 if dx > 0 else float(source_node.x) - 0.34)

            count = len(ordered_clusters)
            for index, (_root_id, owned, box) in enumerate(ordered_clusters):
                target_y = (y_lo + y_hi) / 2.0 if count <= 1 else y_lo + (y_hi - y_lo) * (index / (count - 1))
                old_cy = (box[1] + box[3]) / 2.0
                root_id = ordered_clusters[index][0]
                root_x = float(updated[root_id].x)
                shift_x = column_x - root_x
                shift_y = target_y - old_cy
                for node_id in owned:
                    node = updated[node_id]
                    updated[node_id] = node.model_copy(
                        update={
                            "x": _clamp(float(node.x) + shift_x),
                            "y": _clamp(float(node.y) + shift_y),
                        }
                    )
                    moved_global.add(node_id)

    return [updated[node.id] for node in nodes]

def _apply_distribution(
    nodes: list[DiagramNode],
    edges: list[DiagramEdge],
    metadata: dict[str, NodeTopologyMeta],
    locked_pairs: set[tuple[str, str]] | None = None,
) -> tuple[list[DiagramNode], list[DiagramEdge]]:
    node_lookup = {node.id: node for node in nodes}
    grouped: dict[tuple[str, str], list[DiagramEdge]] = defaultdict(list)
    passthrough: list[DiagramEdge] = []
    locked = set(locked_pairs or ())

    for edge in edges:
        channel = _edge_channel(edge)
        pair = (str(edge.source), str(edge.target))
        if edge.direction == "unknown" or not channel or pair in locked:
            passthrough.append(edge)
            continue
        grouped[(edge.source, channel)].append(edge)

    new_nodes = list(nodes)
    new_edges = list(passthrough)

    for (source_id, channel), group in grouped.items():
        unique_targets = sorted(
            {edge.target for edge in group},
            key=lambda node_id: _node_sort_key(node_id, metadata),
        )
        if len(unique_targets) <= 1 or source_id not in node_lookup:
            new_edges.extend(group)
            continue

        target_nodes = [node_lookup[target] for target in unique_targets if target in node_lookup]
        if len(target_nodes) != len(unique_targets):
            new_edges.extend(group)
            continue

        # Keep branch ordering synchronized with trunk point ordering.
        xs = [float(node.x) for node in target_nodes]
        ys = [float(node.y) for node in target_nodes]
        horizontal = (max(xs) - min(xs) if len(xs) > 1 else 0.0) >= (
            max(ys) - min(ys) if len(ys) > 1 else 0.0
        )
        ordered_targets = sorted(
            target_nodes,
            key=(
                (lambda node: (node.x, node.y, node.id))
                if horizontal
                else (lambda node: (node.y, node.x, node.id))
            ),
        )
        points = _distribution_points(node_lookup[source_id], ordered_targets)
        edge_by_target = {edge.target: edge for edge in group}
        common_label = _common_label(group)

        junction_ids: list[str] = []
        for index, point in enumerate(points):
            junction_id = f"dist__{_slug(source_id)}__{_slug(channel)}__{index + 1}"
            suffix = 1
            base_id = junction_id
            while junction_id in node_lookup:
                suffix += 1
                junction_id = f"{base_id}_{suffix}"
            junction = _make_junction(
                junction_id=junction_id,
                x=point[0],
                y=point[1],
                role="distribution_junction",
                channel=channel,
            )
            node_lookup[junction_id] = junction
            new_nodes.append(junction)
            junction_ids.append(junction_id)

        template = group[0]
        logical_group_id = "|".join(sorted(edge.logical_edge_id or edge.id for edge in group))

        # Fixed reference manifold entrance. A bottom-band process source feeds an
        # upper horizontal load row through one clean vertical riser first, then
        # the manifold runs horizontally above the destinations. The extra point
        # is routing infrastructure only; it is not a user-visible component.
        source_meta = metadata.get(source_id, NodeTopologyMeta())
        process_channel = str(channel).strip().lower() in {"process", "water", "hydraulic", "fluid"}
        horizontal_target_row = horizontal and bool(points)
        source_below_targets = all(float(node.y) < float(node_lookup[source_id].y) for node in ordered_targets)
        use_reference_entry = (
            source_meta.layout_zone == "fixed_bottom_source"
            and process_channel
            and horizontal_target_row
            and source_below_targets
        )

        if use_reference_entry:
            entry_id = f"dist_entry__{_slug(source_id)}__{_slug(channel)}"
            suffix = 1
            base_id = entry_id
            while entry_id in node_lookup:
                suffix += 1
                entry_id = f"{base_id}_{suffix}"
            entry = _make_junction(
                junction_id=entry_id,
                x=float(node_lookup[source_id].x),
                y=points[0][1],
                role="distribution_entry_junction",
                channel=channel,
            )
            node_lookup[entry_id] = entry
            new_nodes.append(entry)

            main_edge = _clone_edge(
                template,
                edge_id=f"main__{_slug(source_id)}__{_slug(channel)}",
                source=source_id,
                target=entry_id,
                label=common_label,
                role="main",
                logical_edge_id=logical_group_id,
            ).model_copy(
                update={
                    "source_side": "top",
                    "source_port_fraction": 0.5,
                    "target_side": "bottom",
                    "target_port_fraction": 0.5,
                }
            )
            new_edges.append(main_edge)
            new_edges.append(
                _clone_edge(
                    template,
                    edge_id=f"trunk_entry__{_slug(source_id)}__{_slug(channel)}",
                    source=entry_id,
                    target=junction_ids[0],
                    label="",
                    role="trunk",
                    logical_edge_id=logical_group_id,
                )
            )
        else:
            new_edges.append(
                _clone_edge(
                    template,
                    edge_id=f"main__{_slug(source_id)}__{_slug(channel)}",
                    source=source_id,
                    target=junction_ids[0],
                    label=common_label,
                    role="main",
                    logical_edge_id=logical_group_id,
                )
            )

        for index, target_node in enumerate(ordered_targets):
            original = edge_by_target[target_node.id]
            branch_edge = _clone_edge(
                original,
                edge_id=f"branch__{_slug(source_id)}__{_slug(channel)}__{index + 1}",
                source=junction_ids[index],
                target=target_node.id,
                label="" if common_label else original.label,
                role="branch",
            )

            # Lock each manifold branch to the facing center ports. This is a
            # geometry rule, not a component-name rule: horizontal manifolds use
            # vertical drops/rises; vertical manifolds use horizontal branches.
            # It prevents the router from replacing the fixed reference branch
            # with a loop merely because the fan-out contains many destinations.
            junction_node = node_lookup[junction_ids[index]]
            jx, jy = float(junction_node.x), float(junction_node.y)
            tx, ty = float(target_node.x), float(target_node.y)
            if horizontal:
                source_side = "bottom" if ty >= jy else "top"
                target_side = "top" if ty >= jy else "bottom"
            else:
                source_side = "right" if tx >= jx else "left"
                target_side = "left" if tx >= jx else "right"
            branch_edge = branch_edge.model_copy(
                update={
                    "source_side": source_side,
                    "target_side": target_side,
                    "source_port_fraction": 0.5,
                    "target_port_fraction": 0.5,
                }
            )
            new_edges.append(branch_edge)
            if index + 1 < len(junction_ids):
                new_edges.append(
                    _clone_edge(
                        template,
                        edge_id=f"trunk__{_slug(source_id)}__{_slug(channel)}__{index + 1}",
                        source=junction_ids[index],
                        target=junction_ids[index + 1],
                        label="",
                        role="trunk",
                        logical_edge_id="|".join(sorted(edge.logical_edge_id or edge.id for edge in group)),
                    )
                )

    return new_nodes, _dedupe_edges(new_edges)


def _apply_collection(
    nodes: list[DiagramNode],
    edges: list[DiagramEdge],
    metadata: dict[str, NodeTopologyMeta],
    locked_pairs: set[tuple[str, str]] | None = None,
) -> tuple[list[DiagramNode], list[DiagramEdge]]:
    node_lookup = {node.id: node for node in nodes}
    grouped: dict[tuple[str, str], list[DiagramEdge]] = defaultdict(list)
    passthrough: list[DiagramEdge] = []
    locked = set(locked_pairs or ())

    for edge in edges:
        channel = _edge_channel(edge)
        target_node = node_lookup.get(edge.target)
        pair = (str(edge.source), str(edge.target))
        if (
            edge.direction == "unknown"
            or not channel
            or target_node is None
            or target_node.node_type == "junction"
            or pair in locked
        ):
            passthrough.append(edge)
            continue
        grouped[(edge.target, channel)].append(edge)

    new_nodes = list(nodes)
    new_edges = list(passthrough)

    for (target_id, channel), group in grouped.items():
        unique_sources = sorted(
            {edge.source for edge in group},
            key=lambda node_id: _node_sort_key(node_id, metadata),
        )
        if len(unique_sources) <= 1 or target_id not in node_lookup:
            new_edges.extend(group)
            continue

        source_nodes = [node_lookup[source] for source in unique_sources if source in node_lookup]
        if len(source_nodes) != len(unique_sources):
            new_edges.extend(group)
            continue

        xs = [float(node.x) for node in source_nodes]
        ys = [float(node.y) for node in source_nodes]
        horizontal = (max(xs) - min(xs) if len(xs) > 1 else 0.0) >= (
            max(ys) - min(ys) if len(ys) > 1 else 0.0
        )
        ordered_sources = sorted(
            source_nodes,
            key=(
                (lambda node: (node.x, node.y, node.id))
                if horizontal
                else (lambda node: (node.y, node.x, node.id))
            ),
        )
        points = _collection_points(ordered_sources, node_lookup[target_id])
        edge_by_source = {edge.source: edge for edge in group}
        common_label = _common_label(group)

        junction_ids: list[str] = []
        for index, point in enumerate(points):
            junction_id = f"collect__{_slug(target_id)}__{_slug(channel)}__{index + 1}"
            suffix = 1
            base_id = junction_id
            while junction_id in node_lookup:
                suffix += 1
                junction_id = f"{base_id}_{suffix}"
            junction = _make_junction(
                junction_id=junction_id,
                x=point[0],
                y=point[1],
                role="collection_junction",
                channel=channel,
            )
            node_lookup[junction_id] = junction
            new_nodes.append(junction)
            junction_ids.append(junction_id)

        template = group[0]
        for index, source_node in enumerate(ordered_sources):
            original = edge_by_source[source_node.id]
            new_edges.append(
                _clone_edge(
                    original,
                    edge_id=f"collect_branch__{_slug(target_id)}__{_slug(channel)}__{index + 1}",
                    source=source_node.id,
                    target=junction_ids[index],
                    label="" if common_label else original.label,
                    role="collection_branch",
                )
            )
            if index + 1 < len(junction_ids):
                new_edges.append(
                    _clone_edge(
                        template,
                        edge_id=f"collect_trunk__{_slug(target_id)}__{_slug(channel)}__{index + 1}",
                        source=junction_ids[index],
                        target=junction_ids[index + 1],
                        label="",
                        role="collection_trunk",
                        logical_edge_id="|".join(sorted(edge.logical_edge_id or edge.id for edge in group)),
                    )
                )

        new_edges.append(
            _clone_edge(
                template,
                edge_id=f"collect_main__{_slug(target_id)}__{_slug(channel)}",
                source=junction_ids[-1],
                target=target_id,
                label=common_label,
                role="collection_main",
                logical_edge_id="|".join(sorted(edge.logical_edge_id or edge.id for edge in group)),
            )
        )

    return new_nodes, _dedupe_edges(new_edges)


def _piping_role(node: DiagramNode) -> str:
    """Classify only the sump, pump, valve, flow-meter and tank nodes used on the water pipe."""
    label = str(getattr(node, "label", "") or "").lower()
    node_type = str(getattr(node, "node_type", "") or "")
    if node_type == "sump":
        return "sump"
    if node_type == "oht":
        return "oht"
    if node_type == "motor":
        return "motor"
    if node_type == "valve":
        if "motorized" in label:
            return "mv"
        if "non-return" in label or "non return" in label:
            return "nrv"
        if "pressure" in label:
            return "prv"
    if "flow meter" in label:
        return "fm"
    return ""


def _process_channel(edge: DiagramEdge) -> bool:
    return _edge_channel(edge).strip().lower() in {
        "process",
        "water",
        "water_flow",
        "water-flow",
        "hydraulic",
        "fluid",
    }


def _splice_hydraulic_piping(
    nodes: list[DiagramNode],
    edges: list[DiagramEdge],
    metadata: dict[str, NodeTopologyMeta],
    locked_pairs: set[tuple[str, str]] | None = None,
) -> list[DiagramEdge]:
    """Draw the selected sump-to-tank water line through the pump and valve chain.

    The chain is Sump, then each pump with its NRV and PRV, then one shared rise
    to each overhead tank. Flow meters and motorized valves are not inserted
    into that line; they receive a route only when the user selects both ends.
    Sensor, transmitter and borewell lines are left unchanged.
    """
    lookup = {node.id: node for node in nodes}
    roles = {node.id: _piping_role(node) for node in nodes}
    groups: dict[str, list[str]] = {
        "motor": [],
        "nrv": [],
        "prv": [],
        "fm": [],
        "mv": [],
    }
    for node in nodes:
        role = roles.get(node.id, "")
        if role in groups:
            groups[role].append(node.id)
    for values in groups.values():
        values.sort(key=lambda node_id: _node_sort_key(node_id, metadata))
    # Selecting a flow meter or motorized valve must not rewrite the water line.
    if not any(groups[role] for role in ("motor", "nrv", "prv")):
        return edges

    locked = set(locked_pairs or ())
    hosts: list[DiagramEdge] = []
    for raw in edges:
        edge = _directed_edge(raw)
        if not _process_channel(edge):
            continue
        if (str(edge.source), str(edge.target)) in locked:
            continue
        if roles.get(edge.source) == "sump" and roles.get(edge.target) == "oht":
            hosts.append(edge)
    if not hosts:
        return edges

    hosts.sort(key=lambda edge: (
        _node_sort_key(edge.source, metadata),
        float(lookup[edge.target].x) if edge.target in lookup else 0.0,
        edge.id,
    ))
    device_ids = {
        node_id
        for role in ("motor", "nrv", "prv")
        for node_id in groups[role]
    }
    by_sump: dict[str, list[DiagramEdge]] = defaultdict(list)
    for edge in hosts:
        by_sump[edge.source].append(edge)

    def take(role: str, index: int) -> str:
        values = groups[role]
        if not values:
            return ""
        return values[min(index, len(values) - 1)]

    def unique(chain: list[str]) -> list[str]:
        result: list[str] = []
        for node_id in chain:
            if node_id and (not result or result[-1] != node_id):
                result.append(node_id)
        return result

    replacement_hops: list[tuple[DiagramEdge, str, str]] = []
    used_prefix: set[tuple[str, str]] = set()
    for sump_id, sump_hosts in by_sump.items():
        # Dual pumps each pass through an NRV and PRV, then join one rise.
        # Flow meters and motorized valves stay off this automatic branch.
        prefix_roots = max(len(groups["motor"]), len(groups["nrv"]), len(groups["prv"]))
        feeder = sump_id
        for index in range(prefix_roots):
            chain = unique([
                sump_id,
                take("motor", index),
                take("nrv", index),
                take("prv", index),
            ])
            if len(chain) < 2:
                continue
            if index == 0:
                feeder = chain[-1]
            elif chain[-1] != feeder:
                chain.append(feeder)
            for source_id, target_id in zip(chain, chain[1:]):
                hop = (source_id, target_id)
                if hop in used_prefix:
                    continue
                used_prefix.add(hop)
                replacement_hops.append((sump_hosts[0], source_id, target_id))

        for host in sump_hosts:
            branch = unique([feeder, host.target])
            for source_id, target_id in zip(branch, branch[1:]):
                replacement_hops.append((host, source_id, target_id))

    if not replacement_hops:
        return edges

    host_ids = {edge.id for edge in hosts}
    kept: list[DiagramEdge] = []
    for raw in edges:
        edge = _directed_edge(raw)
        if edge.id in host_ids:
            continue
        if (str(edge.source), str(edge.target)) in locked:
            kept.append(raw)
            continue
        if _process_channel(edge) and edge.source in device_ids and edge.target in device_ids:
            continue
        if _process_channel(edge) and roles.get(edge.source) == "sump" and edge.target in device_ids:
            continue
        if _process_channel(edge) and edge.source in device_ids and roles.get(edge.target) == "oht":
            continue
        kept.append(raw)

    seen: set[tuple[str, str]] = set()
    for template, source_id, target_id in replacement_hops:
        hop = (source_id, target_id)
        if hop in seen or source_id == target_id:
            continue
        seen.add(hop)
        kept.append(
            _clone_edge(
                template,
                edge_id=f"hydraulic__{_slug(source_id)}__{_slug(target_id)}",
                source=source_id,
                target=target_id,
                label=template.label,
                role="series",
                logical_edge_id=template.logical_edge_id or template.id,
            )
        )
    return _dedupe_edges(kept)


def _seat_hydraulic_piping(
    nodes: list[DiagramNode],
    edges: list[DiagramEdge],
    metadata: dict[str, NodeTopologyMeta],
) -> list[DiagramNode]:
    """Keep pumps, NRV, and PRV beside the sump. Do not seat other cards on a tank."""
    lookup = {node.id: node for node in nodes}
    roles = {node.id: _piping_role(node) for node in nodes}
    if not any(role in {"fm", "mv", "motor", "nrv", "prv"} for role in roles.values()):
        return nodes

    sumps = [node for node in nodes if roles.get(node.id) == "sump"]
    updated = dict(lookup)

    def move(node_id: str, x: float, y: float) -> None:
        node = updated.get(node_id)
        if node is None:
            return
        updated[node_id] = node.model_copy(update={"x": _clamp(x), "y": _clamp(y)})

    if sumps:
        anchor = min(sumps, key=lambda node: (float(node.x), _node_sort_key(node.id, metadata)))
        anchor_x = float(anchor.x)
        anchor_y = float(anchor.y)
        motors = sorted(
            [node_id for node_id, role in roles.items() if role == "motor"],
            key=lambda node_id: _node_sort_key(node_id, metadata),
        )
        if len(motors) <= 1:
            motor_ys = [anchor_y]
        elif len(motors) == 2:
            motor_ys = [anchor_y - 0.09, anchor_y + 0.09]
        else:
            top = max(0.30, anchor_y - 0.16)
            bottom = min(0.82, anchor_y + 0.16)
            motor_ys = [top + (bottom - top) * index / (len(motors) - 1) for index in range(len(motors))]
        motor_at: dict[str, tuple[float, float]] = {}
        for index, node_id in enumerate(motors):
            point = (min(0.46, anchor_x + 0.12), motor_ys[index])
            motor_at[node_id] = point
            move(node_id, *point)
        for role, dx in (("nrv", 0.21), ("prv", 0.30)):
            ordered = sorted(
                [node_id for node_id, item_role in roles.items() if item_role == role],
                key=lambda node_id: _node_sort_key(node_id, metadata),
            )
            for index, node_id in enumerate(ordered):
                if motors:
                    _px, py = motor_at[motors[min(index, len(motors) - 1)]]
                elif len(ordered) == 1:
                    py = anchor_y
                else:
                    py = anchor_y - 0.09 + 0.18 * index / (len(ordered) - 1)
                move(node_id, min(0.64, anchor_x + dx), py)

    return [updated[node.id] for node in nodes]


def apply_topology_engine(
    diagram: DiagramSpec,
    node_metadata: dict[str, NodeTopologyMeta] | None = None,
    locked_pairs: set[tuple[str, str]] | None = None,
) -> DiagramSpec:
    """Return a topology-normalized copy of ``diagram``.

    The engine transforms only explicit channel-aware directed edges.  Edges from
    sketch/AI extraction that do not carry ``topology_channel`` are preserved
    exactly, which keeps the existing sketch-understanding workflow backward
    compatible while allowing the generated component workflow to use advanced
    topology handling.
    """
    metadata = dict(node_metadata or {})
    nodes = list(diagram.nodes)
    edges = list(diagram.edges)

    # Nothing to normalize when no explicit topology channels are present.
    if not any(_edge_channel(edge) for edge in edges if edge.direction != "unknown"):
        return diagram

    edges = _splice_hydraulic_piping(nodes, edges, metadata, locked_pairs)
    edges = _apply_inline_series(edges, metadata)
    edges = _apply_auto_inline_components(nodes, edges, metadata)
    nodes = _position_inline_gateways(nodes, edges, metadata)
    nodes = _reserve_reference_riser_clearance(nodes, edges, metadata)
    nodes = _seat_hydraulic_piping(nodes, edges, metadata)
    nodes = _stabilize_large_fanout_layout(nodes, edges, metadata)
    nodes, edges = _apply_distribution(nodes, edges, metadata, locked_pairs)
    nodes, edges = _apply_collection(nodes, edges, metadata, locked_pairs)

    style_notes = list(diagram.style_notes)
    note = "Topology-first universal distribution/collection junction engine"
    if note not in style_notes:
        style_notes.append(note)
    reference_note = "Universal reference-style manifold placement"
    if reference_note not in style_notes:
        style_notes.append(reference_note)
    inline_note = "Metadata-driven automatic inline-channel insertion"
    if inline_note not in style_notes:
        style_notes.append(inline_note)
    scalable_note = "Generic 6+ branch cluster spacing and routing reservation"
    if scalable_note not in style_notes:
        style_notes.append(scalable_note)

    physical_nodes = sum(1 for node in nodes if node.node_type != "junction")
    junction_nodes = sum(1 for node in nodes if node.node_type == "junction")
    return diagram.model_copy(
        update={
            "nodes": nodes,
            "edges": edges,
            "summary": (
                f"{diagram.summary} Topology normalized with {junction_nodes} "
                f"routing junction{'s' if junction_nodes != 1 else ''} for "
                f"{physical_nodes} component{'s' if physical_nodes != 1 else ''}."
            ).strip(),
            "style_notes": style_notes,
        }
    )
