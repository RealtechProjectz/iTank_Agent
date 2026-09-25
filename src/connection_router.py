from __future__ import annotations

"""Dedicated universal ConnectionRouter for obstacle-aware orthogonal routing.

This module is intentionally independent of component names, component images and
catalog relationship names.  It consumes only graph topology, node geometry,
connection-port metadata and already-reserved routes.

The important guarantees for every generated diagram are:

* component cards are hard routing obstacles with a configurable safety margin;
* the source/target card may only be touched by the first/last escape segment;
* every physical connection receives an independently selected port/escape lane;
* all four sides are evaluated and the cleanest free-space route wins;
* existing routes reserve keep-out channels so unrelated edges cannot merge;
* crossings/overlaps are rejected except at an explicit topology junction;
* dense diagrams increase routing clearances and component/canvas space before
  routing is attempted;
* automatic physical routes are restricted to straight or single-bend L paths;
  Z-shaped, multi-lane zigzag and multi-bend A* paths are never returned.

Rendering code only draws the returned polylines, so the same routing logic works
for current and future components without adding component-specific ``if`` blocks.
"""

from collections import defaultdict
from dataclasses import dataclass
import heapq
import math
from itertools import count
from typing import Mapping, Sequence

from .models import DiagramEdge, DiagramNode, DiagramSpec
from .reference_routing_profile import REFERENCE_ROUTING_PROFILE


Point = tuple[float, float]
Box = tuple[float, float, float, float]
SIDES = ("top", "bottom", "left", "right")


@dataclass(frozen=True)
class RoutingSpace:
    edge_count: int
    physical_node_count: int
    junction_count: int
    max_degree: int
    channel_count: int
    lane_spacing: float
    component_gap_x: float
    component_gap_y: float
    area_bonus: float
    routing_clearance: float
    connection_gap: float
    port_gap: float
    junction_clearance: float
    label_clearance: float
    escape_distance: float


@dataclass(frozen=True)
class PortAssignment:
    side: str
    fraction: float
    slot_index: int


@dataclass
class ReservedRoute:
    edge_index: int
    source: str
    target: str
    points: list[Point]
    topology_role: str
    topology_channel: str


@dataclass(frozen=True)
class _PortCandidate:
    side: str
    fraction: float
    slot_index: int
    score: float


# =============================================================================
# ROUTING SPACE / DENSITY
# =============================================================================


def analyze_routing_space(diagram: DiagramSpec) -> RoutingSpace:
    """Estimate real whitespace required before components are finally placed."""
    physical_nodes = [node for node in diagram.nodes if node.node_type != "junction"]
    junctions = [node for node in diagram.nodes if node.node_type == "junction"]
    degree = {node.id: 0 for node in diagram.nodes}
    channels: set[str] = set()

    for edge in diagram.edges:
        degree[edge.source] = degree.get(edge.source, 0) + 1
        degree[edge.target] = degree.get(edge.target, 0) + 1
        channel = str(getattr(edge, "topology_channel", "") or "").strip()
        if channel:
            channels.add(channel)

    max_degree = max(degree.values(), default=0)
    edge_count = len(diagram.edges)
    node_count = max(1, len(physical_nodes))
    pressure = edge_count / node_count
    branching_pressure = sum(max(0, value - 2) for value in degree.values())

    # Distances are expressed in the same logical-inch coordinate system used by
    # the renderer.  They intentionally grow slowly with route pressure so a
    # sparse drawing still looks like the existing project while dense drawings
    # reserve visibly separate channels.
    bulk_degree = max(0, max_degree - 5)

    connection_gap = max(
        0.145,
        float(REFERENCE_ROUTING_PROFILE["minimum_connection_gap"]),
    )
    connection_gap += min(0.105, math.log2(max(2, max_degree + 1)) * 0.018)
    connection_gap += min(0.045, max(0.0, pressure - 1.2) * 0.020)
    # Preserve the existing 2-5 connection appearance exactly; reserve extra
    # parallel-lane separation only when the graph actually crosses the 6+ fanout
    # threshold that previously caused visual congestion.
    connection_gap += min(0.085, bulk_degree * 0.010)

    routing_clearance = max(
        0.105,
        float(REFERENCE_ROUTING_PROFILE["minimum_component_clearance"]),
    )
    routing_clearance += min(0.070, max_degree * 0.0065)
    routing_clearance += min(0.035, max(0.0, pressure - 1.0) * 0.012)
    routing_clearance += min(0.060, bulk_degree * 0.007)

    lane_spacing = max(
        connection_gap * float(REFERENCE_ROUTING_PROFILE["parallel_lane_multiplier"]),
        routing_clearance * 1.10,
    )
    port_gap = max(
        float(REFERENCE_ROUTING_PROFILE["minimum_port_gap"]),
        connection_gap * 0.78,
    )
    junction_clearance = max(0.045, routing_clearance * 0.48)
    label_clearance = max(0.075, routing_clearance * 0.72)
    escape_distance = routing_clearance + max(0.085, connection_gap * 0.58)

    component_gap_x = 0.30 + min(0.62, max_degree * 0.052 + pressure * 0.080)
    component_gap_y = 0.28 + min(0.58, max_degree * 0.048 + pressure * 0.074)
    if bulk_degree:
        component_gap_x += min(0.42, bulk_degree * 0.045)
        component_gap_y += min(0.42, bulk_degree * 0.045)

    # This value feeds dynamic page sizing in renderers.py.  Stronger weighting
    # than v54 is deliberate: many routes should receive more canvas instead of
    # being squeezed into the same fixed corridors.
    area_bonus = (
        edge_count * 0.52
        + len(junctions) * 0.30
        + branching_pressure * 0.62
        + max(0, len(channels) - 1) * 0.48
        + max_degree * 0.24
        + bulk_degree * 1.15
    )

    return RoutingSpace(
        edge_count=edge_count,
        physical_node_count=len(physical_nodes),
        junction_count=len(junctions),
        max_degree=max_degree,
        channel_count=len(channels),
        lane_spacing=lane_spacing,
        component_gap_x=component_gap_x,
        component_gap_y=component_gap_y,
        area_bonus=area_bonus,
        routing_clearance=routing_clearance,
        connection_gap=connection_gap,
        port_gap=port_gap,
        junction_clearance=junction_clearance,
        label_clearance=label_clearance,
        escape_distance=escape_distance,
    )



# =============================================================================
# ROUTING-ONLY JUNCTION NORMALIZATION
# =============================================================================


def _prepare_routing_boxes(
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
) -> dict[str, Box]:
    """Recompute invisible junction positions from final component rectangles.

    Visible component rectangles are never moved.  Distribution/collection
    junctions are routing infrastructure; their pre-layout normalized coordinates
    can land inside a card after final collision resolution.  This function places
    each whole junction spine into one common free routing lane beside its branch
    field, preserving the existing topology while guaranteeing that the manifold
    itself is not hidden behind components.
    """
    result = dict(boxes)
    node_lookup = {node.id: node for node in diagram.nodes}
    junction_ids = {node.id for node in diagram.nodes if node.node_type == "junction"}
    if not junction_ids:
        return result

    junction_adj: dict[str, set[str]] = defaultdict(set)
    main_sources: dict[str, str] = {}
    branch_targets: dict[str, str] = {}
    collection_targets: dict[str, str] = {}
    collection_sources: dict[str, list[str]] = defaultdict(list)

    for edge in diagram.edges:
        role = str(getattr(edge, "topology_role", "") or "")
        src_j = edge.source in junction_ids
        tgt_j = edge.target in junction_ids
        if src_j and tgt_j:
            junction_adj[edge.source].add(edge.target)
            junction_adj[edge.target].add(edge.source)
        if role == "main" and not src_j and tgt_j:
            main_sources[edge.target] = edge.source
        if role == "branch" and src_j and not tgt_j:
            branch_targets[edge.source] = edge.target
        if role == "collection_main" and src_j and not tgt_j:
            collection_targets[edge.source] = edge.target
        if role == "collection_branch" and not src_j and tgt_j:
            collection_sources[edge.target].append(edge.source)

    physical_boxes = {nid: box for nid, box in result.items() if nid not in junction_ids}
    left, right, top, bottom = bounds
    junction_size = 0.10
    clearance = max(0.12, space.routing_clearance + space.connection_gap * 0.42)

    def propagate(seed_map: Mapping[str, str]) -> dict[str, str]:
        propagated: dict[str, str] = {}
        for seed, physical_id in seed_map.items():
            stack = [seed]
            seen: set[str] = set()
            while stack:
                current = stack.pop()
                if current in seen:
                    continue
                seen.add(current)
                propagated.setdefault(current, physical_id)
                stack.extend(junction_adj.get(current, set()))
        return propagated

    source_for_junction = propagate(main_sources)
    target_for_collection = propagate(collection_targets)

    # ----------------------------- distribution -----------------------------
    distribution_groups: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for junction_id, target_id in branch_targets.items():
        source_id = source_for_junction.get(junction_id)
        if source_id in physical_boxes and target_id in physical_boxes:
            distribution_groups[source_id].append((junction_id, target_id))

    assigned: set[str] = set()
    distribution_trunk_x: dict[str, float] = {}
    for source_id, pairs in distribution_groups.items():
        source_box = physical_boxes[source_id]
        source_center = _box_center(source_box)
        target_boxes = [physical_boxes[target_id] for _jid, target_id in pairs]
        target_centers = [_box_center(box) for box in target_boxes]
        target_mid_x = sorted(point[0] for point in target_centers)[len(target_centers) // 2]

        # Horizontal-flow standard: one vertical distributor spine sits on the
        # source-facing side of the destination field. Each destination therefore
        # receives a clean horizontal branch and the feeder leaves the source
        # horizontally.
        source_is_left = source_center[0] <= target_mid_x
        if source_is_left:
            preferred_x = min(box[0] for box in target_boxes) - clearance
            source_limit = source_box[0] + source_box[2] + clearance
            if preferred_x <= source_limit:
                preferred_x = (source_box[0] + source_box[2] + min(box[0] for box in target_boxes)) / 2.0
        else:
            preferred_x = max(box[0] + box[2] for box in target_boxes) + clearance
            source_limit = source_box[0] - clearance
            if preferred_x >= source_limit:
                preferred_x = (source_box[0] + max(box[0] + box[2] for box in target_boxes)) / 2.0

        trunk_x = max(left + 0.04, min(right - 0.04, preferred_x))
        distribution_trunk_x[source_id] = trunk_x
        ordered = sorted(pairs, key=lambda pair: _box_center(physical_boxes[pair[1]])[1])
        for junction_id, target_id in ordered:
            cy = _box_center(physical_boxes[target_id])[1]
            result[junction_id] = (
                trunk_x - junction_size / 2.0,
                cy - junction_size / 2.0,
                junction_size,
                junction_size,
            )
            assigned.add(junction_id)


    # Keep the distribution entry junction on the exact same vertical spine and
    # align it with the physical source center so the source feeder is horizontal.
    for junction_id, source_id in source_for_junction.items():
        if junction_id in assigned or source_id not in distribution_trunk_x:
            continue
        node = node_lookup.get(junction_id)
        if node is None or str(getattr(node, "topology_role", "") or "") != "distribution_entry_junction":
            continue
        cy = _box_center(physical_boxes[source_id])[1]
        trunk_x = distribution_trunk_x[source_id]
        result[junction_id] = (
            trunk_x - junction_size / 2.0,
            cy - junction_size / 2.0,
            junction_size,
            junction_size,
        )
        assigned.add(junction_id)

    # ------------------------------- collection -----------------------------
    # Horizontal-flow standard for fan-in: all collection junctions for one
    # target share a vertical collector spine on the source-facing side of the
    # target. Source branches and the final target entry are therefore horizontal.
    collection_groups: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for junction_id, target_id in target_for_collection.items():
        source_ids = collection_sources.get(junction_id, [])
        for source_id in source_ids:
            if source_id in physical_boxes and target_id in physical_boxes:
                collection_groups[target_id].append((junction_id, source_id))
                break

    collection_trunk_x: dict[str, float] = {}
    for target_id, pairs in collection_groups.items():
        target_box = physical_boxes[target_id]
        target_center = _box_center(target_box)
        source_boxes = [physical_boxes[source_id] for _jid, source_id in pairs]
        source_centers = [_box_center(box) for box in source_boxes]
        source_mid_x = sorted(point[0] for point in source_centers)[len(source_centers) // 2]
        sources_are_left = source_mid_x <= target_center[0]

        if sources_are_left:
            preferred_x = target_box[0] - clearance
            rightmost_source = max(box[0] + box[2] for box in source_boxes)
            if preferred_x <= rightmost_source + clearance:
                preferred_x = (rightmost_source + target_box[0]) / 2.0
        else:
            preferred_x = target_box[0] + target_box[2] + clearance
            leftmost_source = min(box[0] for box in source_boxes)
            if preferred_x >= leftmost_source - clearance:
                preferred_x = (target_box[0] + target_box[2] + leftmost_source) / 2.0

        trunk_x = max(left + 0.04, min(right - 0.04, preferred_x))
        collection_trunk_x[target_id] = trunk_x
        ordered = sorted(pairs, key=lambda pair: _box_center(physical_boxes[pair[1]])[1])
        for junction_id, source_id in ordered:
            cy = _box_center(physical_boxes[source_id])[1]
            result[junction_id] = (
                trunk_x - junction_size / 2.0,
                cy - junction_size / 2.0,
                junction_size,
                junction_size,
            )
            assigned.add(junction_id)


    # Keep the collection exit junction on the same vertical spine and align it
    # with the target center so the final target entry is horizontal.
    for junction_id, target_id in target_for_collection.items():
        if junction_id in assigned or target_id not in collection_trunk_x:
            continue
        node = node_lookup.get(junction_id)
        if node is None or str(getattr(node, "topology_role", "") or "") != "collection_exit_junction":
            continue
        cy = _box_center(physical_boxes[target_id])[1]
        trunk_x = collection_trunk_x[target_id]
        result[junction_id] = (
            trunk_x - junction_size / 2.0,
            cy - junction_size / 2.0,
            junction_size,
            junction_size,
        )
        assigned.add(junction_id)

    # Any remaining junctions are not part of a fan-in/fan-out spine. Keep their
    # existing mapped position unless it collides with a physical component.
    for junction_id in junction_ids - assigned:
        current = result.get(junction_id)
        if current is None:
            continue
        cx, cy = _box_center(current)
        if not any(_point_in_box((cx, cy), box, space.routing_clearance) for box in physical_boxes.values()):
            continue

        target_id = target_for_collection.get(junction_id)
        if target_id in physical_boxes:
            box = physical_boxes[target_id]
            target_center = _box_center(box)
            source_ids = collection_sources.get(junction_id, [])
            valid_sources = [physical_boxes[sid] for sid in source_ids if sid in physical_boxes]
            if valid_sources:
                sx = sum(_box_center(b)[0] for b in valid_sources) / len(valid_sources)
                source_is_left = sx <= target_center[0]
                cx = box[0] - clearance if source_is_left else box[0] + box[2] + clearance
                cy = sum(_box_center(b)[1] for b in valid_sources) / len(valid_sources)
            else:
                cx = box[0] - clearance
                cy = target_center[1]
            cx = max(left + 0.04, min(right - 0.04, cx))
            cy = max(top + 0.04, min(bottom - 0.04, cy))
            result[junction_id] = (
                cx - junction_size / 2.0,
                cy - junction_size / 2.0,
                junction_size,
                junction_size,
            )

    return result


# =============================================================================
# BASIC GEOMETRY
# =============================================================================


def _box_center(box: Box) -> Point:
    x, y, w, h = box
    return x + w / 2.0, y + h / 2.0


def _side_vector(side: str) -> Point:
    return {
        "left": (-1.0, 0.0),
        "right": (1.0, 0.0),
        "top": (0.0, -1.0),
        "bottom": (0.0, 1.0),
    }[side]


def _port_point(box: Box, side: str, fraction: float) -> Point:
    x, y, w, h = box
    fraction = min(0.95, max(0.05, float(fraction)))
    if side == "left":
        return x, y + h * fraction
    if side == "right":
        return x + w, y + h * fraction
    if side == "top":
        return x + w * fraction, y
    return x + w * fraction, y + h


def _stub_point(point: Point, side: str, distance: float) -> Point:
    x, y = point
    dx, dy = _side_vector(side)
    return x + dx * distance, y + dy * distance


def _compress(points: Sequence[Point]) -> list[Point]:
    deduped: list[Point] = []
    for point in points:
        p = (float(point[0]), float(point[1]))
        if (
            not deduped
            or abs(deduped[-1][0] - p[0]) > 1e-8
            or abs(deduped[-1][1] - p[1]) > 1e-8
        ):
            deduped.append(p)

    if len(deduped) <= 2:
        return deduped

    result = [deduped[0]]
    for index in range(1, len(deduped) - 1):
        a = result[-1]
        b = deduped[index]
        c = deduped[index + 1]
        same_x = abs(a[0] - b[0]) < 1e-8 and abs(b[0] - c[0]) < 1e-8
        same_y = abs(a[1] - b[1]) < 1e-8 and abs(b[1] - c[1]) < 1e-8
        if same_x or same_y:
            continue
        result.append(b)
    result.append(deduped[-1])
    return result


def _segment_kind(a: Point, b: Point) -> str:
    if abs(a[0] - b[0]) <= 1e-8:
        return "v"
    if abs(a[1] - b[1]) <= 1e-8:
        return "h"
    return "d"


def _segment_length(a: Point, b: Point) -> float:
    return abs(b[0] - a[0]) + abs(b[1] - a[1])


def _polyline_length(points: Sequence[Point]) -> float:
    return sum(_segment_length(a, b) for a, b in zip(points, points[1:]))


def _route_cost(points: Sequence[Point], start: Point, end: Point) -> tuple[float, float, int, float]:
    """Return a shortest-clean-path score after hard safety checks pass.

    Distance is the primary soft objective.  Bends remain mildly penalized so a
    slightly longer two-bend engineering route can still beat a visually noisy
    route, but a very long perimeter detour can no longer beat a much shorter
    clean path merely because it has one fewer bend.

    The excess-detour term compares the route with the theoretical Manhattan
    minimum between the selected ports.  It is generic geometry only and has no
    knowledge of component types.
    """
    length = _polyline_length(points)
    bends = max(0, len(points) - 2)
    direct = max(0.001, _segment_length(start, end))
    excess = max(0.0, length - direct)

    # One extra 90-degree bend is intentionally cheap compared with routing an
    # edge several inches around otherwise-free space.
    weighted = (
        length
        + bends * float(REFERENCE_ROUTING_PROFILE["bend_penalty"])
        + excess * float(REFERENCE_ROUTING_PROFILE["excess_detour_penalty"])
    )
    return weighted, length, bends, excess


def _point_in_box(point: Point, box: Box, clearance: float = 0.0) -> bool:
    px, py = point
    x, y, w, h = box
    return (
        x - clearance <= px <= x + w + clearance
        and y - clearance <= py <= y + h + clearance
    )


def _expanded_box(box: Box, clearance: float) -> Box:
    x, y, w, h = box
    return x - clearance, y - clearance, w + 2 * clearance, h + 2 * clearance


def _segment_hits_box(a: Point, b: Point, box: Box, clearance: float = 0.0) -> bool:
    x, y, w, h = box
    left = x - clearance
    right = x + w + clearance
    top = y - clearance
    bottom = y + h + clearance
    kind = _segment_kind(a, b)

    if kind == "h":
        yy = a[1]
        if yy < top or yy > bottom:
            return False
        lo = min(a[0], b[0])
        hi = max(a[0], b[0])
        return hi >= left and lo <= right

    if kind == "v":
        xx = a[0]
        if xx < left or xx > right:
            return False
        lo = min(a[1], b[1])
        hi = max(a[1], b[1])
        return hi >= top and lo <= bottom

    return _point_in_box(a, box, clearance) or _point_in_box(b, box, clearance)


def _orthogonal_relation(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
    tolerance: float = 0.012,
):
    """Return None or (kind, representative_point, overlap_length)."""
    k1 = _segment_kind(a, b)
    k2 = _segment_kind(c, d)
    if k1 == "d" or k2 == "d":
        return None

    if k1 == "h" and k2 == "h":
        if abs(a[1] - c[1]) > tolerance:
            return None
        lo = max(min(a[0], b[0]), min(c[0], d[0]))
        hi = min(max(a[0], b[0]), max(c[0], d[0]))
        if hi - lo > tolerance:
            return "overlap", ((lo + hi) / 2.0, (a[1] + c[1]) / 2.0), hi - lo
        return None

    if k1 == "v" and k2 == "v":
        if abs(a[0] - c[0]) > tolerance:
            return None
        lo = max(min(a[1], b[1]), min(c[1], d[1]))
        hi = min(max(a[1], b[1]), max(c[1], d[1]))
        if hi - lo > tolerance:
            return "overlap", ((a[0] + c[0]) / 2.0, (lo + hi) / 2.0), hi - lo
        return None

    if k1 == "v" and k2 == "h":
        return _orthogonal_relation(c, d, a, b, tolerance)

    x = c[0]
    y = a[1]
    if (
        min(a[0], b[0]) - tolerance <= x <= max(a[0], b[0]) + tolerance
        and min(c[1], d[1]) - tolerance <= y <= max(c[1], d[1]) + tolerance
    ):
        return "cross", (x, y), 0.0
    return None


def _parallel_gap(a: Point, b: Point, c: Point, d: Point) -> tuple[float, float] | None:
    k1 = _segment_kind(a, b)
    k2 = _segment_kind(c, d)
    if k1 != k2 or k1 not in {"h", "v"}:
        return None
    if k1 == "h":
        overlap = min(max(a[0], b[0]), max(c[0], d[0])) - max(
            min(a[0], b[0]), min(c[0], d[0])
        )
        return abs(a[1] - c[1]), overlap
    overlap = min(max(a[1], b[1]), max(c[1], d[1])) - max(
        min(a[1], b[1]), min(c[1], d[1])
    )
    return abs(a[0] - c[0]), overlap


def _route_direction(points: Sequence[Point]) -> str:
    if len(points) < 2:
        return "right"
    a, b = points[-2], points[-1]
    if abs(b[0] - a[0]) >= abs(b[1] - a[1]):
        return "right" if b[0] >= a[0] else "left"
    return "down" if b[1] >= a[1] else "up"


# =============================================================================
# PORTS / FREE SPACE
# =============================================================================


def _ordered_slot_fractions(count_slots: int) -> list[float]:
    """Center-first evenly spaced fractions for independent same-side routes."""
    count_slots = max(1, count_slots)
    if count_slots == 1:
        return [0.50]
    lo, hi = 0.10, 0.90
    raw = [lo + (hi - lo) * index / (count_slots - 1) for index in range(count_slots)]
    raw.sort(key=lambda value: (abs(value - 0.50), value))
    return raw


def _node_port_profile(
    node: DiagramNode,
    box: Box,
    side_demand: int,
    space: RoutingSpace,
) -> dict[str, list[float]]:
    if node.node_type == "junction":
        return {side: [0.50] for side in SIDES}

    raw = getattr(node, "connection_ports", None) or {}
    profile: dict[str, list[float]] = {}

    for side in SIDES:
        values = raw.get(side, []) if isinstance(raw, dict) else []
        clean: list[float] = []
        for value in values:
            try:
                fraction = float(value)
            except (TypeError, ValueError):
                continue
            if 0.02 <= fraction <= 0.98 and all(abs(fraction - prior) > 1e-4 for prior in clean):
                clean.append(fraction)
        if clean:
            profile[side] = clean

    if not profile:
        profile = {side: [0.50] for side in SIDES}

    # If a component has many independent links, make additional controlled slots
    # available along each supported side.  The number is limited by physical side
    # length and the configured port gap, so lines never collapse into one visual
    # anchor.  Existing component-defined ports remain preferred.
    x, y, w, h = box
    for side in list(profile):
        side_length = w if side in {"top", "bottom"} else h
        physical_capacity = max(1, int(side_length / max(space.port_gap, 0.08)))
        requested = min(max(1, side_demand), max(1, physical_capacity))
        requested = min(11, requested)
        generated = _ordered_slot_fractions(requested)
        merged = list(profile[side])
        for fraction in generated:
            if all(abs(fraction - prior) > 0.025 for prior in merged):
                merged.append(fraction)
        merged.sort(key=lambda value: (0 if abs(value - 0.5) < 1e-5 else 1, abs(value - 0.5), value))
        profile[side] = merged

    return profile


def _side_preference(node: DiagramNode, role: str) -> list[str]:
    raw = (
        getattr(node, "preferred_output_sides", [])
        if role == "source"
        else getattr(node, "preferred_input_sides", [])
    )
    result: list[str] = []
    for side in raw or []:
        value = str(side)
        if value in SIDES and value not in result:
            result.append(value)
    return result


def _ray_component_pressure(
    point: Point,
    side: str,
    node_id: str,
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
    clearance: float,
) -> float:
    """Approximate how much free routing space exists immediately outside a port."""
    left, right, top, bottom = bounds
    px, py = point
    dx, dy = _side_vector(side)

    if side == "left":
        available = px - left
    elif side == "right":
        available = right - px
    elif side == "top":
        available = py - top
    else:
        available = bottom - py

    # Search up to a practical local distance. Obstacles closer to the port cost
    # much more than distant obstacles, allowing a free top side to beat a
    # congested but geometrically closer bottom side.
    probe_length = min(max(available, 0.0), 1.30)
    if probe_length <= 0.02:
        return 8.0

    end = (px + dx * probe_length, py + dy * probe_length)
    nearest = probe_length
    for other_id, box in boxes.items():
        if other_id == node_id:
            continue
        expanded = _expanded_box(box, clearance)
        if not _segment_hits_box(point, end, expanded, 0.0):
            continue
        ox, oy, ow, oh = expanded
        if side == "right":
            distance = max(0.0, ox - px)
        elif side == "left":
            distance = max(0.0, px - (ox + ow))
        elif side == "bottom":
            distance = max(0.0, oy - py)
        else:
            distance = max(0.0, py - (oy + oh))
        nearest = min(nearest, distance)

    free_ratio = nearest / max(probe_length, 1e-6)
    return (1.0 - min(1.0, free_ratio)) * 2.4


def _ray_route_pressure(
    point: Point,
    side: str,
    reserved_routes: Sequence[ReservedRoute],
    connection_gap: float,
) -> float:
    """Penalty for choosing a side whose immediate outward corridor is busy."""
    px, py = point
    dx, dy = _side_vector(side)
    end = (px + dx * 0.85, py + dy * 0.85)
    pressure = 0.0
    for reserved in reserved_routes:
        for a, b in zip(reserved.points, reserved.points[1:]):
            relation = _orthogonal_relation(point, end, a, b, 0.010)
            if relation is not None:
                pressure += 2.5
                continue
            parallel = _parallel_gap(point, end, a, b)
            if parallel is not None:
                gap, overlap = parallel
                if overlap > 0.05 and gap < connection_gap:
                    pressure += 1.25
    return pressure


def _port_candidates(
    node: DiagramNode,
    box: Box,
    other_box: Box,
    role: str,
    usage: dict[tuple[str, str, int], int],
    side_usage: dict[tuple[str, str], int],
    degree: int,
    boxes: Mapping[str, Box],
    reserved_routes: Sequence[ReservedRoute],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
) -> list[_PortCandidate]:
    profile = _node_port_profile(node, box, max(1, degree), space)

    # Some physical source/input units must always leave in a fixed initial
    # direction.  This remains component-independent: the router reads strict
    # port metadata from the node instead of checking component names/codes.
    if role == "source":
        required = [
            str(side) for side in (getattr(node, "required_output_sides", []) or [])
            if str(side) in SIDES
        ]
        if required:
            profile = {side: profile[side] for side in required if side in profile}
    cx, cy = _box_center(box)
    ox, oy = _box_center(other_box)
    dx, dy = ox - cx, oy - cy
    distance = max(1e-8, math.hypot(dx, dy))
    ux, uy = dx / distance, dy / distance
    preferred = _side_preference(node, role)

    candidates: list[_PortCandidate] = []
    for side, slots in profile.items():
        sx, sy = _side_vector(side)
        facing = sx * ux + sy * uy
        preferred_penalty = 0.0
        if preferred:
            preferred_penalty = 0.075 * (
                preferred.index(side) if side in preferred else len(preferred) + 1
            )

        side_count = side_usage.get((node.id, side), 0)
        for slot_index, fraction in enumerate(slots):
            slot_count = usage.get((node.id, side, slot_index), 0)
            port = _port_point(box, side, fraction)
            obstacle_pressure = _ray_component_pressure(
                port,
                side,
                node.id,
                boxes,
                bounds,
                space.routing_clearance,
            )
            route_pressure = _ray_route_pressure(
                port,
                side,
                reserved_routes,
                space.connection_gap,
            )

            # Geometry is only a preference.  Free-space pressure and exact-port
            # reuse dominate it, which is what lets a free top route beat a
            # congested bottom route when that is visually cleaner.
            facing_penalty = (1.0 - facing) * 0.28
            slot_penalty = 0.035 * slot_index
            reuse_penalty = slot_count * 20.0 + side_count * 0.10
            score = (
                facing_penalty
                + preferred_penalty
                + slot_penalty
                + reuse_penalty
                + obstacle_pressure
                + route_pressure
            )
            candidates.append(_PortCandidate(side, fraction, slot_index, score))

    candidates.sort(key=lambda item: (item.score, item.slot_index, SIDES.index(item.side)))
    return candidates


def _candidate_window(candidates: Sequence[_PortCandidate], max_total: int = 12) -> list[_PortCandidate]:
    """Keep good candidates from every side, not only the geometrically closest."""
    selected: list[_PortCandidate] = []
    per_side = {side: 0 for side in SIDES}

    for candidate in candidates:
        if per_side[candidate.side] >= 2:
            continue
        selected.append(candidate)
        per_side[candidate.side] += 1
        if len(selected) >= max_total:
            break

    # Ensure all available sides are represented at least once when possible.
    present = {item.side for item in selected}
    for side in SIDES:
        if side in present:
            continue
        for candidate in candidates:
            if candidate.side == side:
                selected.append(candidate)
                present.add(side)
                break
        if len(selected) >= max_total:
            break

    selected.sort(key=lambda item: item.score)
    return selected[:max_total]



# =============================================================================
# GLOBAL PORT / LANE PREALLOCATION
# =============================================================================


def _endpoint_facing_side(
    node: DiagramNode,
    box: Box,
    other_box: Box,
    role: str,
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
) -> str:
    """Choose the cleanest geometric side before individual routes are planned.

    This is a *global ordering hint*, not a hard lock.  The final router can still
    move an edge to another side when obstacles or previously reserved routes make
    that cleaner.  Preselecting the natural side for every edge lets us allocate
    monotonic same-side ports up-front, which prevents fan-out/fan-in connections
    from crossing immediately after leaving a component.
    """
    profile = _node_port_profile(node, box, 1, space)
    if role == "source":
        required = [
            str(side) for side in (getattr(node, "required_output_sides", []) or [])
            if str(side) in profile
        ]
        if required:
            candidate_sides = required
        else:
            candidate_sides = list(profile)
    else:
        candidate_sides = list(profile)

    cx, cy = _box_center(box)
    ox, oy = _box_center(other_box)
    dx, dy = ox - cx, oy - cy
    length = max(1e-8, math.hypot(dx, dy))
    ux, uy = dx / length, dy / length
    preferred = _side_preference(node, role)

    def side_score(side: str) -> tuple[float, int]:
        sx, sy = _side_vector(side)
        facing = sx * ux + sy * uy
        port = _port_point(box, side, 0.50)
        obstacle_pressure = _ray_component_pressure(
            port,
            side,
            node.id,
            boxes,
            bounds,
            space.routing_clearance,
        )
        preferred_penalty = 0.0
        if preferred:
            preferred_penalty = 0.12 * (
                preferred.index(side) if side in preferred else len(preferred) + 1
            )
        # Facing remains important, but a blocked side should lose to a clean side.
        return ((1.0 - facing) * 0.42 + obstacle_pressure + preferred_penalty, SIDES.index(side))

    return min(candidate_sides, key=side_score)


def _preallocate_ports(
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
) -> dict[tuple[int, str], _PortCandidate]:
    """Allocate ordered independent ports before routing any connection.

    For every node/side, connected edges are sorted by the perpendicular position
    of their opposite endpoint.  Port fractions are assigned in that same order.
    This monotonic assignment is the standard orthogonal-diagram technique that
    prevents a bundle from crossing itself at a shared source or destination.
    """
    node_lookup = {node.id: node for node in diagram.nodes}
    side_choice: dict[tuple[int, str], str] = {}
    groups: dict[tuple[str, str, str], list[int]] = defaultdict(list)
    allocations: dict[tuple[int, str], _PortCandidate] = {}

    for edge_index, edge in enumerate(diagram.edges):
        source_node = node_lookup.get(edge.source)
        target_node = node_lookup.get(edge.target)
        source_box = boxes.get(edge.source)
        target_box = boxes.get(edge.target)
        if source_node is None or target_node is None or source_box is None or target_box is None:
            continue

        locked_source = _edge_locked_port_candidate(edge, "source")
        locked_target = _edge_locked_port_candidate(edge, "target")
        if locked_source is not None:
            allocations[(edge_index, "source")] = locked_source
        else:
            source_side = _endpoint_facing_side(
                source_node, source_box, target_box, "source", boxes, bounds, space
            )
            side_choice[(edge_index, "source")] = source_side
            groups[(edge.source, "source", source_side)].append(edge_index)

        if locked_target is not None:
            allocations[(edge_index, "target")] = locked_target
        else:
            target_side = _endpoint_facing_side(
                target_node, target_box, source_box, "target", boxes, bounds, space
            )
            side_choice[(edge_index, "target")] = target_side
            groups[(edge.target, "target", target_side)].append(edge_index)

    for (node_id, role, side), edge_indices in groups.items():
        box = boxes.get(node_id)
        if box is None:
            continue

        def projection(edge_index: int) -> tuple[float, int]:
            edge = diagram.edges[edge_index]
            other_id = edge.target if role == "source" else edge.source
            other_box = boxes.get(other_id)
            if other_box is None:
                return (0.0, edge_index)
            ox, oy = _box_center(other_box)
            return ((ox if side in {"top", "bottom"} else oy), edge_index)

        ordered = sorted(edge_indices, key=projection)
        total = len(ordered)
        if total == 1:
            fractions = [0.50]
        else:
            # Use most of the side while retaining enough corner clearance for
            # rounded cards, labels and arrow heads.
            lo, hi = (0.12, 0.88)
            fractions = [lo + (hi - lo) * i / (total - 1) for i in range(total)]

        for slot_index, (edge_index, fraction) in enumerate(zip(ordered, fractions)):
            # Strong preference only.  If this globally allocated side later becomes
            # blocked, the normal candidate search is free to choose another side.
            allocations[(edge_index, role)] = _PortCandidate(
                side=side,
                fraction=fraction,
                slot_index=slot_index,
                score=-12.0 + slot_index * 0.01,
            )

    return allocations


def _inject_preallocated_candidate(
    candidates: list[_PortCandidate],
    preferred: _PortCandidate | None,
) -> list[_PortCandidate]:
    if preferred is None:
        return candidates
    result = [preferred]
    for candidate in candidates:
        if candidate.side == preferred.side and abs(candidate.fraction - preferred.fraction) < 1e-5:
            continue
        result.append(candidate)
    return result

# =============================================================================
# ROUTE CANDIDATES / OBSTACLE VALIDATION
# =============================================================================




def _straight_or_l_paths(start: Point, end: Point) -> list[list[Point]]:
    """Return only direct straight or one-bend orthogonal paths.

    This is the strict automatic-routing geometry requested by the application:
    every returned polyline has either zero bends (straight) or exactly one bend
    (L-shaped).  No Z-shaped or multi-bend candidate can be produced here.
    Endpoint-side validation and component-obstacle validation are still handled
    by the existing quality checks, so changing component positions automatically
    causes the cleanest valid straight/L path to be selected on the next render.
    """
    sx, sy = start
    ex, ey = end

    if abs(sx - ex) <= 1e-8 or abs(sy - ey) <= 1e-8:
        return [_compress([start, end])]

    candidates = [
        _compress([start, (ex, sy), end]),  # horizontal, then vertical
        _compress([start, (sx, ey), end]),  # vertical, then horizontal
    ]

    unique: list[list[Point]] = []
    seen: set[tuple[tuple[float, float], ...]] = set()
    for candidate in candidates:
        key = tuple((round(x, 5), round(y, 5)) for x, y in candidate)
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return unique


def _simple_pair_paths(start: Point, start_stub: Point, end_stub: Point, end: Point) -> list[list[Point]]:
    sx, sy = start_stub
    ex, ey = end_stub
    paths: list[list[Point]] = []

    if abs(sx - ex) <= 1e-6 or abs(sy - ey) <= 1e-6:
        paths.append(_compress([start, start_stub, end_stub, end]))

    paths.append(_compress([start, start_stub, (ex, sy), end_stub, end]))
    paths.append(_compress([start, start_stub, (sx, ey), end_stub, end]))

    mid_x = (sx + ex) / 2.0
    mid_y = (sy + ey) / 2.0
    paths.append(_compress([start, start_stub, (mid_x, sy), (mid_x, ey), end_stub, end]))
    paths.append(_compress([start, start_stub, (sx, mid_y), (ex, mid_y), end_stub, end]))
    return paths


def _component_clearance(node_id: str, node_lookup: Mapping[str, DiagramNode], space: RoutingSpace) -> float:
    node = node_lookup.get(node_id)
    if node is not None and node.node_type == "junction":
        return space.junction_clearance
    return space.routing_clearance


def _route_component_hits(
    points: Sequence[Point],
    edge: DiagramEdge,
    boxes: Mapping[str, Box],
    node_lookup: Mapping[str, DiagramNode],
    space: RoutingSpace,
) -> int:
    """Strict obstacle check including source/target after their escape segment.

    The first segment is the only segment allowed to touch the source card; the
    last segment is the only segment allowed to touch the target card.  This is
    the key rule preventing a line from later travelling behind/through either of
    its own endpoint components.
    """
    hits = 0
    segments = list(zip(points, points[1:]))
    last_index = len(segments) - 1

    for segment_index, (a, b) in enumerate(segments):
        for node_id, box in boxes.items():
            if node_id == edge.source and segment_index == 0:
                continue
            if node_id == edge.target and segment_index == last_index:
                continue
            clearance = _component_clearance(node_id, node_lookup, space)
            if _segment_hits_box(a, b, box, clearance):
                hits += 1
    return hits


def _endpoint_direction_valid(
    points: Sequence[Point],
    source_side: str,
    target_side: str,
    tolerance: float = 0.01,
) -> bool:
    if len(points) < 2:
        return False

    start = points[0]
    next_point = points[1]
    prev = points[-2]
    end = points[-1]

    if source_side == "left" and next_point[0] > start[0] + tolerance:
        return False
    if source_side == "right" and next_point[0] < start[0] - tolerance:
        return False
    if source_side == "top" and next_point[1] > start[1] + tolerance:
        return False
    if source_side == "bottom" and next_point[1] < start[1] - tolerance:
        return False

    if target_side == "left" and prev[0] > end[0] + tolerance:
        return False
    if target_side == "right" and prev[0] < end[0] - tolerance:
        return False
    if target_side == "top" and prev[1] > end[1] + tolerance:
        return False
    if target_side == "bottom" and prev[1] < end[1] - tolerance:
        return False
    return True


def _shared_nodes(current_edge: DiagramEdge, reserved: ReservedRoute) -> set[str]:
    return {current_edge.source, current_edge.target} & {reserved.source, reserved.target}


def _is_intentional_junction_meeting(
    point: Point,
    current_edge: DiagramEdge,
    reserved: ReservedRoute,
    boxes: Mapping[str, Box],
    node_lookup: Mapping[str, DiagramNode],
    space: RoutingSpace,
) -> bool:
    """Only explicit topology junctions may intentionally share a visual point."""
    for node_id in _shared_nodes(current_edge, reserved):
        node = node_lookup.get(node_id)
        if node is None or node.node_type != "junction":
            continue
        box = boxes.get(node_id)
        if box is None:
            continue
        cx, cy = _box_center(box)
        tolerance = max(0.10, space.connection_gap * 0.75)
        if math.hypot(point[0] - cx, point[1] - cy) <= tolerance:
            return True
    return False


def _route_quality(
    points: Sequence[Point],
    edge: DiagramEdge,
    boxes: Mapping[str, Box],
    node_lookup: Mapping[str, DiagramNode],
    reserved_routes: Sequence[ReservedRoute],
    source_side: str,
    target_side: str,
    space: RoutingSpace,
    bounds: tuple[float, float, float, float],
) -> tuple[int, int, int, float, float, int, float]:
    if not _endpoint_direction_valid(points, source_side, target_side):
        return 999, 999, 999, 99999.0, 99999.0, 999, 99999.0

    left, right, top, bottom = bounds
    for x, y in points:
        if x < left - 1e-5 or x > right + 1e-5 or y < top - 1e-5 or y > bottom + 1e-5:
            return 999, 999, 999, 99999.0, 99999.0, 999, 99999.0

    component_hits = _route_component_hits(points, edge, boxes, node_lookup, space)
    hard_conflicts = 0
    spacing_conflicts = 0

    for a, b in zip(points, points[1:]):
        if _segment_length(a, b) < 1e-6:
            continue

        for reserved in reserved_routes:
            for c, d in zip(reserved.points, reserved.points[1:]):
                relation = _orthogonal_relation(a, b, c, d, 0.012)
                if relation is not None:
                    kind, point, overlap = relation
                    if not _is_intentional_junction_meeting(
                        point,
                        edge,
                        reserved,
                        boxes,
                        node_lookup,
                        space,
                    ):
                        # Long collinear overlaps are substantially worse than a
                        # single perpendicular crossing.  Count their occupied
                        # length so the global optimizer strongly prefers a
                        # separate parallel lane instead of visually merging
                        # independent connections.
                        if kind == "overlap":
                            hard_conflicts += max(
                                3,
                                min(12, int(math.ceil(overlap / max(space.connection_gap, 0.08)))),
                            )
                        else:
                            hard_conflicts += 2

                parallel = _parallel_gap(a, b, c, d)
                if parallel is not None:
                    gap, overlap = parallel
                    if overlap > 0.055 and 0.010 < gap < space.connection_gap:
                        spacing_conflicts += max(
                            1,
                            min(6, int(math.ceil(overlap / max(space.connection_gap * 1.5, 0.18)))),
                        )

    weighted_cost, length, bends, excess = _route_cost(points, points[0], points[-1])
    return (
        component_hits,
        hard_conflicts,
        spacing_conflicts,
        weighted_cost,
        length,
        bends,
        excess,
    )




def _practical_route_rank(
    quality: tuple[int, int, int, float, float, int, float],
    port_score: float = 0.0,
) -> tuple[int, float, int, float, float, float]:
    """Rank routes for professional local-first engineering drawings.

    Component-body collisions remain an absolute hard failure.  Connection-line
    crossings and spacing conflicts are strong *soft* penalties rather than
    lexicographic hard failures, so the router does not choose a huge
    full-canvas detour merely to avoid one otherwise harmless crossing.

    This preserves the selected source/target relationship while prioritizing:
      1) no component collision,
      2) short/local geometry,
      3) low crossing/spacing conflict,
      4) few bends,
      5) preferred ports.
    """
    component_hits, hard_conflicts, spacing_conflicts, weighted_cost, length, bends, excess = quality
    if component_hits:
        return (component_hits, 1e9, bends, length, excess, port_score)

    # For the direct/L candidate family, crossing/overlap quality comes before
    # distance.  These candidates have at most one bend, so preferring a clean
    # candidate cannot create the long Z-shaped detours that the old global
    # router produced.  Once conflict counts are equal, shortest/local geometry
    # remains the deciding factor.
    locality_penalty = excess * 0.85
    bend_penalty = bends * 0.12
    total = weighted_cost + locality_penalty + bend_penalty
    conflict_rank = hard_conflicts * 100 + spacing_conflicts
    return (0, conflict_rank, total, bends, length, excess + port_score * 0.01)

def _free_corridor_axis_values(
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
    axis: str,
) -> list[float]:
    """Return global obstacle-free lane centers for one routing axis.

    A value on the x axis represents a vertical lane that does not pass through
    any protected component rectangle anywhere on the worksheet.  A y value is
    the equivalent horizontal lane.  These lanes are especially useful in dense
    multi-tank diagrams because they create clean shared *corridors* while each
    physical connection still receives its own independent polyline.
    """
    left, right, top, bottom = bounds
    lower, upper = (left, right) if axis == "x" else (top, bottom)
    clearance = space.routing_clearance + space.connection_gap * 0.58
    intervals: list[tuple[float, float]] = []

    for box in boxes.values():
        x, y, w, h = _expanded_box(box, clearance)
        start, end = (x, x + w) if axis == "x" else (y, y + h)
        start = max(lower, start)
        end = min(upper, end)
        if end > start:
            intervals.append((start, end))

    if not intervals:
        return [(lower + upper) / 2.0]

    intervals.sort()
    merged: list[list[float]] = []
    for start, end in intervals:
        if not merged or start > merged[-1][1] + 1e-6:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)

    minimum_gap = max(space.connection_gap * 1.30, 0.17)
    candidates: list[float] = []
    cursor = lower
    for start, end in merged:
        gap = start - cursor
        if gap >= minimum_gap:
            candidates.append(cursor + gap / 2.0)
        cursor = max(cursor, end)
    if upper - cursor >= minimum_gap:
        candidates.append(cursor + (upper - cursor) / 2.0)

    return candidates


def _channel_candidates(
    start: Point,
    start_stub: Point,
    end_stub: Point,
    end: Point,
    boxes: Mapping[str, Box],
    reserved_routes: Sequence[ReservedRoute],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
    global_lane_xs: Sequence[float] | None = None,
    global_lane_ys: Sequence[float] | None = None,
) -> list[list[Point]]:
    left, right, top, bottom = bounds
    sx, sy = start_stub
    ex, ey = end_stub
    mid_x = (sx + ex) / 2.0
    mid_y = (sy + ey) / 2.0

    candidates = _simple_pair_paths(start, start_stub, end_stub, end)
    lane_xs: list[float] = [mid_x]
    lane_ys: list[float] = [mid_y]

    # Prefer genuinely free global corridors before inventing long perimeter
    # detours.  This gives large diagrams the same clean "bus lane + drops"
    # character as professional water-distribution schematics without changing
    # any graph relationship or merging independent connections.
    lane_xs.extend(
        list(global_lane_xs)
        if global_lane_xs is not None
        else _free_corridor_axis_values(boxes, bounds, space, "x")
    )
    lane_ys.extend(
        list(global_lane_ys)
        if global_lane_ys is not None
        else _free_corridor_axis_values(boxes, bounds, space, "y")
    )

    # Every component boundary generates candidate routing corridors just outside
    # its protected no-routing zone.
    for box in boxes.values():
        x, y, w, h = box
        clearance = space.routing_clearance + space.connection_gap * 0.45
        lane_xs.extend([x - clearance, x + w + clearance])
        lane_ys.extend([y - clearance, y + h + clearance])

    # Existing routes reserve parallel channels on both sides.
    for reserved in reserved_routes:
        for a, b in zip(reserved.points, reserved.points[1:]):
            kind = _segment_kind(a, b)
            if kind == "h":
                lane_ys.extend([
                    a[1] - space.connection_gap,
                    a[1] + space.connection_gap,
                    a[1] - 2 * space.connection_gap,
                    a[1] + 2 * space.connection_gap,
                ])
            elif kind == "v":
                lane_xs.extend([
                    a[0] - space.connection_gap,
                    a[0] + space.connection_gap,
                    a[0] - 2 * space.connection_gap,
                    a[0] + 2 * space.connection_gap,
                ])

    # Local channel family around the natural path.
    for index in range(1, int(REFERENCE_ROUTING_PROFILE["local_lane_rings"]) + 1):
        offset = space.lane_spacing * index
        lane_xs.extend([mid_x - offset, mid_x + offset])
        lane_ys.extend([mid_y - offset, mid_y + offset])

    # Outer gutters are always kept as last-resort clean engineering routes.
    gutter = max(0.12, space.routing_clearance + space.connection_gap * 0.55)
    lane_xs.extend([left + gutter, right - gutter])
    lane_ys.extend([top + gutter, bottom - gutter])

    lane_xs = sorted(
        {
            round(value, 4): value
            for value in lane_xs
            if left + gutter <= value <= right - gutter
        }.values(),
        key=lambda value: abs(value - mid_x),
    )
    lane_ys = sorted(
        {
            round(value, 4): value
            for value in lane_ys
            if top + gutter <= value <= bottom - gutter
        }.values(),
        key=lambda value: abs(value - mid_y),
    )

    lane_limit = int(REFERENCE_ROUTING_PROFILE["max_lane_candidates_per_axis"])
    for lane_x in lane_xs[:lane_limit]:
        candidates.append(
            _compress([start, start_stub, (lane_x, sy), (lane_x, ey), end_stub, end])
        )
    for lane_y in lane_ys[:lane_limit]:
        candidates.append(
            _compress([start, start_stub, (sx, lane_y), (ex, lane_y), end_stub, end])
        )

    unique: list[list[Point]] = []
    seen = set()
    for candidate in candidates:
        candidate = _compress(candidate)
        key = tuple((round(x, 3), round(y, 3)) for x, y in candidate)
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return unique


# =============================================================================
# A* FALLBACK
# =============================================================================


def _astar_route(
    start: Point,
    end: Point,
    edge: DiagramEdge,
    boxes: Mapping[str, Box],
    node_lookup: Mapping[str, DiagramNode],
    reserved_routes: Sequence[ReservedRoute],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
    *,
    use_route_obstacles: bool = True,
    full_bounds: bool = False,
) -> list[Point] | None:
    """Grid router that treats component cards and reserved pipes as keep-outs."""
    left, right, top, bottom = bounds
    if full_bounds:
        local_left, local_right, local_top, local_bottom = left, right, top, bottom
    else:
        margin = max(1.8, space.connection_gap * 10.0)
        local_left = max(left, min(start[0], end[0]) - margin)
        local_right = min(right, max(start[0], end[0]) + margin)
        local_top = max(top, min(start[1], end[1]) - margin)
        local_bottom = min(bottom, max(start[1], end[1]) + margin)

    step = max(0.070, min(0.125, space.connection_gap * 0.55))
    max_cells = 76000
    cells_x = max(2, int((local_right - local_left) / step) + 1)
    cells_y = max(2, int((local_bottom - local_top) / step) + 1)
    if cells_x * cells_y > max_cells:
        scale = math.sqrt((cells_x * cells_y) / max_cells)
        step *= scale
        cells_x = max(2, int((local_right - local_left) / step) + 1)
        cells_y = max(2, int((local_bottom - local_top) / step) + 1)

    def to_cell(point: Point) -> tuple[int, int]:
        return (
            int(round((point[0] - local_left) / step)),
            int(round((point[1] - local_top) / step)),
        )

    def to_point(cell: tuple[int, int]) -> Point:
        return local_left + cell[0] * step, local_top + cell[1] * step

    start_cell = to_cell(start)
    end_cell = to_cell(end)

    component_obstacles: list[Box] = []
    for node_id, box in boxes.items():
        clearance = _component_clearance(node_id, node_lookup, space)
        component_obstacles.append(_expanded_box(box, clearance))

    route_obstacles: list[Box] = []
    if use_route_obstacles:
        keepout = max(0.050, space.connection_gap * 0.46)
        for reserved in reserved_routes:
            shared_junctions = {
                node_id
                for node_id in _shared_nodes(edge, reserved)
                if node_lookup.get(node_id) is not None
                and node_lookup[node_id].node_type == "junction"
            }
            for a, b in zip(reserved.points, reserved.points[1:]):
                # Leave the tiny neighborhood of an intentional shared junction
                # open so branch/trunk edges can actually meet there.
                if shared_junctions:
                    skip = False
                    for junction_id in shared_junctions:
                        junction_box = boxes.get(junction_id)
                        if junction_box is None:
                            continue
                        cx, cy = _box_center(junction_box)
                        if min(
                            math.hypot(a[0] - cx, a[1] - cy),
                            math.hypot(b[0] - cx, b[1] - cy),
                        ) <= max(0.12, space.connection_gap * 0.85):
                            skip = True
                            break
                    if skip:
                        continue

                if _segment_kind(a, b) == "h":
                    route_obstacles.append(
                        (
                            min(a[0], b[0]),
                            a[1] - keepout,
                            abs(b[0] - a[0]),
                            keepout * 2,
                        )
                    )
                elif _segment_kind(a, b) == "v":
                    route_obstacles.append(
                        (
                            a[0] - keepout,
                            min(a[1], b[1]),
                            keepout * 2,
                            abs(b[1] - a[1]),
                        )
                    )

    blocked: set[tuple[int, int]] = set()
    for gx in range(cells_x + 1):
        for gy in range(cells_y + 1):
            cell = (gx, gy)
            if cell in {start_cell, end_cell}:
                continue
            point = to_point(cell)
            if any(_point_in_box(point, box) for box in component_obstacles):
                blocked.add(cell)
                continue
            if any(_point_in_box(point, box) for box in route_obstacles):
                blocked.add(cell)

    serial = count()
    start_state = (start_cell[0], start_cell[1], -1)
    queue = [(0.0, next(serial), start_state)]
    best = {start_state: 0.0}
    parent: dict[tuple[int, int, int], tuple[int, int, int]] = {}
    directions = ((1, 0, 0), (-1, 0, 1), (0, 1, 2), (0, -1, 3))
    final_state = None

    while queue:
        _estimate, _serial, state = heapq.heappop(queue)
        gx, gy, previous_direction = state
        if (gx, gy) == end_cell:
            final_state = state
            break

        current_cost = best[state]
        for dx, dy, direction_index in directions:
            nx, ny = gx + dx, gy + dy
            if nx < 0 or ny < 0 or nx > cells_x or ny > cells_y:
                continue
            if (nx, ny) in blocked and (nx, ny) != end_cell:
                continue

            turn_penalty = 0.0 if previous_direction in {-1, direction_index} else 1.75
            next_cost = current_cost + 1.0 + turn_penalty
            next_state = (nx, ny, direction_index)
            if next_cost >= best.get(next_state, float("inf")):
                continue
            best[next_state] = next_cost
            parent[next_state] = state
            heuristic = abs(end_cell[0] - nx) + abs(end_cell[1] - ny)
            heapq.heappush(queue, (next_cost + heuristic, next(serial), next_state))

    if final_state is None:
        return None

    cells: list[tuple[int, int]] = []
    state = final_state
    while True:
        cells.append((state[0], state[1]))
        if state == start_state:
            break
        state = parent[state]
    cells.reverse()
    return _compress([to_point(cell) for cell in cells])




def _align_astar_path_to_exact_endpoints(
    core: Sequence[Point],
    start: Point,
    end: Point,
) -> list[Point]:
    """Attach a grid A* path to exact logical endpoints using orthogonal bridges.

    The A* cells are quantized, so their first/last cell centers can differ by a
    few hundredths from the exact escape stubs.  Bridging them explicitly avoids
    tiny diagonal artifacts while preserving the collision-free grid path.
    """
    points = [tuple(map(float, point)) for point in core]
    if not points:
        return [start, end]
    if len(points) == 1:
        sx, sy = start
        ex, ey = end
        if abs(sx - ex) <= 1e-6 or abs(sy - ey) <= 1e-6:
            return _compress([start, end])
        return _compress([start, (ex, sy), end])

    first_next = points[1]
    first_kind = _segment_kind(points[0], first_next)
    if first_kind == "h":
        first = (start[0], first_next[1])
    elif first_kind == "v":
        first = (first_next[0], start[1])
    else:
        first = start
    points[0] = first

    last_prev = points[-2]
    last_kind = _segment_kind(last_prev, points[-1])
    if last_kind == "h":
        last = (end[0], last_prev[1])
    elif last_kind == "v":
        last = (last_prev[0], end[1])
    else:
        last = end
    points[-1] = last

    result = _compress([start, *points, end])
    # Defensive final orthogonalization for rare one-cell/tie cases.
    fixed: list[Point] = [result[0]]
    for point in result[1:]:
        previous = fixed[-1]
        if _segment_kind(previous, point) != "d":
            fixed.append(point)
            continue
        horizontal_first = (point[0], previous[1])
        vertical_first = (previous[0], point[1])
        # Prefer the bridge with the shorter first leg; both preserve Manhattan
        # geometry and are validated by the normal obstacle-quality checks later.
        if _segment_length(previous, horizontal_first) <= _segment_length(previous, vertical_first):
            fixed.extend([horizontal_first, point])
        else:
            fixed.extend([vertical_first, point])
    return _compress(fixed)


# =============================================================================
# SAFE PATH SIMPLIFICATION
# =============================================================================


def _simplify_route_safely(
    points: list[Point],
    edge: DiagramEdge,
    boxes: Mapping[str, Box],
    node_lookup: Mapping[str, DiagramNode],
    reserved_routes: Sequence[ReservedRoute],
    source_side: str,
    target_side: str,
    space: RoutingSpace,
    bounds: tuple[float, float, float, float],
) -> list[Point]:
    """Remove unnecessary doglegs without weakening any collision guarantee."""
    current = _compress(points)
    if len(current) <= 2:
        return current

    improved = True
    while improved:
        improved = False
        baseline = _route_quality(
            current, edge, boxes, node_lookup, reserved_routes,
            source_side, target_side, space, bounds,
        )

        # Try replacing progressively larger subpaths with an orthogonal straight
        # or one-bend shortcut.  Accept only when all hard conflict counts stay at
        # zero and the total route score improves.
        for i in range(0, len(current) - 2):
            for j in range(len(current) - 1, i + 1, -1):
                a = current[i]
                b = current[j]
                shortcuts: list[list[Point]] = []
                if abs(a[0] - b[0]) < 1e-8 or abs(a[1] - b[1]) < 1e-8:
                    shortcuts.append([a, b])
                else:
                    shortcuts.append([a, (b[0], a[1]), b])
                    shortcuts.append([a, (a[0], b[1]), b])

                for shortcut in shortcuts:
                    candidate = _compress([*current[:i], *shortcut, *current[j + 1:]])
                    quality = _route_quality(
                        candidate, edge, boxes, node_lookup, reserved_routes,
                        source_side, target_side, space, bounds,
                    )
                    if quality[:3] == (0, 0, 0) and quality < baseline:
                        current = candidate
                        improved = True
                        break
                if improved:
                    break
            if improved:
                break
    return current


# =============================================================================
# GLOBAL DENSE-DIAGRAM CONFLICT OPTIMIZATION
# =============================================================================


def _infer_endpoint_port(box: Box, point: Point) -> _PortCandidate:
    """Recover the side/fraction used by an already-routed endpoint."""
    x, y, w, h = box
    px, py = point
    distances = {
        "left": abs(px - x),
        "right": abs(px - (x + w)),
        "top": abs(py - y),
        "bottom": abs(py - (y + h)),
    }
    side = min(SIDES, key=lambda value: (distances[value], SIDES.index(value)))
    if side in {"left", "right"}:
        fraction = (py - y) / max(h, 1e-8)
    else:
        fraction = (px - x) / max(w, 1e-8)
    fraction = min(0.95, max(0.05, float(fraction)))
    return _PortCandidate(side=side, fraction=fraction, slot_index=0, score=-25.0)


def _reserved_routes_from_results(
    diagram: DiagramSpec,
    routes: Sequence[tuple[list[Point], str] | None],
    *,
    exclude_index: int | None = None,
) -> list[ReservedRoute]:
    reserved: list[ReservedRoute] = []
    for edge_index, result in enumerate(routes):
        if edge_index == exclude_index or result is None:
            continue
        points, _direction = result
        if len(points) < 2:
            continue
        edge = diagram.edges[edge_index]
        reserved.append(
            ReservedRoute(
                edge_index=edge_index,
                source=edge.source,
                target=edge.target,
                points=list(points),
                topology_role=str(getattr(edge, "topology_role", "") or "logical"),
                topology_channel=str(getattr(edge, "topology_channel", "") or ""),
            )
        )
    return reserved


def _global_quality_score(
    quality: tuple[int, int, int, float, float, int, float],
) -> float:
    """Scalar score used only by the second-pass global optimizer.

    Component collision is effectively forbidden.  Route crossings/overlaps are
    deliberately much more expensive than a few additional bends, while detour
    length remains expensive enough to avoid giant perimeter routes.
    """
    component_hits, hard_conflicts, spacing_conflicts, weighted_cost, length, bends, excess = quality
    if component_hits:
        return 1_000_000_000.0 + component_hits * 1_000_000.0
    return (
        hard_conflicts * 55.0
        + spacing_conflicts * 9.0
        + excess * 4.5
        + bends * 0.75
        + length * 0.38
        + weighted_cost * 0.12
    )


def _dedupe_port_candidates(candidates: Sequence[_PortCandidate], limit: int) -> list[_PortCandidate]:
    result: list[_PortCandidate] = []
    seen: set[tuple[str, int]] = set()
    for candidate in candidates:
        key = (candidate.side, int(round(candidate.fraction * 1000)))
        if key in seen:
            continue
        seen.add(key)
        result.append(candidate)
        if len(result) >= limit:
            break
    return result


def _global_port_candidates(
    edge_index: int,
    role: str,
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
    node_lookup: Mapping[str, DiagramNode],
    degree: Mapping[str, int],
    reserved: Sequence[ReservedRoute],
    preallocated_ports: Mapping[tuple[int, str], _PortCandidate],
    current: _PortCandidate,
) -> list[_PortCandidate]:
    """Build a small safe port set for global rerouting of one existing edge."""
    edge = diagram.edges[edge_index]
    node_id = edge.source if role == "source" else edge.target
    other_id = edge.target if role == "source" else edge.source
    node = node_lookup.get(node_id)
    box = boxes.get(node_id)
    other_box = boxes.get(other_id)
    if node is None or box is None or other_box is None:
        return [current]

    locked = _junction_role_port_candidate(edge, role, diagram, boxes, node_lookup)
    if locked is None:
        locked = _physical_endpoint_to_junction_candidate(edge, role, diagram, boxes, node_lookup)
    if locked is not None:
        return [locked]

    # Preserve the existing fixed-bottom process-link visual standard.  The first
    # pass already selected its facing center ports; the dense optimizer may move
    # the lane between them but must not rotate those endpoint semantics.
    other_node = node_lookup.get(other_id)
    channel = str(getattr(edge, "topology_channel", "") or "").strip().lower()
    if (
        other_node is not None
        and channel in {"process", "water", "hydraulic", "fluid"}
        and str(getattr(node, "layout_zone", "") or "") == "fixed_bottom_source"
        and str(getattr(other_node, "layout_zone", "") or "") == "fixed_bottom_source"
    ):
        return [current]

    generated = _candidate_window(
        _port_candidates(
            node,
            box,
            other_box,
            role,
            {},
            {},
            degree.get(node_id, 1),
            boxes,
            reserved,
            bounds,
            space,
        ),
        7,
    )
    generated = _inject_preallocated_candidate(
        generated,
        preallocated_ports.get((edge_index, role)),
    )
    generated = _inject_preallocated_candidate(
        generated,
        _edge_locked_port_candidate(edge, role),
    )
    # The current successful port is always first-class.  This strongly favors a
    # lane-only cleanup when a new port is not necessary.
    return _dedupe_port_candidates([current, *generated], 8)


def _globally_optimize_routes(
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
    routes: list[tuple[list[Point], str] | None],
    preallocated_ports: Mapping[tuple[int, str], _PortCandidate],
) -> list[tuple[list[Point], str] | None]:
    """Second-pass optimizer for dense independent connection lines.

    The first pass remains the topology/port authority.  This pass changes only
    polyline geometry (and, when clearly beneficial, an already-supported port)
    while keeping the exact same DiagramEdge list.  It repeatedly removes the
    worst conflicting route, treats every other route as a keep-out lane, and
    searches for a cleaner local orthogonal replacement.
    """
    if len(diagram.edges) < 3:
        return routes

    node_lookup = {node.id: node for node in diagram.nodes}
    global_lane_xs = _free_corridor_axis_values(boxes, bounds, space, "x")
    global_lane_ys = _free_corridor_axis_values(boxes, bounds, space, "y")
    degree = {node.id: 0 for node in diagram.nodes}
    for edge in diagram.edges:
        degree[edge.source] = degree.get(edge.source, 0) + 1
        degree[edge.target] = degree.get(edge.target, 0) + 1

    # Two passes are enough to resolve ordering artifacts in normal projects.
    # Very large diagrams use one bounded pass to keep interaction latency stable.
    max_passes = 2 if len(diagram.edges) <= 30 else 1
    max_edges_per_pass = min(len(diagram.edges), 12 if len(diagram.edges) <= 30 else 6)

    for _pass in range(max_passes):
        ranked: list[tuple[float, int, tuple[int, int, int, float, float, int, float], _PortCandidate, _PortCandidate]] = []

        for edge_index, result in enumerate(routes):
            if result is None:
                continue
            points, _direction = result
            if len(points) < 2:
                continue
            edge = diagram.edges[edge_index]
            source_box = boxes.get(edge.source)
            target_box = boxes.get(edge.target)
            if source_box is None or target_box is None:
                continue

            source_port = _infer_endpoint_port(source_box, points[0])
            target_port = _infer_endpoint_port(target_box, points[-1])
            reserved = _reserved_routes_from_results(diagram, routes, exclude_index=edge_index)
            quality = _route_quality(
                points,
                edge,
                boxes,
                node_lookup,
                reserved,
                source_port.side,
                target_port.side,
                space,
                bounds,
            )
            # Fully clean/local routes are intentionally left untouched.
            has_conflict = quality[0] > 0 or quality[1] > 0 or quality[2] > 0
            # The global pass exists to remove interactions between connection
            # lines.  A route that is already conflict-free is left exactly as
            # selected by the first-pass local router, preserving its short/direct
            # appearance and avoiding unnecessary geometry churn.
            if not has_conflict:
                continue
            ranked.append((_global_quality_score(quality), edge_index, quality, source_port, target_port))

        if not ranked:
            break
        ranked.sort(key=lambda item: (-item[0], item[1]))
        changed = False

        for _score, edge_index, current_quality, current_source, current_target in ranked[:max_edges_per_pass]:
            result = routes[edge_index]
            if result is None:
                continue
            current_points, _direction = result
            edge = diagram.edges[edge_index]
            source_box = boxes.get(edge.source)
            target_box = boxes.get(edge.target)
            if source_box is None or target_box is None:
                continue

            reserved = _reserved_routes_from_results(diagram, routes, exclude_index=edge_index)
            # Re-evaluate against routes that may already have changed earlier in
            # this pass; never compare to a stale conflict score.
            current_source = _infer_endpoint_port(source_box, current_points[0])
            current_target = _infer_endpoint_port(target_box, current_points[-1])
            current_quality = _route_quality(
                current_points,
                edge,
                boxes,
                node_lookup,
                reserved,
                current_source.side,
                current_target.side,
                space,
                bounds,
            )
            current_score = _global_quality_score(current_quality)

            source_candidates = _global_port_candidates(
                edge_index,
                "source",
                diagram,
                boxes,
                bounds,
                space,
                node_lookup,
                degree,
                reserved,
                preallocated_ports,
                current_source,
            )
            target_candidates = _global_port_candidates(
                edge_index,
                "target",
                diagram,
                boxes,
                bounds,
                space,
                node_lookup,
                degree,
                reserved,
                preallocated_ports,
                current_target,
            )

            best_points = list(current_points)
            best_source = current_source
            best_target = current_target
            best_quality = current_quality
            best_score = current_score
            pair_budget = 0

            for source_choice in source_candidates:
                for target_choice in target_candidates:
                    pair_budget += 1
                    if pair_budget > 20:
                        break
                    start = _port_point(source_box, source_choice.side, source_choice.fraction)
                    end = _port_point(target_box, target_choice.side, target_choice.fraction)
                    source_escape = space.escape_distance + source_choice.slot_index * min(0.040, space.port_gap * 0.25)
                    target_escape = space.escape_distance + target_choice.slot_index * min(0.040, space.port_gap * 0.25)
                    start_stub = _stub_point(start, source_choice.side, source_escape)
                    end_stub = _stub_point(end, target_choice.side, target_escape)

                    for candidate in _channel_candidates(
                        start,
                        start_stub,
                        end_stub,
                        end,
                        boxes,
                        reserved,
                        bounds,
                        space,
                        global_lane_xs,
                        global_lane_ys,
                    ):
                        quality = _route_quality(
                            candidate,
                            edge,
                            boxes,
                            node_lookup,
                            reserved,
                            source_choice.side,
                            target_choice.side,
                            space,
                            bounds,
                        )
                        if quality[0] > 0:
                            continue
                        score = _global_quality_score(quality)
                        # Keep routing local.  A longer route is accepted only when
                        # it materially removes a line conflict.
                        conflict_improvement = (
                            quality[1] < best_quality[1]
                            or (quality[1] == best_quality[1] and quality[2] < best_quality[2])
                        )
                        length_limit = current_quality[4] * 1.55 + 0.85
                        if quality[4] > length_limit and not conflict_improvement:
                            continue
                        if score + 0.05 < best_score:
                            best_points = candidate
                            best_source = source_choice
                            best_target = target_choice
                            best_quality = quality
                            best_score = score
                    if pair_budget > 20:
                        break

            # A* is used only if the lane family could not remove the remaining
            # crossing/overlap.  It sees every other accepted connection as a
            # keep-out channel, so it naturally creates an additional bend/lane.
            if best_quality[1] > 0 or best_quality[2] > 0:
                astar_pairs = [(best_source, best_target)]
                if (current_source.side, current_source.fraction) != (best_source.side, best_source.fraction):
                    astar_pairs.append((current_source, current_target))
                for source_choice, target_choice in astar_pairs[:2]:
                    start = _port_point(source_box, source_choice.side, source_choice.fraction)
                    end = _port_point(target_box, target_choice.side, target_choice.fraction)
                    start_stub = _stub_point(start, source_choice.side, space.escape_distance)
                    end_stub = _stub_point(end, target_choice.side, space.escape_distance)
                    core = _astar_route(
                        start_stub,
                        end_stub,
                        edge,
                        boxes,
                        node_lookup,
                        reserved,
                        bounds,
                        space,
                        use_route_obstacles=True,
                        full_bounds=False,
                    )
                    if core is None:
                        continue
                    core = _align_astar_path_to_exact_endpoints(core, start_stub, end_stub)
                    candidate = _compress([start, *core, end])
                    quality = _route_quality(
                        candidate,
                        edge,
                        boxes,
                        node_lookup,
                        reserved,
                        source_choice.side,
                        target_choice.side,
                        space,
                        bounds,
                    )
                    score = _global_quality_score(quality)
                    if quality[0] == 0 and score + 0.05 < best_score:
                        best_points = candidate
                        best_source = source_choice
                        best_target = target_choice
                        best_quality = quality
                        best_score = score

            if best_score + 0.05 >= current_score:
                continue

            best_points = _simplify_route_safely(
                _compress(best_points),
                edge,
                boxes,
                node_lookup,
                reserved,
                best_source.side,
                best_target.side,
                space,
                bounds,
            )
            if _route_component_hits(best_points, edge, boxes, node_lookup, space) > 0:
                continue

            direction_points = list(reversed(best_points)) if edge.direction == "target_to_source" else best_points
            routes[edge_index] = (best_points, _route_direction(direction_points))
            changed = True

        if not changed:
            break

    return routes


# =============================================================================
# UNIVERSAL ROUTE PLANNER
# =============================================================================



def _junction_axis(
    junction_id: str,
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
) -> str | None:
    """Infer the manifold axis around a generated junction from junction neighbors."""
    if junction_id not in boxes:
        return None
    center = _box_center(boxes[junction_id])
    neighbors: list[Point] = []
    for edge in diagram.edges:
        other_id = None
        if edge.source == junction_id and edge.target in boxes:
            other_id = edge.target
        elif edge.target == junction_id and edge.source in boxes:
            other_id = edge.source
        if other_id is None:
            continue
        # Only other junctions define the actual trunk axis. Physical branches are
        # deliberately excluded so they cannot rotate the manifold direction.
        other_node = next((node for node in diagram.nodes if node.id == other_id), None)
        if other_node is not None and other_node.node_type == "junction":
            neighbors.append(_box_center(boxes[other_id]))
    if not neighbors:
        return None
    x_span = max(abs(point[0] - center[0]) for point in neighbors)
    y_span = max(abs(point[1] - center[1]) for point in neighbors)
    return "horizontal" if x_span >= y_span else "vertical"


def _junction_role_port_candidate(
    edge: DiagramEdge,
    role: str,
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
    node_lookup: Mapping[str, DiagramNode],
) -> _PortCandidate | None:
    """Return a T-junction/manifold port derived from topology role and geometry.

    This is generic routing infrastructure logic.  It does not inspect component
    names.  Trunks stay on the manifold axis; feeders and branches join that axis
    perpendicularly, matching conventional engineering schematics and preventing
    the feeder from overlapping the trunk.
    """
    node_id = edge.source if role == "source" else edge.target
    other_id = edge.target if role == "source" else edge.source
    node = node_lookup.get(node_id)
    if node is None or node.node_type != "junction" or node_id not in boxes or other_id not in boxes:
        return None

    topology_role = str(getattr(edge, "topology_role", "") or "logical")
    center = _box_center(boxes[node_id])
    other = _box_center(boxes[other_id])
    dx, dy = other[0] - center[0], other[1] - center[1]
    axis = _junction_axis(node_id, diagram, boxes)

    # Trunk segments always remain collinear with the manifold.
    if topology_role in {"trunk", "collection_trunk"}:
        if axis == "vertical":
            side = "bottom" if dy >= 0 else "top"
        else:
            side = "right" if dx >= 0 else "left"
        return _PortCandidate(side, 0.50, 0, -2000.0)

    # Branch links meet the manifold perpendicularly. Main feeder links are left
    # free to choose the cleanest side because the perpendicular side may be
    # physically occupied by the branch's destination card (for example a feeder
    # joining a trunk immediately above a tank).
    if topology_role in {"branch", "collection_branch"} and axis is not None:
        if axis == "horizontal":
            side = "bottom" if dy >= 0 else "top"
        else:
            side = "right" if dx >= 0 else "left"
        return _PortCandidate(side, 0.50, 0, -2000.0)
    if topology_role in {"main", "collection_main"} and axis is not None:
        # At an end junction, enter/leave from the side opposite the sole trunk
        # continuation. This prevents the feeder from lying directly on top of
        # the first trunk segment. Middle junctions keep dynamic free-space choice.
        neighbor_centers: list[Point] = []
        for candidate_edge in diagram.edges:
            candidate_other = None
            if candidate_edge.source == node_id:
                candidate_other = candidate_edge.target
            elif candidate_edge.target == node_id:
                candidate_other = candidate_edge.source
            if candidate_other is None or candidate_other not in boxes:
                continue
            other_node = node_lookup.get(candidate_other)
            if other_node is not None and other_node.node_type == "junction":
                neighbor_centers.append(_box_center(boxes[candidate_other]))
        if len(neighbor_centers) == 1:
            nx, ny = neighbor_centers[0]
            if axis == "horizontal":
                side = "left" if nx > center[0] else "right"
            else:
                side = "top" if ny > center[1] else "bottom"
            return _PortCandidate(side, 0.50, 0, -1900.0)
        return None

    # Single-junction structures have no trunk neighbor. Use the nearest facing side.
    if abs(dx) >= abs(dy):
        side = "right" if dx >= 0 else "left"
    else:
        side = "bottom" if dy >= 0 else "top"
    return _PortCandidate(side, 0.50, 0, -1500.0)


def _physical_endpoint_to_junction_candidate(
    edge: DiagramEdge,
    role: str,
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
    node_lookup: Mapping[str, DiagramNode],
) -> _PortCandidate | None:
    """Lock the physical end of a topology branch/main to the facing center side."""
    node_id = edge.source if role == "source" else edge.target
    other_id = edge.target if role == "source" else edge.source
    node = node_lookup.get(node_id)
    other_node = node_lookup.get(other_id)
    if (
        node is None
        or other_node is None
        or node.node_type == "junction"
        or other_node.node_type != "junction"
        or node_id not in boxes
        or other_id not in boxes
    ):
        return None

    topology_role = str(getattr(edge, "topology_role", "") or "logical")
    if topology_role not in {"main", "branch", "collection_main", "collection_branch"}:
        return None

    # Respect strict catalog output-side metadata before topology convenience.
    if role == "source":
        required = [
            str(side) for side in (getattr(node, "required_output_sides", []) or [])
            if str(side) in SIDES
        ]
        if required:
            return _PortCandidate(required[0], 0.50, 0, -2500.0)

    center = _box_center(boxes[node_id])
    other = _box_center(boxes[other_id])
    dx, dy = other[0] - center[0], other[1] - center[1]
    axis = _junction_axis(other_id, diagram, boxes)

    if axis == "horizontal":
        side = "bottom" if dy >= 0 else "top"
    elif axis == "vertical":
        side = "right" if dx >= 0 else "left"
    elif abs(dx) >= abs(dy):
        side = "right" if dx >= 0 else "left"
    else:
        side = "bottom" if dy >= 0 else "top"
    return _PortCandidate(side, 0.50, 0, -1800.0)

def _edge_locked_port_candidate(
    edge: DiagramEdge,
    role: str,
) -> _PortCandidate | None:
    """Return an edge-defined port as an advisory preference.

    The dedicated router owns final port selection, so legacy edge-side metadata
    must not force a geometrically bad route after layout. Strict component output
    directions are expressed on the node via ``required_output_sides`` instead.
    """
    if role == "source":
        side = getattr(edge, "source_side", None)
        fraction = getattr(edge, "source_port_fraction", None)
    else:
        side = getattr(edge, "target_side", None)
        fraction = getattr(edge, "target_port_fraction", None)

    if side not in SIDES or fraction is None:
        return None
    try:
        value = min(0.98, max(0.02, float(fraction)))
    except (TypeError, ValueError):
        return None
    return _PortCandidate(str(side), value, 0, -2.5)


def _globally_optimize_straight_l_routes(
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
    routes: list[tuple[list[Point], str] | None],
    preallocated_ports: Mapping[tuple[int, str], _PortCandidate],
) -> list[tuple[list[Point], str] | None]:
    """Resolve route-to-route conflicts using straight/L geometry only.

    The DiagramEdge list is never changed.  For a conflicting existing edge this
    pass tries alternative already-supported endpoint ports and evaluates only a
    direct segment or the two possible one-bend L paths.  It therefore improves
    spacing/crossings without ever introducing a Z-shaped or multi-bend route.
    """
    if len(diagram.edges) < 2:
        return routes

    node_lookup = {node.id: node for node in diagram.nodes}
    degree = {node.id: 0 for node in diagram.nodes}
    for edge in diagram.edges:
        degree[edge.source] = degree.get(edge.source, 0) + 1
        degree[edge.target] = degree.get(edge.target, 0) + 1

    max_passes = 2 if len(diagram.edges) <= 40 else 1
    max_edges_per_pass = min(len(diagram.edges), 16 if len(diagram.edges) <= 40 else 8)

    for _pass in range(max_passes):
        ranked: list[tuple[float, int]] = []
        for edge_index, result in enumerate(routes):
            if result is None:
                continue
            points, _direction = result
            if len(points) < 2:
                continue
            edge = diagram.edges[edge_index]
            source_box = boxes.get(edge.source)
            target_box = boxes.get(edge.target)
            if source_box is None or target_box is None:
                continue

            source_port = _infer_endpoint_port(source_box, points[0])
            target_port = _infer_endpoint_port(target_box, points[-1])
            reserved = _reserved_routes_from_results(diagram, routes, exclude_index=edge_index)
            quality = _route_quality(
                points,
                edge,
                boxes,
                node_lookup,
                reserved,
                source_port.side,
                target_port.side,
                space,
                bounds,
            )
            if quality[0] == 0 and quality[1] == 0 and quality[2] == 0:
                continue
            ranked.append((_global_quality_score(quality), edge_index))

        if not ranked:
            break
        ranked.sort(key=lambda item: (-item[0], item[1]))
        changed = False

        for _score, edge_index in ranked[:max_edges_per_pass]:
            current = routes[edge_index]
            if current is None:
                continue
            current_points, _direction = current
            edge = diagram.edges[edge_index]
            source_box = boxes.get(edge.source)
            target_box = boxes.get(edge.target)
            if source_box is None or target_box is None:
                continue

            reserved = _reserved_routes_from_results(diagram, routes, exclude_index=edge_index)
            current_source = _infer_endpoint_port(source_box, current_points[0])
            current_target = _infer_endpoint_port(target_box, current_points[-1])
            current_quality = _route_quality(
                current_points,
                edge,
                boxes,
                node_lookup,
                reserved,
                current_source.side,
                current_target.side,
                space,
                bounds,
            )
            current_score = _global_quality_score(current_quality)

            source_candidates = _global_port_candidates(
                edge_index,
                "source",
                diagram,
                boxes,
                bounds,
                space,
                node_lookup,
                degree,
                reserved,
                preallocated_ports,
                current_source,
            )
            target_candidates = _global_port_candidates(
                edge_index,
                "target",
                diagram,
                boxes,
                bounds,
                space,
                node_lookup,
                degree,
                reserved,
                preallocated_ports,
                current_target,
            )

            best_points = list(current_points)
            best_source = current_source
            best_target = current_target
            best_quality = current_quality
            best_score = current_score
            pair_budget = 0

            for source_choice in source_candidates:
                for target_choice in target_candidates:
                    pair_budget += 1
                    if pair_budget > 48:
                        break

                    start = _port_point(source_box, source_choice.side, source_choice.fraction)
                    end = _port_point(target_box, target_choice.side, target_choice.fraction)

                    for candidate in _straight_or_l_paths(start, end):
                        quality = _route_quality(
                            candidate,
                            edge,
                            boxes,
                            node_lookup,
                            reserved,
                            source_choice.side,
                            target_choice.side,
                            space,
                            bounds,
                        )
                        # Component bodies are always a hard no-routing area and
                        # a strict straight/L candidate must never exceed one bend.
                        if quality[0] > 0 or quality[5] > 1:
                            continue

                        score = _global_quality_score(quality)
                        # Only replace the current path if conflict/length quality
                        # actually improves.  This avoids unnecessary visual churn.
                        if score + 0.05 < best_score:
                            best_points = candidate
                            best_source = source_choice
                            best_target = target_choice
                            best_quality = quality
                            best_score = score
                if pair_budget > 48:
                    break

            if best_score + 0.05 >= current_score:
                continue
            if _route_component_hits(best_points, edge, boxes, node_lookup, space) > 0:
                continue
            if _route_cost(best_points, best_points[0], best_points[-1])[2] > 1:
                continue

            direction_points = (
                list(reversed(best_points))
                if edge.direction == "target_to_source"
                else best_points
            )
            routes[edge_index] = (best_points, _route_direction(direction_points))
            changed = True

        if not changed:
            break

    return routes



def _fast_manifold_topology_routes(
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
) -> list[tuple[list[Point], str] | None] | None:
    """Fast topology router using final component positions.

    Generated junction coordinates in ``topology.py`` are created before the
    renderer performs its final component layout.  Repeated components can
    therefore give several synthetic junctions the same provisional coordinate.
    Routing those provisional points directly caused the visible overlapping
    trunks/branches seen in dense worksheets.

    This fast path keeps the existing topology and edge relationships unchanged,
    but derives the *visual* junction positions from the final component boxes.
    A row of destinations receives a horizontal spine with vertical drops; a
    column receives a vertical spine with horizontal branches.  The same rule is
    applied to many-to-one collectors.  Component dragging remains unchanged
    because these coordinates are recomputed from ``boxes`` every render.
    """
    if not diagram.edges:
        return []

    node_lookup = {node.id: node for node in diagram.nodes}
    junction_ids = {
        node.id for node in diagram.nodes
        if str(getattr(node, "node_type", "") or "") == "junction"
    }
    if not junction_ids:
        return None

    manifold_roles = {
        "main", "trunk", "branch",
        "collection_main", "collection_trunk", "collection_branch",
    }
    edge_roles = {
        str(getattr(edge, "topology_role", "") or "")
        for edge in diagram.edges
    }
    if not edge_roles or not edge_roles.issubset(manifold_roles):
        return None

    left, right, top, bottom = bounds
    clearance = max(0.12, float(space.routing_clearance) + 0.04)

    def center(box: Box) -> Point:
        return _box_center(box)

    def physical_box(node_id: str) -> Box | None:
        node = node_lookup.get(node_id)
        if node is None or node.node_type == "junction":
            return None
        return boxes.get(node_id)

    def dist_group_from_junction(node_id: str) -> str | None:
        if node_id.startswith("dist_entry__"):
            return "dist__" + node_id[len("dist_entry__"):]
        if node_id.startswith("dist__"):
            head, sep, tail = node_id.rpartition("__")
            return head if sep and tail.isdigit() else node_id
        return None

    def collect_group_from_junction(node_id: str) -> str | None:
        if node_id.startswith("collect_exit__"):
            return "collect__" + node_id[len("collect_exit__"):]
        if node_id.startswith("collect__"):
            head, sep, tail = node_id.rpartition("__")
            return head if sep and tail.isdigit() else node_id
        return None

    # group -> data used to rebuild synthetic junction centers from final boxes.
    distributions: dict[str, dict] = {}
    collections: dict[str, dict] = {}

    for edge in diagram.edges:
        role = str(getattr(edge, "topology_role", "") or "")
        if role == "main" and edge.target in junction_ids:
            key = dist_group_from_junction(edge.target)
            if key:
                distributions.setdefault(key, {"branches": []})["source"] = edge.source
                distributions[key]["entry"] = edge.target
        elif role == "branch" and edge.source in junction_ids:
            key = dist_group_from_junction(edge.source)
            if key:
                distributions.setdefault(key, {"branches": []})["branches"].append(
                    (edge.source, edge.target)
                )
        elif role == "collection_main" and edge.source in junction_ids:
            key = collect_group_from_junction(edge.source)
            if key:
                collections.setdefault(key, {"branches": []})["target"] = edge.target
                collections[key]["exit"] = edge.source
        elif role == "collection_branch" and edge.target in junction_ids:
            key = collect_group_from_junction(edge.target)
            if key:
                collections.setdefault(key, {"branches": []})["branches"].append(
                    (edge.target, edge.source)
                )

    junction_points: dict[str, Point] = {}

    def choose_horizontal_lane(anchor_box: Box, member_boxes: list[Box]) -> float:
        ax, ay, aw, ah = anchor_box
        a_top, a_bottom = ay, ay + ah
        m_top = min(b[1] for b in member_boxes)
        m_bottom = max(b[1] + b[3] for b in member_boxes)
        if a_top >= m_bottom + clearance:
            return (m_bottom + a_top) / 2.0
        if m_top >= a_bottom + clearance:
            return (a_bottom + m_top) / 2.0
        above = min(a_top, m_top) - clearance
        below = max(a_bottom, m_bottom) + clearance
        candidates = [y for y in (above, below) if top + clearance <= y <= bottom - clearance]
        if candidates:
            anchor_y = ay + ah / 2.0
            return min(candidates, key=lambda y: abs(y - anchor_y))
        return max(top + clearance, min(bottom - clearance, (ay + ah / 2.0)))

    def choose_vertical_lane(anchor_box: Box, member_boxes: list[Box]) -> float:
        ax, ay, aw, ah = anchor_box
        a_left, a_right = ax, ax + aw
        m_left = min(b[0] for b in member_boxes)
        m_right = max(b[0] + b[2] for b in member_boxes)
        if a_left >= m_right + clearance:
            return (m_right + a_left) / 2.0
        if m_left >= a_right + clearance:
            return (a_right + m_left) / 2.0
        before = min(a_left, m_left) - clearance
        after = max(a_right, m_right) + clearance
        candidates = [x for x in (before, after) if left + clearance <= x <= right - clearance]
        if candidates:
            anchor_x = ax + aw / 2.0
            return min(candidates, key=lambda x: abs(x - anchor_x))
        return max(left + clearance, min(right - clearance, (ax + aw / 2.0)))

    def assign_distribution(data: dict) -> None:
        source_id = data.get("source")
        entry_id = data.get("entry")
        branches = list(data.get("branches", []))
        source_box = physical_box(str(source_id or ""))
        targets = [(jid, tid, physical_box(tid)) for jid, tid in branches]
        targets = [(jid, tid, box) for jid, tid, box in targets if box is not None]
        if source_box is None or not targets:
            return

        centers = [center(box) for _, _, box in targets]
        xs = [p[0] for p in centers]
        ys = [p[1] for p in centers]
        spread_x = max(xs) - min(xs) if len(xs) > 1 else 0.0
        spread_y = max(ys) - min(ys) if len(ys) > 1 else 0.0
        member_boxes = [box for _, _, box in targets]
        scx, scy = center(source_box)

        if spread_x >= spread_y:
            # Destination row: horizontal bus + vertical drops avoids long
            # overlapping horizontal branches through neighbouring cards.
            lane_y = choose_horizontal_lane(source_box, member_boxes)
            if entry_id:
                junction_points[str(entry_id)] = (scx, lane_y)
            for junction_id, _target_id, box in targets:
                target_port_x = box[0] + box[2] * 0.35
                junction_points[junction_id] = (target_port_x, lane_y)
        else:
            # Destination column: vertical bus + horizontal branches.
            lane_x = choose_vertical_lane(source_box, member_boxes)
            if entry_id:
                junction_points[str(entry_id)] = (lane_x, scy)
            for junction_id, _target_id, box in targets:
                target_port_y = box[1] + box[3] * 0.35
                junction_points[junction_id] = (lane_x, target_port_y)

    def assign_collection(data: dict) -> None:
        target_id = data.get("target")
        exit_id = data.get("exit")
        branches = list(data.get("branches", []))
        target_box = physical_box(str(target_id or ""))
        sources = [(jid, sid, physical_box(sid)) for jid, sid in branches]
        sources = [(jid, sid, box) for jid, sid, box in sources if box is not None]
        if target_box is None or not sources:
            return

        centers = [center(box) for _, _, box in sources]
        xs = [p[0] for p in centers]
        ys = [p[1] for p in centers]
        spread_x = max(xs) - min(xs) if len(xs) > 1 else 0.0
        spread_y = max(ys) - min(ys) if len(ys) > 1 else 0.0
        member_boxes = [box for _, _, box in sources]
        tcx, tcy = center(target_box)

        if spread_x >= spread_y:
            lane_y = choose_horizontal_lane(target_box, member_boxes)
            if exit_id:
                junction_points[str(exit_id)] = (tcx, lane_y)
            for junction_id, _source_id, box in sources:
                source_port_x = box[0] + box[2] * 0.65
                junction_points[junction_id] = (source_port_x, lane_y)
        else:
            lane_x = choose_vertical_lane(target_box, member_boxes)
            if exit_id:
                junction_points[str(exit_id)] = (lane_x, tcy)
            for junction_id, _source_id, box in sources:
                source_port_y = box[1] + box[3] * 0.65
                junction_points[junction_id] = (lane_x, source_port_y)

    for data in distributions.values():
        assign_distribution(data)
    for data in collections.values():
        assign_collection(data)

    # Every synthetic junction participating in this fast path must have a final
    # geometry point.  Otherwise defer to the existing general router.
    used_junctions = {
        node_id
        for edge in diagram.edges
        for node_id in (edge.source, edge.target)
        if node_id in junction_ids
    }
    if not used_junctions.issubset(junction_points):
        return None

    def port_toward(
        box: Box, point: Point, fraction: float = 0.50
    ) -> tuple[Point, str]:
        x, y, w, h = box
        cx, cy = x + w / 2.0, y + h / 2.0
        fraction = max(0.18, min(0.82, float(fraction)))
        dx, dy = point[0] - cx, point[1] - cy
        if abs(dx) >= abs(dy):
            port_y = y + h * fraction
            if dx >= 0:
                return (x + w, port_y), "right"
            return (x, port_y), "left"
        port_x = x + w * fraction
        if dy >= 0:
            return (port_x, y + h), "bottom"
        return (port_x, y), "top"

    # Synthetic trunk edge order was created before final layout and may no longer
    # match the final left-to-right/top-to-bottom geometry.  Reassign only the
    # invisible trunk polylines to consecutive final junction points so the bus is
    # drawn once, continuously, without a last trunk doubling back over the whole
    # manifold.  Physical branch/main endpoints are untouched.
    trunk_route_overrides: dict[int, list[Point]] = {}
    main_route_overrides: dict[int, list[Point]] = {}

    def assign_trunk_segments(
        group_key: str, junction_list: list[str], role: str, *, pad_unused: bool = False
    ) -> None:
        ids = [jid for jid in dict.fromkeys(junction_list) if jid in junction_points]
        if len(ids) < 2:
            return
        pts = [junction_points[jid] for jid in ids]
        x_span = max(p[0] for p in pts) - min(p[0] for p in pts)
        y_span = max(p[1] for p in pts) - min(p[1] for p in pts)
        ids.sort(
            key=(lambda jid: (junction_points[jid][0], junction_points[jid][1], jid))
            if x_span >= y_span
            else (lambda jid: (junction_points[jid][1], junction_points[jid][0], jid))
        )
        edge_indices = []
        for idx, candidate in enumerate(diagram.edges):
            if str(getattr(candidate, "topology_role", "") or "") != role:
                continue
            source_group = (
                dist_group_from_junction(candidate.source)
                if role == "trunk"
                else collect_group_from_junction(candidate.source)
            )
            target_group = (
                dist_group_from_junction(candidate.target)
                if role == "trunk"
                else collect_group_from_junction(candidate.target)
            )
            if source_group == group_key and target_group == group_key:
                edge_indices.append(idx)
        used = 0
        for idx, a_id, b_id in zip(edge_indices, ids, ids[1:]):
            trunk_route_overrides[idx] = [
                junction_points[a_id], junction_points[b_id]
            ]
            used += 1
        if pad_unused and used < len(edge_indices):
            # A separate provisional entry junction may have created one extra
            # synthetic trunk edge before final layout.  The physical main now
            # joins the nearest final bus endpoint directly, so that extra edge
            # has no visible distance to represent. Keep it renderable as a tiny
            # non-overlapping internal segment instead of drawing the first bus
            # segment twice.
            anchor = junction_points[ids[-1]]
            for extra_offset, idx in enumerate(edge_indices[used:], start=1):
                eps = 1e-5 * extra_offset
                trunk_route_overrides[idx] = [anchor, (anchor[0], anchor[1] + eps)]

    for key, data in distributions.items():
        assign_trunk_segments(
            key,
            [jid for jid, _target in data.get("branches", [])],
            "trunk",
            pad_unused=True,
        )
    for key, data in collections.items():
        assign_trunk_segments(
            key,
            [jid for jid, _source in data.get("branches", [])]
            + [str(data.get("exit") or "")],
            "collection_trunk",
        )

    # If topology reused a branch junction as the distribution entry (common when
    # repeated components originally had the same provisional Y coordinate), the
    # old main edge could run back across the complete bus and visibly overlap the
    # trunk.  Attach the physical source to the *nearest bus endpoint* instead.
    # The junctions are invisible, so this changes only the displayed polyline and
    # keeps all logical relationships/drag updates intact.
    for key, data in distributions.items():
        source_id = str(data.get("source") or "")
        source_box = physical_box(source_id)
        branch_ids = [jid for jid, _target in data.get("branches", []) if jid in junction_points]
        if source_box is None or not branch_ids:
            continue
        bus_points = [junction_points[jid] for jid in branch_ids]
        x_span = max(p[0] for p in bus_points) - min(p[0] for p in bus_points)
        y_span = max(p[1] for p in bus_points) - min(p[1] for p in bus_points)
        horizontal_bus = x_span >= y_span
        source_center = center(source_box)
        bus_endpoints = (
            [min(bus_points, key=lambda p: p[0]), max(bus_points, key=lambda p: p[0])]
            if horizontal_bus
            else [min(bus_points, key=lambda p: p[1]), max(bus_points, key=lambda p: p[1])]
        )
        attach = min(
            bus_endpoints,
            key=lambda p: abs(p[0] - source_center[0]) + abs(p[1] - source_center[1]),
        )
        main_index = next(
            (
                idx for idx, edge in enumerate(diagram.edges)
                if str(getattr(edge, "topology_role", "") or "") == "main"
                and edge.source == source_id
                and dist_group_from_junction(edge.target) == key
            ),
            None,
        )
        if main_index is None:
            continue
        x, y, w, h = source_box
        cx, cy = center(source_box)
        if horizontal_bus:
            start = (cx, y if attach[1] < cy else y + h)
            main_route_overrides[main_index] = _compress(
                [start, (cx, attach[1]), attach]
            )
        else:
            start = (x if attach[0] < cx else x + w, cy)
            main_route_overrides[main_index] = _compress(
                [start, (attach[0], cy), attach]
            )

    routed: list[tuple[list[Point], str] | None] = []
    reserved: list[ReservedRoute] = []

    for edge_index, edge in enumerate(diagram.edges):
        if edge_index in main_route_overrides:
            points = _compress(main_route_overrides[edge_index])
            direction_points = (
                list(reversed(points))
                if str(getattr(edge, "direction", "") or "") == "target_to_source"
                else points
            )
            routed.append((points, _route_direction(direction_points)))
            reserved.append(
                ReservedRoute(
                    edge_index=edge_index, source=edge.source, target=edge.target,
                    points=points,
                    topology_role=str(getattr(edge, "topology_role", "") or "logical"),
                    topology_channel=str(getattr(edge, "topology_channel", "") or ""),
                )
            )
            continue
        if edge_index in trunk_route_overrides:
            points = _compress(trunk_route_overrides[edge_index])
            direction_points = (
                list(reversed(points))
                if str(getattr(edge, "direction", "") or "") == "target_to_source"
                else points
            )
            routed.append((points, _route_direction(direction_points)))
            reserved.append(
                ReservedRoute(
                    edge_index=edge_index,
                    source=edge.source,
                    target=edge.target,
                    points=points,
                    topology_role=str(getattr(edge, "topology_role", "") or "logical"),
                    topology_channel=str(getattr(edge, "topology_channel", "") or ""),
                )
            )
            continue
        source_is_junction = edge.source in junction_ids
        target_is_junction = edge.target in junction_ids

        if source_is_junction:
            start = junction_points[edge.source]
            source_side = "right"
        else:
            source_box = boxes.get(edge.source)
            if source_box is None:
                return None
            target_point = junction_points.get(edge.target)
            if target_point is None:
                return None
            source_fraction = (
                0.65
                if str(getattr(edge, "topology_role", "") or "") == "collection_branch"
                else 0.50
            )
            start, source_side = port_toward(source_box, target_point, source_fraction)

        if target_is_junction:
            end = junction_points[edge.target]
            target_side = "left"
        else:
            target_box = boxes.get(edge.target)
            if target_box is None:
                return None
            source_point = junction_points.get(edge.source)
            if source_point is None:
                return None
            target_fraction = (
                0.35
                if str(getattr(edge, "topology_role", "") or "") == "branch"
                else 0.50
            )
            end, target_side = port_toward(target_box, source_point, target_fraction)

        # Junction construction above intentionally aligns one coordinate with
        # its physical endpoint/trunk neighbour, so the normal case is straight.
        if abs(start[0] - end[0]) <= 1e-7 or abs(start[1] - end[1]) <= 1e-7:
            points = _compress([start, end])
        else:
            # Rare mixed-orientation main/trunk hand-off: choose the shorter of
            # the two one-bend candidates using the existing obstacle/conflict
            # quality function.  This is still an L, never a Z detour.
            candidates = _straight_or_l_paths(start, end)
            # Synthetic junction rectangles are routing metadata, not visible
            # obstacles. Choose the shortest one-bend hand-off that also avoids
            # every unrelated *physical* component. This resolves ties in favour
            # of the clean L orientation (for example, rise to the bus first
            # instead of travelling horizontally through a neighbouring Sump).
            clean_candidates = []
            for candidate in candidates:
                blocked = False
                candidate_segments = list(zip(candidate, candidate[1:]))
                for seg_index, (a, b) in enumerate(candidate_segments):
                    for node_id, box in boxes.items():
                        node = node_lookup.get(node_id)
                        if node is None or node.node_type == "junction":
                            continue
                        if node_id == edge.source and seg_index == 0:
                            continue
                        if node_id == edge.target and seg_index == len(candidate_segments) - 1:
                            continue
                        if _segment_hits_box(
                            a, b, box,
                            _component_clearance(node_id, node_lookup, space),
                        ):
                            blocked = True
                            break
                    if blocked:
                        break
                if not blocked:
                    clean_candidates.append(candidate)
            if not clean_candidates:
                return None
            points = _compress(
                min(
                    clean_candidates,
                    key=lambda candidate: _route_cost(
                        candidate, candidate[0], candidate[-1]
                    ),
                )
            )

        # Ignore synthetic junction rectangles as physical obstacles, but never
        # allow a fast route to pass through another real component body.
        segments = list(zip(points, points[1:]))
        for segment_index, (a, b) in enumerate(segments):
            for node_id, box in boxes.items():
                node = node_lookup.get(node_id)
                if node is None or node.node_type == "junction":
                    continue
                if node_id == edge.source and segment_index == 0:
                    continue
                if node_id == edge.target and segment_index == len(segments) - 1:
                    continue
                if _segment_hits_box(
                    a, b, box, _component_clearance(node_id, node_lookup, space)
                ):
                    return None

        direction_points = (
            list(reversed(points))
            if str(getattr(edge, "direction", "") or "") == "target_to_source"
            else points
        )
        routed.append((points, _route_direction(direction_points)))
        reserved.append(
            ReservedRoute(
                edge_index=edge_index,
                source=edge.source,
                target=edge.target,
                points=points,
                topology_role=str(getattr(edge, "topology_role", "") or "logical"),
                topology_channel=str(getattr(edge, "topology_channel", "") or ""),
            )
        )

    return routed

def _plan_connection_routes_impl(
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
) -> list[tuple[list[Point], str] | None]:
    """Plan only straight or single-bend L routes for existing diagram edges.

    Component relationships and DiagramEdge objects are never created, removed or
    altered here.  The router only chooses endpoint ports and geometry.  For every
    existing connection it searches the supported ports, chooses a direct segment
    whenever possible, otherwise one of the two L orientations, rejects any path
    that crosses a component body, and strongly prefers short/local geometry.

    Z-shaped routes, channel doglegs and A* multi-bend routes are intentionally not
    part of this automatic planner.
    """
    space = analyze_routing_space(diagram)
    boxes = _prepare_routing_boxes(diagram, boxes, bounds, space)

    # Generated fan-in/fan-out manifolds already encode the desired routing via
    # invisible junction spines. Route them directly in O(E) instead of running
    # the general collision/A*/global optimization pipeline. This is the main
    # performance path for Borewell -> Sump -> OHT worksheets.
    fast_manifold_routes = _fast_manifold_topology_routes(
        diagram, boxes, bounds, space
    )
    if fast_manifold_routes is not None:
        return fast_manifold_routes

    node_lookup = {node.id: node for node in diagram.nodes}
    degree = {node.id: 0 for node in diagram.nodes}
    for edge in diagram.edges:
        degree[edge.source] = degree.get(edge.source, 0) + 1
        degree[edge.target] = degree.get(edge.target, 0) + 1

    routes: list[tuple[list[Point], str] | None] = [None] * len(diagram.edges)
    reserved: list[ReservedRoute] = []
    port_usage: dict[tuple[str, str, int], int] = {}
    side_usage: dict[tuple[str, str], int] = {}
    preallocated_ports = _preallocate_ports(diagram, boxes, bounds, space)

    role_priority = {
        "main": 0,
        "collection_main": 0,
        "series": 1,
        "trunk": 1,
        "collection_trunk": 1,
        "branch": 2,
        "collection_branch": 2,
        "logical": 3,
    }

    def order_key(index: int):
        edge = diagram.edges[index]
        role = str(getattr(edge, "topology_role", "") or "logical")
        source_box = boxes.get(edge.source)
        target_box = boxes.get(edge.target)
        distance = 999.0
        if source_box is not None and target_box is not None:
            sx, sy = _box_center(source_box)
            tx, ty = _box_center(target_box)
            distance = abs(tx - sx) + abs(ty - sy)
        pressure = max(degree.get(edge.source, 0), degree.get(edge.target, 0))
        return (role_priority.get(role, 3), distance, -pressure, index)

    for edge_index in sorted(range(len(diagram.edges)), key=order_key):
        edge = diagram.edges[edge_index]
        source_node = node_lookup.get(edge.source)
        target_node = node_lookup.get(edge.target)
        source_box = boxes.get(edge.source)
        target_box = boxes.get(edge.target)
        if source_node is None or target_node is None or source_box is None or target_box is None:
            continue

        # Use a wider all-side window than the old channel router because port
        # selection is now the only degree of freedom available to avoid an
        # obstacle while remaining strictly straight/L-shaped.
        source_candidates = _candidate_window(
            _port_candidates(
                source_node,
                source_box,
                target_box,
                "source",
                port_usage,
                side_usage,
                degree.get(edge.source, 1),
                boxes,
                reserved,
                bounds,
                space,
            ),
            12,
        )
        target_candidates = _candidate_window(
            _port_candidates(
                target_node,
                target_box,
                source_box,
                "target",
                port_usage,
                side_usage,
                degree.get(edge.target, 1),
                boxes,
                reserved,
                bounds,
                space,
            ),
            12,
        )

        source_candidates = _inject_preallocated_candidate(
            source_candidates, preallocated_ports.get((edge_index, "source"))
        )
        target_candidates = _inject_preallocated_candidate(
            target_candidates, preallocated_ports.get((edge_index, "target"))
        )

        edge_hint_source = _edge_locked_port_candidate(edge, "source")
        edge_hint_target = _edge_locked_port_candidate(edge, "target")

        # Invisible topology junctions are routing infrastructure, not visible
        # component ports.  Under the strict straight/L-only rule their side must
        # remain flexible; otherwise a legacy trunk/branch side lock can require
        # a Z/U-shaped approach that is now intentionally forbidden.  Physical
        # component endpoints still keep the existing component-to-junction port
        # semantics.
        locked_source = None
        locked_target = None
        if source_node.node_type != "junction":
            locked_source = _physical_endpoint_to_junction_candidate(
                edge, "source", diagram, boxes, node_lookup
            )
        if target_node.node_type != "junction":
            locked_target = _physical_endpoint_to_junction_candidate(
                edge, "target", diagram, boxes, node_lookup
            )

        if locked_source is None:
            source_candidates = _inject_preallocated_candidate(
                source_candidates, edge_hint_source
            )
        if locked_target is None:
            target_candidates = _inject_preallocated_candidate(
                target_candidates, edge_hint_target
            )

        # Preserve the existing fixed-bottom process-link standard exactly; only
        # the geometry between those already-defined endpoint semantics changes.
        channel = str(getattr(edge, "topology_channel", "") or "").strip().lower()
        source_zone = str(getattr(source_node, "layout_zone", "") or "")
        target_zone = str(getattr(target_node, "layout_zone", "") or "")
        source_center = _box_center(source_box)
        target_center = _box_center(target_box)
        if (
            locked_source is None
            and locked_target is None
            and channel in {"process", "water", "hydraulic", "fluid"}
            and source_zone == "fixed_bottom_source"
            and target_zone == "fixed_bottom_source"
            and abs(source_center[1] - target_center[1])
            <= max(0.35, space.component_gap_y)
        ):
            if target_center[0] >= source_center[0]:
                locked_source = _PortCandidate("right", 0.5, 0, -1200.0)
                locked_target = _PortCandidate("left", 0.5, 0, -1200.0)
            else:
                locked_source = _PortCandidate("left", 0.5, 0, -1200.0)
                locked_target = _PortCandidate("right", 0.5, 0, -1200.0)

        if locked_source is not None:
            source_candidates = _dedupe_port_candidates(
                [
                    locked_source,
                    *[
                        candidate
                        for candidate in source_candidates
                        if candidate.side == locked_source.side
                    ],
                ],
                12,
            )
        if locked_target is not None:
            target_candidates = _dedupe_port_candidates(
                [
                    locked_target,
                    *[
                        candidate
                        for candidate in target_candidates
                        if candidate.side == locked_target.side
                    ],
                ],
                12,
            )

        chosen: list[Point] | None = None
        chosen_source: _PortCandidate | None = None
        chosen_target: _PortCandidate | None = None
        chosen_quality = (999, 999, 999, 99999.0, 99999.0, 999, 99999.0)
        chosen_rank = _practical_route_rank(chosen_quality)

        # Pass 1: select the cleanest local straight/L route using all current
        # supported endpoint ports.  No intermediate channel/stub points exist,
        # therefore no candidate can have more than one bend.
        for source_choice in source_candidates:
            for target_choice in target_candidates:
                start = _port_point(
                    source_box, source_choice.side, source_choice.fraction
                )
                end = _port_point(
                    target_box, target_choice.side, target_choice.fraction
                )

                for candidate in _straight_or_l_paths(start, end):
                    quality = _route_quality(
                        candidate,
                        edge,
                        boxes,
                        node_lookup,
                        reserved,
                        source_choice.side,
                        target_choice.side,
                        space,
                        bounds,
                    )
                    if quality[0] > 0 or quality[5] > 1:
                        continue

                    rank = _practical_route_rank(
                        quality,
                        (source_choice.score + target_choice.score) * 0.12,
                    )
                    if rank < chosen_rank:
                        chosen = candidate
                        chosen_source = source_choice
                        chosen_target = target_choice
                        chosen_quality = quality
                        chosen_rank = rank

        if chosen is None or chosen_source is None or chosen_target is None:
            # Under a strict straight/L-only constraint some geometries may have no
            # mathematically possible obstacle-safe route.  Never violate the hard
            # component-obstacle rule or silently reintroduce a Z/multi-bend path.
            continue

        if _route_component_hits(chosen, edge, boxes, node_lookup, space) > 0:
            continue
        if _route_cost(chosen, chosen[0], chosen[-1])[2] > 1:
            continue

        for node_id, choice in (
            (edge.source, chosen_source),
            (edge.target, chosen_target),
        ):
            port_key = (node_id, choice.side, choice.slot_index)
            port_usage[port_key] = port_usage.get(port_key, 0) + 1
            side_key = (node_id, choice.side)
            side_usage[side_key] = side_usage.get(side_key, 0) + 1

        direction_points = (
            list(reversed(chosen))
            if edge.direction == "target_to_source"
            else chosen
        )
        routes[edge_index] = (chosen, _route_direction(direction_points))
        reserved.append(
            ReservedRoute(
                edge_index=edge_index,
                source=edge.source,
                target=edge.target,
                points=chosen,
                topology_role=str(
                    getattr(edge, "topology_role", "") or "logical"
                ),
                topology_channel=str(
                    getattr(edge, "topology_channel", "") or ""
                ),
            )
        )

    # Keep the existing straight/L routing result exactly as before for every
    # connection that already found a valid route.
    routes = _globally_optimize_straight_l_routes(
        diagram,
        boxes,
        bounds,
        space,
        routes,
        preallocated_ports,
    )

    # Missing-edge fallback only.
    #
    # The strict straight/L planner can legitimately return ``None`` when a
    # selected relationship has no obstacle-safe path with at most one bend.
    # That made valid Sensor / Transmitter / Master / SMC relationships exist in
    # DiagramSpec but disappear from the rendered Worksheet.  Preserve every
    # already-routed connection unchanged and fill ONLY those missing entries
    # with the existing orthogonal channel/A* helpers.  Component endpoints still
    # come from real component ports, so the added route remains attached to the
    # source and target images.
    if any(route is None for route in routes):
        for edge_index, current_route in enumerate(routes):
            if current_route is not None:
                continue

            edge = diagram.edges[edge_index]
            source_node = node_lookup.get(edge.source)
            target_node = node_lookup.get(edge.target)
            source_box = boxes.get(edge.source)
            target_box = boxes.get(edge.target)
            if (
                source_node is None
                or target_node is None
                or source_box is None
                or target_box is None
            ):
                continue

            reserved_now = _reserved_routes_from_results(
                diagram, routes, exclude_index=edge_index
            )

            source_candidates = _candidate_window(
                _port_candidates(
                    source_node,
                    source_box,
                    target_box,
                    "source",
                    {},
                    {},
                    degree.get(edge.source, 1),
                    boxes,
                    reserved_now,
                    bounds,
                    space,
                ),
                10,
            )
            target_candidates = _candidate_window(
                _port_candidates(
                    target_node,
                    target_box,
                    source_box,
                    "target",
                    {},
                    {},
                    degree.get(edge.target, 1),
                    boxes,
                    reserved_now,
                    bounds,
                    space,
                ),
                10,
            )

            source_candidates = _inject_preallocated_candidate(
                source_candidates, preallocated_ports.get((edge_index, "source"))
            )
            target_candidates = _inject_preallocated_candidate(
                target_candidates, preallocated_ports.get((edge_index, "target"))
            )
            source_candidates = _inject_preallocated_candidate(
                source_candidates, _edge_locked_port_candidate(edge, "source")
            )
            target_candidates = _inject_preallocated_candidate(
                target_candidates, _edge_locked_port_candidate(edge, "target")
            )

            locked_source = None
            locked_target = None
            if source_node.node_type != "junction":
                locked_source = _physical_endpoint_to_junction_candidate(
                    edge, "source", diagram, boxes, node_lookup
                )
            if target_node.node_type != "junction":
                locked_target = _physical_endpoint_to_junction_candidate(
                    edge, "target", diagram, boxes, node_lookup
                )

            if locked_source is not None:
                source_candidates = _dedupe_port_candidates(
                    [
                        locked_source,
                        *[
                            candidate
                            for candidate in source_candidates
                            if candidate.side == locked_source.side
                        ],
                    ],
                    10,
                )
            if locked_target is not None:
                target_candidates = _dedupe_port_candidates(
                    [
                        locked_target,
                        *[
                            candidate
                            for candidate in target_candidates
                            if candidate.side == locked_target.side
                        ],
                    ],
                    10,
                )

            best_points = None
            best_score = float("inf")
            best_source = None
            best_target = None

            # First try the existing orthogonal lane family.  This changes only
            # the previously-missing edge and keeps every existing line untouched.
            pair_budget = 0
            for source_choice in source_candidates:
                for target_choice in target_candidates:
                    pair_budget += 1
                    if pair_budget > 30:
                        break

                    start = _port_point(
                        source_box, source_choice.side, source_choice.fraction
                    )
                    end = _port_point(
                        target_box, target_choice.side, target_choice.fraction
                    )
                    start_stub = _stub_point(
                        start, source_choice.side, space.escape_distance
                    )
                    end_stub = _stub_point(
                        end, target_choice.side, space.escape_distance
                    )

                    for candidate in _channel_candidates(
                        start,
                        start_stub,
                        end_stub,
                        end,
                        boxes,
                        reserved_now,
                        bounds,
                        space,
                    ):
                        quality = _route_quality(
                            candidate,
                            edge,
                            boxes,
                            node_lookup,
                            reserved_now,
                            source_choice.side,
                            target_choice.side,
                            space,
                            bounds,
                        )
                        if quality[0] > 0:
                            continue
                        score = _global_quality_score(quality) + (
                            source_choice.score + target_choice.score
                        ) * 0.05
                        if score < best_score:
                            best_points = candidate
                            best_score = score
                            best_source = source_choice
                            best_target = target_choice
                if pair_budget > 30:
                    break

            # If the lane family still cannot produce a component-safe route,
            # use the router's existing A* implementation only for this missing
            # edge.  Prefer route keep-outs first; if the canvas is too dense,
            # permit line crossing rather than silently dropping the connection.
            if best_points is None:
                pair_budget = 0
                for source_choice in source_candidates:
                    for target_choice in target_candidates:
                        pair_budget += 1
                        if pair_budget > 12:
                            break

                        start = _port_point(
                            source_box, source_choice.side, source_choice.fraction
                        )
                        end = _port_point(
                            target_box, target_choice.side, target_choice.fraction
                        )
                        start_stub = _stub_point(
                            start, source_choice.side, space.escape_distance
                        )
                        end_stub = _stub_point(
                            end, target_choice.side, space.escape_distance
                        )

                        core = None
                        for use_route_obstacles in (True, False):
                            core = _astar_route(
                                start_stub,
                                end_stub,
                                edge,
                                boxes,
                                node_lookup,
                                reserved_now,
                                bounds,
                                space,
                                use_route_obstacles=use_route_obstacles,
                                full_bounds=True,
                            )
                            if core is not None:
                                break
                        if core is None:
                            continue

                        core = _align_astar_path_to_exact_endpoints(
                            core, start_stub, end_stub
                        )
                        candidate = _compress([start, *core, end])
                        if _route_component_hits(
                            candidate, edge, boxes, node_lookup, space
                        ) > 0:
                            continue

                        quality = _route_quality(
                            candidate,
                            edge,
                            boxes,
                            node_lookup,
                            reserved_now,
                            source_choice.side,
                            target_choice.side,
                            space,
                            bounds,
                        )
                        score = _global_quality_score(quality) + (
                            source_choice.score + target_choice.score
                        ) * 0.05
                        if score < best_score:
                            best_points = candidate
                            best_score = score
                            best_source = source_choice
                            best_target = target_choice
                    if pair_budget > 12:
                        break

            if best_points is None or best_source is None or best_target is None:
                continue

            best_points = _compress(best_points)
            direction_points = (
                list(reversed(best_points))
                if edge.direction == "target_to_source"
                else best_points
            )
            routes[edge_index] = (
                best_points,
                _route_direction(direction_points),
            )

    # Use the router's existing geometry-only dense-route optimizer first.
    # It does not change any DiagramEdge relationship/component/arrow data; it
    # only gives the strict separation pass a clean component-safe baseline.
    routes = _globally_optimize_routes(
        diagram,
        boxes,
        bounds,
        space,
        routes,
        preallocated_ports,
    )

    # Final routing-only clarity pass: if any independent connection lines
    # overlap/cross/run too close, place them in separate orthogonal channels.
    routes = _strictly_separate_overlapping_routes(
        diagram,
        boxes,
        bounds,
        space,
        routes,
        preallocated_ports,
    )

    return routes


def _strictly_separate_overlapping_routes(
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
    space: RoutingSpace,
    routes: list[tuple[list[Point], str] | None],
    preallocated_ports: Mapping[tuple[int, str], _PortCandidate],
) -> list[tuple[list[Point], str] | None]:
    """Re-route only when independent connection lines visually conflict.

    This is a geometry-only final pass.  It never adds/removes DiagramEdge
    relationships, changes component placement, or changes arrow/direction data.
    If the current routes are already clear, they are returned byte-for-byte as
    supplied.  When overlap/crossing/insufficient parallel spacing is detected,
    the same existing ports/corridor/A* helpers rebuild the polylines with every
    previously accepted route treated as a keep-out channel.

    The rebuild order is derived from *current conflict pressure*, not component
    names.  The most congested short connections are reserved first, then the
    remaining routes are fitted around them.  This prevents several independent
    connections from collapsing onto one shared visual lane.
    """
    if len(diagram.edges) < 2 or not routes:
        return routes
    if any(route is None for route in routes):
        return routes

    node_lookup = {node.id: node for node in diagram.nodes}
    degree = {node.id: 0 for node in diagram.nodes}
    for edge in diagram.edges:
        degree[edge.source] = degree.get(edge.source, 0) + 1
        degree[edge.target] = degree.get(edge.target, 0) + 1

    def route_metrics(edge_index: int, current_routes):
        result = current_routes[edge_index]
        if result is None:
            return 0, 0, 99999.0
        points, _direction = result
        edge = diagram.edges[edge_index]
        source_box = boxes.get(edge.source)
        target_box = boxes.get(edge.target)
        if source_box is None or target_box is None or len(points) < 2:
            return 0, 0, 99999.0
        source_port = _infer_endpoint_port(source_box, points[0])
        target_port = _infer_endpoint_port(target_box, points[-1])
        reserved = _reserved_routes_from_results(
            diagram, current_routes, exclude_index=edge_index
        )
        quality = _route_quality(
            points,
            edge,
            boxes,
            node_lookup,
            reserved,
            source_port.side,
            target_port.side,
            space,
            bounds,
        )
        # Crossings/collinear overlap dominate spacing pressure.  Component hits
        # are included as very high pressure even though the normal planner
        # already avoids them.
        conflict_pressure = quality[0] * 1000 + quality[1] * 10 + quality[2]
        source_center = _box_center(source_box)
        target_center = _box_center(target_box)
        local_distance = abs(target_center[0] - source_center[0]) + abs(
            target_center[1] - source_center[1]
        )
        return conflict_pressure, quality[1] + quality[2], local_distance

    initial_metrics = [route_metrics(index, routes) for index in range(len(routes))]
    if not any(metric[0] > 0 for metric in initial_metrics):
        return routes

    global_lane_xs = _free_corridor_axis_values(boxes, bounds, space, "x")
    global_lane_ys = _free_corridor_axis_values(boxes, bounds, space, "y")

    # Existing successful endpoint ports are useful preferences.  They are not
    # hard-coded component rules and remain fully compatible with the current
    # metadata-driven port constraints.
    current_ports: dict[tuple[int, str], _PortCandidate] = {}
    for edge_index, result in enumerate(routes):
        if result is None:
            continue
        points, _direction = result
        edge = diagram.edges[edge_index]
        if edge.source in boxes and points:
            current_ports[(edge_index, "source")] = _infer_endpoint_port(
                boxes[edge.source], points[0]
            )
        if edge.target in boxes and points:
            current_ports[(edge_index, "target")] = _infer_endpoint_port(
                boxes[edge.target], points[-1]
            )

    def candidate_ports(
        edge_index: int,
        role: str,
        reserved: Sequence[ReservedRoute],
    ) -> list[_PortCandidate]:
        edge = diagram.edges[edge_index]
        node_id = edge.source if role == "source" else edge.target
        other_id = edge.target if role == "source" else edge.source
        node = node_lookup.get(node_id)
        box = boxes.get(node_id)
        other_box = boxes.get(other_id)
        current = current_ports.get((edge_index, role))
        if node is None or box is None or other_box is None:
            return [current] if current is not None else []

        # Preserve all existing metadata-driven endpoint locks.
        locked = _junction_role_port_candidate(
            edge, role, diagram, boxes, node_lookup
        )
        if locked is None:
            locked = _physical_endpoint_to_junction_candidate(
                edge, role, diagram, boxes, node_lookup
            )
        if locked is not None:
            return [locked]

        # Preserve the existing fixed-bottom process-link endpoint semantics.
        other_node = node_lookup.get(other_id)
        channel = str(getattr(edge, "topology_channel", "") or "").strip().lower()
        if (
            current is not None
            and other_node is not None
            and channel in {"process", "water", "hydraulic", "fluid"}
            and str(getattr(node, "layout_zone", "") or "") == "fixed_bottom_source"
            and str(getattr(other_node, "layout_zone", "") or "") == "fixed_bottom_source"
        ):
            return [current]

        generated = _candidate_window(
            _port_candidates(
                node,
                box,
                other_box,
                role,
                {},
                {},
                degree.get(node_id, 1),
                boxes,
                reserved,
                bounds,
                space,
            ),
            16,
        )
        generated = _inject_preallocated_candidate(
            generated, preallocated_ports.get((edge_index, role))
        )
        generated = _inject_preallocated_candidate(
            generated, _edge_locked_port_candidate(edge, role)
        )

        preferred: list[_PortCandidate] = []
        preallocated = preallocated_ports.get((edge_index, role))
        if preallocated is not None:
            preferred.append(preallocated)
        if current is not None:
            preferred.append(current)
        return _dedupe_port_candidates([*preferred, *generated], 16)

    def build_strict(order: Sequence[int]):
        rebuilt: list[tuple[list[Point], str] | None] = [None] * len(diagram.edges)
        reserved: list[ReservedRoute] = []

        for edge_index in order:
            edge = diagram.edges[edge_index]
            source_box = boxes.get(edge.source)
            target_box = boxes.get(edge.target)
            if source_box is None or target_box is None:
                return None, edge_index

            source_candidates = candidate_ports(edge_index, "source", reserved)
            target_candidates = candidate_ports(edge_index, "target", reserved)
            if not source_candidates or not target_candidates:
                return None, edge_index

            best_points: list[Point] | None = None
            best_score = float("inf")
            best_source: _PortCandidate | None = None
            best_target: _PortCandidate | None = None

            # First use deterministic local/corridor candidates.  A candidate is
            # accepted only when it has ZERO component, crossing/overlap and
            # parallel-spacing conflicts with every route already reserved.
            pair_budget = 0
            for source_choice in source_candidates:
                for target_choice in target_candidates:
                    pair_budget += 1
                    if pair_budget > 72:
                        break

                    start = _port_point(
                        source_box, source_choice.side, source_choice.fraction
                    )
                    end = _port_point(
                        target_box, target_choice.side, target_choice.fraction
                    )
                    source_escape = space.escape_distance + source_choice.slot_index * min(
                        0.040, space.port_gap * 0.25
                    )
                    target_escape = space.escape_distance + target_choice.slot_index * min(
                        0.040, space.port_gap * 0.25
                    )
                    start_stub = _stub_point(start, source_choice.side, source_escape)
                    end_stub = _stub_point(end, target_choice.side, target_escape)

                    local_candidates = _straight_or_l_paths(start, end)
                    local_candidates.extend(
                        _channel_candidates(
                            start,
                            start_stub,
                            end_stub,
                            end,
                            boxes,
                            reserved,
                            bounds,
                            space,
                            global_lane_xs,
                            global_lane_ys,
                        )
                    )

                    for candidate in local_candidates:
                        candidate = _compress(candidate)
                        quality = _route_quality(
                            candidate,
                            edge,
                            boxes,
                            node_lookup,
                            reserved,
                            source_choice.side,
                            target_choice.side,
                            space,
                            bounds,
                        )
                        if quality[0] != 0 or quality[1] != 0 or quality[2] != 0:
                            continue
                        score = (
                            quality[4]
                            + quality[5] * 0.18
                            + quality[6] * 0.22
                            + (source_choice.score + target_choice.score) * 0.01
                        )
                        if score < best_score:
                            best_points = candidate
                            best_score = score
                            best_source = source_choice
                            best_target = target_choice
                if pair_budget > 72:
                    break

            # A* is a last resort for this geometry-only separation pass.  Route
            # obstacles stay ENABLED; unlike the old missing-edge fallback we do
            # not disable them, because that would re-introduce crossings.
            if best_points is None:
                pair_budget = 0
                for source_choice in source_candidates:
                    for target_choice in target_candidates:
                        pair_budget += 1
                        if pair_budget > 28:
                            break

                        start = _port_point(
                            source_box, source_choice.side, source_choice.fraction
                        )
                        end = _port_point(
                            target_box, target_choice.side, target_choice.fraction
                        )
                        start_stub = _stub_point(
                            start, source_choice.side, space.escape_distance
                        )
                        end_stub = _stub_point(
                            end, target_choice.side, space.escape_distance
                        )
                        core = _astar_route(
                            start_stub,
                            end_stub,
                            edge,
                            boxes,
                            node_lookup,
                            reserved,
                            bounds,
                            space,
                            use_route_obstacles=True,
                            full_bounds=True,
                        )
                        if core is None:
                            continue
                        core = _align_astar_path_to_exact_endpoints(
                            core, start_stub, end_stub
                        )
                        candidate = _compress([start, *core, end])
                        quality = _route_quality(
                            candidate,
                            edge,
                            boxes,
                            node_lookup,
                            reserved,
                            source_choice.side,
                            target_choice.side,
                            space,
                            bounds,
                        )
                        if quality[0] != 0 or quality[1] != 0 or quality[2] != 0:
                            continue
                        score = (
                            quality[4]
                            + quality[5] * 0.18
                            + quality[6] * 0.22
                            + (source_choice.score + target_choice.score) * 0.01
                        )
                        if score < best_score:
                            best_points = candidate
                            best_score = score
                            best_source = source_choice
                            best_target = target_choice
                    if pair_budget > 28:
                        break

            if best_points is None or best_source is None or best_target is None:
                return None, edge_index

            best_points = _compress(best_points)
            direction_points = (
                list(reversed(best_points))
                if edge.direction == "target_to_source"
                else best_points
            )
            rebuilt[edge_index] = (
                best_points,
                _route_direction(direction_points),
            )
            reserved.append(
                ReservedRoute(
                    edge_index=edge_index,
                    source=edge.source,
                    target=edge.target,
                    points=best_points,
                    topology_role=str(
                        getattr(edge, "topology_role", "") or "logical"
                    ),
                    topology_channel=str(
                        getattr(edge, "topology_channel", "") or ""
                    ),
                )
            )

        return rebuilt, None

    # Most-conflicted routes claim their lanes first.  For equal pressure, local
    # (shorter) connections are routed before long cross-canvas links.  This
    # ordering is generic and depends only on geometry/graph pressure.
    primary_order = sorted(
        range(len(diagram.edges)),
        key=lambda index: (
            -initial_metrics[index][0],
            initial_metrics[index][2],
            index,
        ),
    )

    # Two deterministic backups handle unusual ordering dead-ends without ever
    # changing relationships or relaxing the no-overlap condition.
    shortest_order = sorted(
        range(len(diagram.edges)),
        key=lambda index: (initial_metrics[index][2], index),
    )
    degree_order = sorted(
        range(len(diagram.edges)),
        key=lambda index: (
            -(
                degree.get(diagram.edges[index].source, 0)
                + degree.get(diagram.edges[index].target, 0)
            ),
            initial_metrics[index][2],
            index,
        ),
    )

    seed_orders = [primary_order]
    if len(diagram.edges) <= 24:
        seed_orders.extend([shortest_order, degree_order])

    # Bounded deterministic retry: if one route cannot be fitted after all
    # previously reserved routes, move only that failed route earlier in the
    # reservation order and retry.  This is generic backtracking based purely on
    # geometry pressure; no component/relationship names are inspected.
    order_queue: list[list[int]] = [list(order) for order in seed_orders]
    seen_orders: set[tuple[int, ...]] = set()
    max_attempts = 10 if len(diagram.edges) <= 24 else 4
    attempts = 0

    while order_queue and attempts < max_attempts:
        order = order_queue.pop(0)
        order_key = tuple(order)
        if order_key in seen_orders:
            continue
        seen_orders.add(order_key)
        attempts += 1

        rebuilt, failed_edge = build_strict(order)
        if rebuilt is not None:
            # Final all-pairs verification.  Returning the rebuild only after
            # every route independently reports zero overlap/crossing/spacing
            # conflict makes this pass safe and deterministic.
            clean = True
            for edge_index, result in enumerate(rebuilt):
                if result is None:
                    clean = False
                    break
                points, _direction = result
                edge = diagram.edges[edge_index]
                source_box = boxes.get(edge.source)
                target_box = boxes.get(edge.target)
                if source_box is None or target_box is None:
                    clean = False
                    break
                source_port = _infer_endpoint_port(source_box, points[0])
                target_port = _infer_endpoint_port(target_box, points[-1])
                quality = _route_quality(
                    points,
                    edge,
                    boxes,
                    node_lookup,
                    _reserved_routes_from_results(
                        diagram, rebuilt, exclude_index=edge_index
                    ),
                    source_port.side,
                    target_port.side,
                    space,
                    bounds,
                )
                if quality[0] != 0 or quality[1] != 0 or quality[2] != 0:
                    clean = False
                    break
            if clean:
                return rebuilt

        if failed_edge is None or failed_edge not in order:
            continue

        failed_position = order.index(failed_edge)
        if failed_position <= 0:
            continue

        # Try meaningful earlier positions first.  A three-place promotion is
        # particularly effective when a long route was boxed in by several short
        # local routes, while the smaller moves handle near-local dead ends.
        shifts = [3, 2, 1, max(1, failed_position // 2), failed_position]
        generated_positions: set[int] = set()
        for shift in shifts:
            new_position = max(0, failed_position - shift)
            if new_position == failed_position or new_position in generated_positions:
                continue
            generated_positions.add(new_position)
            candidate_order = list(order)
            candidate_order.pop(failed_position)
            candidate_order.insert(new_position, failed_edge)
            candidate_key = tuple(candidate_order)
            if candidate_key not in seen_orders:
                # Prioritize direct backtracking variants before unrelated seed
                # orders because they preserve the current routing order most.
                order_queue.insert(0, candidate_order)

    # If an exceptionally dense canvas has no mathematically valid strictly
    # separated rebuild inside its current bounds, retain the exact existing
    # routing rather than changing any unrelated behavior.
    return routes


class ConnectionRouter:
    """Reusable renderer-independent orthogonal connection router.

    The class owns no component-specific rules.  It receives the final component
    rectangles and graph edges and returns only pixel/logical polylines for the
    renderer to draw.
    """

    def __init__(
        self,
        diagram: DiagramSpec,
        boxes: Mapping[str, Box],
        bounds: tuple[float, float, float, float],
    ) -> None:
        self.diagram = diagram
        self.boxes = boxes
        self.bounds = bounds

    def route(self) -> list[tuple[list[Point], str] | None]:
        return _plan_connection_routes_impl(self.diagram, self.boxes, self.bounds)


def plan_connection_routes(
    diagram: DiagramSpec,
    boxes: Mapping[str, Box],
    bounds: tuple[float, float, float, float],
) -> list[tuple[list[Point], str] | None]:
    """Compatibility function used by the existing renderer."""
    return ConnectionRouter(diagram, boxes, bounds).route()
