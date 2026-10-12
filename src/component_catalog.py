from __future__ import annotations

from collections import Counter, defaultdict, deque
import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable, Mapping

from .models import DiagramEdge, DiagramNode, DiagramSpec
from .topology import NodeTopologyMeta, apply_topology_engine


@dataclass(frozen=True)
class ComponentDefinition:
    name: str
    code: str
    node_type: str
    group: str
    layer: int
    order: int
    preferred_x: float
    parent_preferences: tuple[str, ...]
    connection_label: str
    topology_behavior: str = "standard"
    inline_channel: str = ""
    layout_zone: str = "auto"
    ports: tuple[str, ...] = ("top", "bottom", "left", "right")
    port_slots: tuple[float, ...] = (0.50, 0.34, 0.66, 0.20, 0.80)
    preferred_input_sides: tuple[str, ...] = ()
    preferred_output_sides: tuple[str, ...] = ()
    required_output_sides: tuple[str, ...] = ()


@dataclass(frozen=True)
class AllowedConnectionRule:
    """One explicitly allowed Component Selection connection relationship.

    These rules remain the only source of logical connectivity.  ``channel`` is
    metadata for the universal topology engine; it never makes a disallowed pair
    valid.  Edges in the same channel may share distribution/collection trunks.
    """

    source: str
    target: str
    label: str
    bidirectional: bool = False
    requires_all: tuple[str, ...] = ()
    pairing: str = "conservative"
    channel: str = "generic"


@dataclass(frozen=True)
class ConnectionOption:
    """One valid instance-level connection that the user may explicitly enable."""

    id: str
    source_id: str
    target_id: str
    source_label: str
    target_label: str
    connection_label: str
    direction_label: str
    bidirectional: bool = False


# =============================================================================
# SELECTABLE COMPONENT CATALOG
# =============================================================================

COMPONENT_CATALOG: tuple[ComponentDefinition, ...] = (
    ComponentDefinition(
        name="Master",
        code="MASTER",
        node_type="controller",
        group="Communication & Master",
        layer=0,
        order=0,
        preferred_x=0.36,
        parent_preferences=(),
        connection_label="Control Link",
    ),
    ComponentDefinition(
        name="Sump",
        code="SUMP",
        node_type="sump",
        group="Water Storage",
        layer=0,
        order=1,
        preferred_x=0.28,
        parent_preferences=(),
        connection_label="Water Flow",
        layout_zone="fixed_bottom_source",
        preferred_output_sides=("top",),
        required_output_sides=("top",),
    ),
    ComponentDefinition(
        name="Bore Well",
        code="BORE",
        node_type="bore",
        group="Water Source",
        layer=0,
        order=2,
        preferred_x=0.14,
        parent_preferences=(),
        connection_label="Control Link",
        layout_zone="fixed_bottom_source",
        preferred_output_sides=("top",),
        required_output_sides=("top",),
    ),
    ComponentDefinition(
        name="Well",
        code="WELL",
        node_type="bore",
        group="Water Source",
        layer=0,
        order=3,
        preferred_x=0.20,
        parent_preferences=(),
        connection_label="Well / Master Link",
        layout_zone="fixed_bottom_source",
        preferred_output_sides=("top",),
        required_output_sides=("top",),
    ),
    ComponentDefinition(
        name="Transmitter",
        code="TX",
        node_type="controller",
        group="Communication & Master",
        layer=1,
        order=10,
        preferred_x=0.64,
        parent_preferences=(),
        connection_label="Wireless Link",
    ),
    ComponentDefinition(
        name="Repeater",
        code="RPT",
        node_type="controller",
        group="Communication & Master",
        layer=1,
        order=11,
        preferred_x=0.50,
        parent_preferences=(),
        connection_label="Wireless Link",
    ),
    ComponentDefinition(
        name="Display with GSM (DWG)",
        code="DWG",
        node_type="controller",
        group="Controllers & Displays",
        layer=2,
        order=20,
        preferred_x=0.18,
        parent_preferences=(),
        connection_label="Communication",
    ),
    ComponentDefinition(
        name="Valve Control Unit (VCU)",
        code="VCU",
        node_type="controller",
        group="Controllers & Displays",
        layer=2,
        order=21,
        preferred_x=0.68,
        parent_preferences=(),
        connection_label="Control Link",
    ),
    ComponentDefinition(
        name="Smart Motor Controller (SMC)",
        code="SMC",
        node_type="controller",
        group="Controllers & Displays",
        layer=2,
        order=22,
        preferred_x=0.50,
        parent_preferences=(),
        connection_label="Motor Control",
    ),
    ComponentDefinition(
        name="Valve Controller (VCT)",
        code="VCT",
        node_type="controller",
        group="Controllers & Displays",
        layer=2,
        order=23,
        preferred_x=0.80,
        parent_preferences=(),
        connection_label="Valve Control",
    ),
    ComponentDefinition(
        name="Display (D)",
        code="D",
        node_type="controller",
        group="Controllers & Displays",
        layer=2,
        order=24,
        preferred_x=0.30,
        parent_preferences=(),
        connection_label="Display Link",
    ),
    ComponentDefinition(
        name="Auto Change Over Unit",
        code="ACOU",
        node_type="controller",
        group="Controllers & Displays",
        layer=2,
        order=25,
        preferred_x=0.42,
        parent_preferences=(),
        connection_label="Control Link",
    ),
    ComponentDefinition(
        name="Data Logger",
        code="DL",
        node_type="controller",
        group="Controllers & Displays",
        layer=2,
        order=26,
        preferred_x=0.54,
        parent_preferences=(),
        connection_label="Data Link",
    ),
    ComponentDefinition(
        name="ACN 10",
        code="ACN10",
        node_type="controller",
        group="Controllers & Displays",
        layer=2,
        order=27,
        preferred_x=0.62,
        parent_preferences=(),
        connection_label="Valve Control",
    ),
    ComponentDefinition(
        name="Motor (Pump)",
        code="MOTOR",
        node_type="motor",
        group="Field Components",
        layer=3,
        order=29,
        preferred_x=0.38,
        parent_preferences=(),
        connection_label="Motor / Process Link",
        layout_zone="source_bottom_left",
    ),
    ComponentDefinition(
        name="Linear Level Sensor (LLS)",
        code="LLS",
        node_type="sensor",
        group="Field Components",
        layer=3,
        order=30,
        preferred_x=0.55,
        parent_preferences=(),
        connection_label="Sensor Link",
    ),
    ComponentDefinition(
        name="Motorized Valve (MV)",
        code="MV",
        node_type="valve",
        group="Field Components",
        layer=3,
        order=31,
        preferred_x=0.68,
        parent_preferences=(),
        connection_label="Valve Control",
        topology_behavior="inline",
    ),
    ComponentDefinition(
        name="Pressure Relief Valve (PRV)",
        code="PRV",
        node_type="valve",
        group="Field Components",
        layer=3,
        order=32,
        preferred_x=0.76,
        parent_preferences=(),
        connection_label="Process Flow",
        topology_behavior="inline",
    ),
    ComponentDefinition(
        name="Non-Return Valve (NRV)",
        code="NRV",
        node_type="valve",
        group="Field Components",
        layer=3,
        order=33,
        preferred_x=0.84,
        parent_preferences=(),
        connection_label="Process Flow",
        topology_behavior="inline",
    ),
    ComponentDefinition(
        name="Ultrasonic Flow Meter",
        code="UFM",
        node_type="sensor",
        group="Field Components",
        layer=3,
        order=34,
        preferred_x=0.92,
        parent_preferences=(),
        connection_label="Flow Meter Signal",
        topology_behavior="auto_inline",
        inline_channel="process",
    ),
    ComponentDefinition(
        name="Flush Flow Meter",
        code="FFM",
        node_type="sensor",
        group="Field Components",
        layer=3,
        order=34,
        preferred_x=0.92,
        parent_preferences=(),
        connection_label="Flow Meter Data",
        topology_behavior="auto_inline",
        inline_channel="process",
    ),
    ComponentDefinition(
        name="Electromagnetic Flow Meter",
        code="EMFM",
        node_type="sensor",
        group="Field Components",
        layer=3,
        order=34,
        preferred_x=0.92,
        parent_preferences=(),
        connection_label="Flow Meter Signal",
        topology_behavior="auto_inline",
        inline_channel="process",
    ),
    ComponentDefinition(
        name="OHT Tank",
        code="OHT",
        node_type="oht",
        group="Water Storage",
        layer=3,
        order=35,
        preferred_x=0.75,
        parent_preferences=(),
        connection_label="Tank Link",
    ),
)


CATALOG_BY_NAME = {item.name: item for item in COMPONENT_CATALOG}
CATALOG_BY_CODE = {item.code: item for item in COMPONENT_CATALOG}

# Manual Component Selection is intentionally limited to the three base
# customer/site components.  Every other catalog component remains available
# internally for automatic requirement expansion and strict connection rules.
MANUAL_BASE_COMPONENTS: tuple[str, ...] = (
    "Sump",
    "Bore Well",
    "OHT Tank",
)

# Backward compatibility for worksheets created with the previous two OHT variants.
# Both legacy names now resolve to the single selectable "OHT Tank" component.
SELECTION_NAME_ALIASES = {
    "OHT Tank with Valve": "OHT Tank",
    "OHT Tank without Valve": "OHT Tank",
    "Plus Flow Meter": "Flush Flow Meter",
}

# Exact user-provided visual assets bundled/installed in <project>/assets/components.
# Both OHT variants intentionally reuse the existing OHT reference image.
EXACT_ASSET_BY_COMPONENT = {
    "Master": "master.png",
    "Transmitter": "transmitter.png",
    "Repeater": "repeater.png",
    "Display with GSM (DWG)": "dwg.png",
    "Valve Control Unit (VCU)": "vcu.png",
    "Smart Motor Controller (SMC)": "smc.png",
    "Valve Controller (VCT)": "vct.png",
    "Display (D)": "display.png",
    "Auto Change Over Unit": "auto_change_over.png",
    "Motor (Pump)": "motor.png",
    "Linear Level Sensor (LLS)": "LLS.png",
    "Motorized Valve (MV)": "mv.png",
    "Pressure Relief Valve (PRV)": "prv.png",
    "Non-Return Valve (NRV)": "nrv.png",
    "Ultrasonic Flow Meter": "flowmeter.png",
    "Flush Flow Meter": "flowmeter.png",
    "Electromagnetic Flow Meter": "flowmeter.png",
    "Data Logger": "data_logger.png",
    "OHT Tank": "oht.jpeg",
    "Sump": "sump.png",
    "Bore Well": "bore.png",
    "Well": "bore.png",
}


# =============================================================================
# STRICT ALLOWED CONNECTION RULES
# =============================================================================
#
# Component Selection mode is allowed to create ONLY the relationships declared
# here. If a selected pair does not appear in this table, no edge is created.
# Every applicable rule is evaluated independently, so selecting Motor + NRV + SMC
# + Master creates all three valid Motor relationships instead of choosing only one.
#
# ``bidirectional=True`` is represented by one clean physical connection whose
# direction is ``unknown``. This prevents duplicate overlapping arrows while still
# expressing the requested Master <-> Repeater <-> Transmitter communication path.

ALLOWED_CONNECTION_RULES: tuple[AllowedConnectionRule, ...] = (
    # Motor -> NRV, Auto Changeover, SMC, Master
    AllowedConnectionRule(
        source="Motor (Pump)",
        target="Non-Return Valve (NRV)",
        label="Process Flow",
        channel="process",
    ),
    AllowedConnectionRule(
        source="Motor (Pump)",
        target="Auto Change Over Unit",
        label="Motor / Changeover Control",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Motor (Pump)",
        target="Smart Motor Controller (SMC)",
        label="Motor Control",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Motor (Pump)",
        target="Master",
        label="Motor / Master Link",
        channel="control",
    ),

    # Sump -> PRV, Master, OHT Tank, LLS
    AllowedConnectionRule(
        source="Sump",
        target="Pressure Relief Valve (PRV)",
        label="Process Flow",
        channel="process",
    ),
    AllowedConnectionRule(
        source="Sump",
        target="Master",
        label="Sump / Master Link",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Sump",
        target="OHT Tank with Valve",
        label="Water Flow",
        channel="process",
    ),
    AllowedConnectionRule(
        source="Sump",
        target="OHT Tank without Valve",
        label="Water Flow",
        channel="process",
    ),
    AllowedConnectionRule(
        source="Sump",
        target="Linear Level Sensor (LLS)",
        label="Sump Sensor Link",
        channel="sensor",
    ),

    # Well -> Master
    AllowedConnectionRule(
        source="Well",
        target="Master",
        label="Well / Master Link",
        channel="control",
    ),

    # Master -> Auto Changeover, Display, LLS
    AllowedConnectionRule(
        source="Master",
        target="Auto Change Over Unit",
        label="Changeover Control",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Master",
        target="Display (D)",
        label="Display Link",
        channel="display",
    ),
    AllowedConnectionRule(
        source="Master",
        target="Linear Level Sensor (LLS)",
        label="Sensor Link",
        channel="sensor",
    ),

    # Transmitter -> LLS
    AllowedConnectionRule(
        source="Transmitter",
        target="Linear Level Sensor (LLS)",
        label="Sensor Link",
        channel="sensor",
    ),

    # OHT Tank - With Valve -> VCT, Transmitter
    AllowedConnectionRule(
        source="OHT Tank with Valve",
        target="Valve Controller (VCT)",
        label="Valve Control",
        channel="control",
    ),
    AllowedConnectionRule(
        source="OHT Tank with Valve",
        target="Transmitter",
        label="Tank Level Link",
        channel="sensor",
    ),

    # OHT Tank - Without Valve -> Transmitter, DWG
    AllowedConnectionRule(
        source="OHT Tank without Valve",
        target="Transmitter",
        label="Tank Level Link",
        channel="sensor",
    ),
    AllowedConnectionRule(
        source="OHT Tank without Valve",
        target="Display with GSM (DWG)",
        label="Tank Display Link",
        channel="display",
    ),

    # Bore Well -> SMC, Sump
    AllowedConnectionRule(
        source="Bore Well",
        target="Smart Motor Controller (SMC)",
        label="Bore / Motor Control",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Bore Well",
        target="Sump",
        label="Water Flow",
        channel="process",
    ),

    # Additional Flow Meter rules
    AllowedConnectionRule(
        source="Ultrasonic Flow Meter",
        target="Display with GSM (DWG)",
        label="Flow Meter / DWG Link",
        channel="display",
    ),
    AllowedConnectionRule(
        source="Ultrasonic Flow Meter",
        target="Valve Controller (VCT)",
        label="Flow Meter / VCT Link",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Flush Flow Meter",
        target="Data Logger",
        label="Flow Meter Data Link",
        channel="communication",
    ),
    AllowedConnectionRule(
        source="Electromagnetic Flow Meter",
        target="Display with GSM (DWG)",
        label="Flow Meter / DWG Link",
        channel="display",
    ),

    # Motorized Valve -> VCT, Transmitter
    AllowedConnectionRule(
        source="Motorized Valve (MV)",
        target="Valve Controller (VCT)",
        label="Valve Control",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Motorized Valve (MV)",
        target="Transmitter",
        label="Valve / Transmitter Link",
        channel="sensor",
    ),

    # Bore Well -> Well
    AllowedConnectionRule(
        source="Bore Well",
        target="Well",
        label="Water Flow",
        channel="process",
    ),

    # Repeater is valid ONLY as Master <-> Repeater <-> Transmitter.
    # Both links require the complete trio, and index-only pairing prevents an
    # extra Repeater from being connected unless a matching Master and Transmitter
    # instance also exist.
    AllowedConnectionRule(
        source="Master",
        target="Repeater",
        label="Bidirectional Wireless Link",
        bidirectional=True,
        requires_all=("Master", "Repeater", "Transmitter"),
        pairing="index_only",
        channel="communication",
    ),
    AllowedConnectionRule(
        source="Repeater",
        target="Transmitter",
        label="Bidirectional Wireless Link",
        bidirectional=True,
        requires_all=("Master", "Repeater", "Transmitter"),
        pairing="index_only",
        channel="communication",
    ),

    # New Well -> OHT water-flow rules are appended so existing rule IDs remain
    # stable for saved worksheets and connection-intent selections.
    AllowedConnectionRule(
        source="Well",
        target="OHT Tank with Valve",
        label="Water Flow",
        channel="process",
    ),
    AllowedConnectionRule(
        source="Well",
        target="OHT Tank without Valve",
        label="Water Flow",
        channel="process",
    ),

    # Unified OHT Tank rules. The legacy OHT-variant rules above are intentionally
    # retained as inactive compatibility entries so existing rule indexes for all
    # unrelated connections stay unchanged.
    AllowedConnectionRule(
        source="Sump",
        target="OHT Tank",
        label="Water Flow",
        channel="process",
    ),
    AllowedConnectionRule(
        source="Well",
        target="OHT Tank",
        label="Water Flow",
        channel="process",
    ),
    AllowedConnectionRule(
        source="OHT Tank",
        target="Valve Controller (VCT)",
        label="Valve Control",
        channel="control",
    ),
    AllowedConnectionRule(
        source="OHT Tank",
        target="Transmitter",
        label="Tank Level Link",
        channel="sensor",
    ),
    AllowedConnectionRule(
        source="OHT Tank",
        target="Display with GSM (DWG)",
        label="Tank Display Link",
        channel="display",
    ),

    # Signal and control wiring. These stay on control/display/communication
    # channels so they never join the blue sump-to-tank water line.
    # Motorized Valve -> Transmitter and Motorized Valve -> VCT already exist
    # above; only the ACN 10 link is new. Flow-meter pairs that already exist
    # above are not repeated, so saved rule indexes stay stable.
    AllowedConnectionRule(
        source="Motorized Valve (MV)",
        target="ACN 10",
        label="Valve / ACN Link",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Ultrasonic Flow Meter",
        target="Data Logger",
        label="Flow Meter Data Link",
        channel="communication",
    ),
    AllowedConnectionRule(
        source="Ultrasonic Flow Meter",
        target="Master",
        label="Flow Meter / Master Link",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Flush Flow Meter",
        target="Display with GSM (DWG)",
        label="Flow Meter / DWG Link",
        channel="display",
    ),
    AllowedConnectionRule(
        source="Flush Flow Meter",
        target="Valve Controller (VCT)",
        label="Flow Meter / VCT Link",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Flush Flow Meter",
        target="Master",
        label="Flow Meter / Master Link",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Electromagnetic Flow Meter",
        target="Valve Controller (VCT)",
        label="Flow Meter / VCT Link",
        channel="control",
    ),
    AllowedConnectionRule(
        source="Electromagnetic Flow Meter",
        target="Data Logger",
        label="Flow Meter Data Link",
        channel="communication",
    ),
    AllowedConnectionRule(
        source="Electromagnetic Flow Meter",
        target="Master",
        label="Flow Meter / Master Link",
        channel="control",
    ),
    # Appended so existing rule indexes stay stable. OHT Tank to a level
    # sensor is an explicit user connection, never an inferred one.
    AllowedConnectionRule(
        source="OHT Tank",
        target="Linear Level Sensor (LLS)",
        label="Tank Sensor Link",
        channel="sensor",
    ),
)


# =============================================================================
# PUBLIC CATALOG HELPERS
# =============================================================================

def available_component_names() -> list[str]:
    return [item.name for item in COMPONENT_CATALOG]


def component_groups() -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for item in COMPONENT_CATALOG:
        groups.setdefault(item.group, []).append(item.name)
    return groups


def inline_flow_meter_placement_options(selected_names: Iterable[str]) -> dict[str, list[dict[str, str]]]:
    """Return selected auto-inline meters plus source/tank attachment choices.

    The UI uses this to expose placement intent without changing the existing
    component table or allowed-connection logic.  The topology engine consumes
    only stable node ids and generic placement roles.
    """
    instances = _selected_instances(selected_names)
    meters: list[dict[str, str]] = []
    sources: list[dict[str, str]] = []
    tanks: list[dict[str, str]] = []
    for instance in instances:
        item = instance.definition
        row = {"id": instance.node_id, "label": instance.label, "name": item.name}
        if item.topology_behavior == "auto_inline" and item.inline_channel == "process":
            meters.append(row)
        if item.layout_zone in {"fixed_bottom_source", "source_bottom_left"}:
            sources.append(row)
        if item.node_type == "oht":
            tanks.append(row)
    return {"meters": meters, "sources": sources, "tanks": tanks}


def _slug(value: str) -> str:
    cleaned: list[str] = []
    for char in value.lower():
        if char.isalnum():
            cleaned.append(char)
        elif cleaned and cleaned[-1] != "_":
            cleaned.append("_")
    return "".join(cleaned).strip("_") or "component"


@dataclass(frozen=True)
class _ComponentInstance:
    definition: ComponentDefinition
    instance_index: int
    instance_count: int

    @property
    def node_id(self) -> str:
        # Every selected component is a real instance, including the first one.
        # Stable numbering prevents the first instance ID from changing when more
        # copies are added later: sump_1, sump_2, sump_3, ...
        base = _slug(self.definition.code)
        return f"{base}_{self.instance_index}"

    @property
    def label(self) -> str:
        # The worksheet and 2A table always show the exact same instance identity.
        return f"{self.definition.name} {self.instance_index}"


@lru_cache(maxsize=512)
def _selected_instances_cached(
    selected_names: tuple[str, ...],
) -> tuple[_ComponentInstance, ...]:
    """Memoize the deterministic instance expansion used by every catalog path.

    Performance only: component ordering, aliases, IDs and instance numbering are
    unchanged.  A tuple is cached internally so callers still receive an independent
    list and cannot mutate shared state.
    """
    canonical_names = [
        SELECTION_NAME_ALIASES.get(name, name)
        for name in selected_names
    ]
    counts = Counter(name for name in canonical_names if name in CATALOG_BY_NAME)
    instances: list[_ComponentInstance] = []

    for item in sorted(COMPONENT_CATALOG, key=lambda value: (value.layer, value.order)):
        count = counts.get(item.name, 0)
        for instance_index in range(1, count + 1):
            instances.append(
                _ComponentInstance(
                    definition=item,
                    instance_index=instance_index,
                    instance_count=count,
                )
            )

    return tuple(instances)


def _selected_instances(selected_names: Iterable[str]) -> list[_ComponentInstance]:
    return list(
        _selected_instances_cached(
            tuple(str(name) for name in selected_names)
        )
    )


def _instance_pairings(
    sources: list[_ComponentInstance],
    targets: list[_ComponentInstance],
) -> list[tuple[_ComponentInstance, _ComponentInstance]]:
    """Pair repeated components conservatively and predictably.

    - one source + many targets -> independent fan-out edges
    - many sources + one target -> independent fan-in edges
    - many sources + many targets -> index pairing only

    This remains the compatibility behavior used by existing trained/automatic
    generation paths. Manual/worksheet connection selection can request the
    complete instance expansion separately without changing this baseline.
    """
    if not sources or not targets:
        return []

    sources = sorted(sources, key=lambda item: item.instance_index)
    targets = sorted(targets, key=lambda item: item.instance_index)

    if len(sources) == 1:
        return [(sources[0], target) for target in targets]

    if len(targets) == 1:
        return [(source, targets[0]) for source in sources]

    count = min(len(sources), len(targets))
    return [(sources[index], targets[index]) for index in range(count)]


def _expanded_instance_pairings(
    sources: list[_ComponentInstance],
    targets: list[_ComponentInstance],
) -> list[tuple[_ComponentInstance, _ComponentInstance]]:
    """Expose every rule-valid repeated-instance pair for explicit user intent.

    The type-level ``ALLOWED_CONNECTION_RULES`` table remains the only authority
    for whether two component types may connect. This helper does not infer from
    distance, proximity, layout, or names. It only expands an already-approved
    rule across the concrete instances that currently exist, allowing mappings
    such as Sump 1 -> OHT 30 even when Sump 2 is also present.
    """
    if not sources or not targets:
        return []

    ordered_sources = sorted(sources, key=lambda item: item.instance_index)
    ordered_targets = sorted(targets, key=lambda item: item.instance_index)
    return [
        (source, target)
        for source in ordered_sources
        for target in ordered_targets
    ]


def _index_only_pairings(
    sources: list[_ComponentInstance],
    targets: list[_ComponentInstance],
) -> list[tuple[_ComponentInstance, _ComponentInstance]]:
    """Pair only matching instance numbers; never fan in or fan out."""
    if not sources or not targets:
        return []

    source_by_index = {item.instance_index: item for item in sources}
    target_by_index = {item.instance_index: item for item in targets}
    common = sorted(set(source_by_index) & set(target_by_index))
    return [(source_by_index[index], target_by_index[index]) for index in common]


def _edge_sides(
    source: ComponentDefinition,
    target: ComponentDefinition,
) -> tuple[str, str]:
    # Initial hints only. The selection-mode renderer recalculates physical sides
    # from final geometry before routing the line.
    if source.layer < target.layer:
        return "bottom", "top"
    if source.order <= target.order:
        return "right", "left"
    return "left", "right"


def _connection_option_id(
    rule_index: int,
    source_instance: _ComponentInstance,
    target_instance: _ComponentInstance,
) -> str:
    """Return a stable worksheet-safe id for one allowed instance relationship."""
    relation = "link" if ALLOWED_CONNECTION_RULES[rule_index].bidirectional else "to"
    return (
        f"rule_{rule_index + 1}__{source_instance.node_id}__"
        f"{relation}__{target_instance.node_id}"
    )


def _planned_connection_options(
    instances: list[_ComponentInstance],
    *,
    expand_repeated_instances: bool = False,
) -> list[tuple[ConnectionOption, AllowedConnectionRule, _ComponentInstance, _ComponentInstance]]:
    """Enumerate valid connection choices without assuming they are required.

    Performance only: the immutable result is memoized by the exact selected
    component instances and the existing repeated-instance mode.  The public and
    internal callers still receive fresh lists with the same option objects/order.
    """
    return list(
        _planned_connection_options_cached(
            tuple(instances),
            bool(expand_repeated_instances),
        )
    )


@lru_cache(maxsize=512)
def _planned_connection_options_cached(
    instances: tuple[_ComponentInstance, ...],
    expand_repeated_instances: bool,
) -> tuple[tuple[ConnectionOption, AllowedConnectionRule, _ComponentInstance, _ComponentInstance], ...]:
    """Cached implementation of the existing rule-to-instance expansion.

    The allowed-rule table defines what *may* connect. This function converts those
    type-level rules into instance-level choices such as Motor 1 -> Master 1. It
    never creates topology from proximity, layout order or generic fallbacks.
    """
    instances_by_name: dict[str, list[_ComponentInstance]] = defaultdict(list)
    for instance in instances:
        instances_by_name[instance.definition.name].append(instance)

    selected_component_names = {
        name for name, values in instances_by_name.items() if values
    }

    planned = []
    seen_ids: set[str] = set()

    for rule_index, rule in enumerate(ALLOWED_CONNECTION_RULES):
        if rule.requires_all and not set(rule.requires_all).issubset(selected_component_names):
            continue

        sources = instances_by_name.get(rule.source, [])
        targets = instances_by_name.get(rule.target, [])
        if not sources or not targets:
            continue

        if rule.pairing == "index_only":
            pairings = _index_only_pairings(sources, targets)
        elif expand_repeated_instances:
            pairings = _expanded_instance_pairings(sources, targets)
        else:
            pairings = _instance_pairings(sources, targets)

        for source_instance, target_instance in pairings:
            option_id = _connection_option_id(
                rule_index, source_instance, target_instance
            )
            if option_id in seen_ids:
                continue
            seen_ids.add(option_id)

            option = ConnectionOption(
                id=option_id,
                source_id=source_instance.node_id,
                target_id=target_instance.node_id,
                source_label=source_instance.label,
                target_label=target_instance.label,
                connection_label=rule.label,
                direction_label=("↔" if rule.bidirectional else "→"),
                bidirectional=rule.bidirectional,
            )
            planned.append(
                (option, rule, source_instance, target_instance)
            )

    # Tank Inter-Connection -------------------------------------------------
    # Any selected component whose catalog node_type is ``oht`` participates.
    # Every distinct tank pair can be selected as a bidirectional equalisation
    # link. The rule metadata carries the exact bottom-port policy; the
    # universal router remains component-independent.
    tank_instances = sorted(
        [instance for instance in instances if instance.definition.node_type == "oht"],
        key=lambda instance: (
            instance.definition.order,
            instance.instance_index,
            instance.node_id,
        ),
    )
    if len(tank_instances) >= 2:
        for source_index, source_instance in enumerate(tank_instances):
            for target_instance in tank_instances[source_index + 1:]:
                option_id = (
                    f"tank_interconnection__{source_instance.node_id}__"
                    f"link__{target_instance.node_id}"
                )
                if option_id in seen_ids:
                    continue
                seen_ids.add(option_id)

                rule = AllowedConnectionRule(
                    source=source_instance.definition.name,
                    target=target_instance.definition.name,
                    label="Tank Inter-Connection",
                    bidirectional=True,
                    pairing="adjacent_chain",
                    channel="process",
                )
                option = ConnectionOption(
                    id=option_id,
                    source_id=source_instance.node_id,
                    target_id=target_instance.node_id,
                    source_label=source_instance.label,
                    target_label=target_instance.label,
                    connection_label="Tank Inter-Connection",
                    direction_label="↔",
                    bidirectional=True,
                )
                planned.append((option, rule, source_instance, target_instance))

    return tuple(planned)


def allowed_connection_options(
    selected_names: Iterable[str],
    *,
    expand_repeated_instances: bool = False,
) -> list[ConnectionOption]:
    """Return only valid connection choices for the currently selected components.

    This is the public connection-intent API used by the UI. Merely appearing in
    this list means a relationship is *allowed*; it does not mean the relationship
    is required. The user explicitly checks the connections that should be drawn.
    """
    instances = _selected_instances(selected_names)
    return [
        item[0]
        for item in _planned_connection_options(
            instances,
            expand_repeated_instances=expand_repeated_instances,
        )
    ]


CONNECTION_DISTANCE_THRESHOLD_KM = 600.0


def normalize_connection_mode(value: Any) -> str:
    """Return one of automatic/wired/wireless from UI or persisted values."""
    normalized = str(value or "automatic").strip().lower()
    if normalized not in {"automatic", "wired", "wireless"}:
        return "automatic"
    return normalized


def resolve_connection_medium(
    mode: Any = "automatic",
    distance_km: Any = 0.0,
    significant_interference: Any = False,
) -> str:
    """Resolve the physical connection medium using the user's exact rule.

    Automatic:
      distance > 600 km -> wireless
      distance <= 600 km + significant interference -> wireless
      distance <= 600 km + no significant interference -> wired

    Manual wired/wireless modes override the automatic decision.
    """
    normalized_mode = normalize_connection_mode(mode)
    if normalized_mode == "wired":
        return "wired"
    if normalized_mode == "wireless":
        return "wireless"

    try:
        distance = max(0.0, float(distance_km or 0.0))
    except (TypeError, ValueError):
        distance = 0.0

    interference = bool(significant_interference)
    if distance > CONNECTION_DISTANCE_THRESHOLD_KM:
        return "wireless"
    if interference:
        return "wireless"
    return "wired"


def _connection_setting_for_option(
    option_id: str,
    connection_settings: Mapping[str, Mapping[str, Any]] | None,
) -> tuple[str, float, bool, str]:
    raw = dict((connection_settings or {}).get(option_id, {}) or {})
    mode = normalize_connection_mode(raw.get("mode", "automatic"))
    try:
        distance = max(0.0, float(raw.get("distance_km", 0.0) or 0.0))
    except (TypeError, ValueError):
        distance = 0.0
    interference = bool(raw.get("significant_interference", False))
    medium = resolve_connection_medium(mode, distance, interference)
    return mode, distance, interference, medium


def _plan_allowed_edges(
    instances: list[_ComponentInstance],
    required_connection_ids: Iterable[str] | None = None,
    connection_settings: Mapping[str, Mapping[str, Any]] | None = None,
    *,
    expand_repeated_instances: bool = False,
) -> list[DiagramEdge]:
    """Create edges from allowed rules filtered by explicit connection intent.

    ``required_connection_ids`` semantics:
    - ``None``: backward-compatible legacy behavior; draw every allowed candidate.
    - iterable (including an empty list): draw only the explicitly selected ids.

    The application passes an explicit iterable, so adding another component never
    silently activates a newly available connection.
    """
    required_set = (
        None
        if required_connection_ids is None
        else {str(value) for value in required_connection_ids}
    )

    edges: list[DiagramEdge] = []

    for option, rule, source_instance, target_instance in _planned_connection_options(
        instances,
        expand_repeated_instances=expand_repeated_instances,
    ):
        if required_set is not None and option.id not in required_set:
            continue

        source_side, target_side = _edge_sides(
            source_instance.definition,
            target_instance.definition,
        )
        source_port_fraction = None
        target_port_fraction = None
        if rule.pairing == "adjacent_chain":
            # Equalisation/inter-connection pipe: each pair uses the tank bottom
            # edge at separate left/right slots so a multi-tank chain stays clean.
            source_side = "bottom"
            target_side = "bottom"
            source_port_fraction = 0.20
            target_port_fraction = 0.80

        connection_mode, distance_km, interference, medium = _connection_setting_for_option(
            option.id,
            connection_settings,
        )

        # Optional signal-flow metadata is used only by the automatic Wireless
        # component-selection feature.  It changes the arrow direction for that
        # communication link without changing the allowed relationship, ports,
        # topology channel, route hint, or routing algorithm.
        edge_direction = ("unknown" if rule.bidirectional else "source_to_target")
        raw_connection_setting = dict(
            (connection_settings or {}).get(option.id, {}) or {}
        )
        requested_signal_direction = str(
            raw_connection_setting.get("signal_flow_direction", "") or ""
        ).strip()
        if requested_signal_direction in {"source_to_target", "target_to_source"}:
            edge_direction = requested_signal_direction

        edges.append(
            DiagramEdge(
                id=f"edge__{option.id}",
                source=source_instance.node_id,
                target=target_instance.node_id,
                label=rule.label,
                pipe_size="",
                direction=edge_direction,
                source_side=source_side,
                target_side=target_side,
                source_port_fraction=source_port_fraction,
                target_port_fraction=target_port_fraction,
                waypoints=[],
                locked_route=True,
                route_hint="direct",
                topology_channel=rule.channel,
                topology_role="logical",
                logical_edge_id=f"edge__{option.id}",
                connection_mode=connection_mode,
                connection_distance_km=distance_km,
                significant_interference=interference,
                connection_medium=medium,
                confidence=1.0,
            )
        )

    # Pairs the user picked in Required Connections that have no catalog rule
    # still receive one direct line. Nothing is inferred from layout alone.
    if required_set is not None:
        known_ids = {instance.node_id for instance in instances}
        linked = {(edge.source, edge.target) for edge in edges}
        linked.update((edge.target, edge.source) for edge in edges)
        for raw_id in sorted(required_set):
            text = str(raw_id or "").strip()
            marker = "__to__"
            if not text.startswith("pair__") or marker not in text[6:]:
                continue
            source_id, target_id = text[6:].split(marker, 1)
            source_id = source_id.strip()
            target_id = target_id.strip()
            if (
                not source_id
                or not target_id
                or source_id == target_id
                or source_id not in known_ids
                or target_id not in known_ids
                or (source_id, target_id) in linked
            ):
                continue
            edges.append(
                DiagramEdge(
                    id=f"edge__{text}",
                    source=source_id,
                    target=target_id,
                    label="Connection",
                    pipe_size="",
                    direction="source_to_target",
                    source_side="right",
                    target_side="left",
                    waypoints=[],
                    locked_route=True,
                    route_hint="direct",
                    topology_channel="control",
                    topology_role="logical",
                    logical_edge_id=f"edge__{text}",
                    confidence=1.0,
                )
            )
            linked.add((source_id, target_id))
            linked.add((target_id, source_id))

    return edges


def _topological_ranks(
    instances: list[_ComponentInstance],
    edges: list[DiagramEdge],
) -> dict[str, int]:
    """Rank directed process/control edges; bidirectional links do not add rank."""
    ids = [instance.node_id for instance in instances]
    indegree = {node_id: 0 for node_id in ids}
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in ids}

    for edge in edges:
        if edge.direction == "unknown":
            continue
        if edge.source not in outgoing or edge.target not in indegree:
            continue
        outgoing[edge.source].append(edge.target)
        indegree[edge.target] += 1

    queue = deque(sorted(node_id for node_id, value in indegree.items() if value == 0))
    rank = {node_id: 0 for node_id in ids}

    while queue:
        current = queue.popleft()
        for target in outgoing[current]:
            rank[target] = max(rank[target], rank[current] + 1)
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)

    return rank


def _connection_layout_orientation(
    source: _ComponentInstance,
    target: _ComponentInstance,
    edge: DiagramEdge,
) -> str:
    """Generic orientation hint used by layout helpers.

    No component names/codes are inspected.  The final universal layout is driven
    by graph structure; this fallback simply keeps bidirectional links horizontal
    and otherwise prefers the dominant catalog separation when a helper needs an
    orientation hint.
    """
    if edge.direction == "unknown":
        return "horizontal"

    dx = abs(float(target.definition.preferred_x) - float(source.definition.preferred_x))
    layer_gap = abs(int(target.definition.layer) - int(source.definition.layer))
    if dx >= 0.24 and layer_gap <= 1:
        return "horizontal"
    return "vertical"

def _connected_components(
    node_ids: list[str],
    adjacency: dict[str, list[tuple[str, float, float]]],
) -> list[list[str]]:
    remaining = set(node_ids)
    components: list[list[str]] = []
    while remaining:
        seed = min(remaining)
        stack = [seed]
        remaining.remove(seed)
        component: list[str] = []
        while stack:
            current = stack.pop()
            component.append(current)
            for neighbour, _dx, _dy in adjacency.get(current, []):
                if neighbour in remaining:
                    remaining.remove(neighbour)
                    stack.append(neighbour)
        components.append(component)
    return components


def _spread_duplicate_grid_cells(
    grid: dict[str, tuple[float, float]],
    instance_by_id: dict[str, _ComponentInstance],
) -> None:
    """Separate fan-out siblings that initially land in the same grid cell."""
    groups: dict[tuple[float, float], list[str]] = defaultdict(list)
    for node_id, point in grid.items():
        groups[(round(point[0], 4), round(point[1], 4))].append(node_id)

    for (_x, _y), node_ids in groups.items():
        if len(node_ids) <= 1:
            continue
        ordered = sorted(
            node_ids,
            key=lambda node_id: (
                instance_by_id[node_id].definition.order,
                instance_by_id[node_id].instance_index,
            ),
        )
        center = (len(ordered) - 1) / 2.0
        for index, node_id in enumerate(ordered):
            x, y = grid[node_id]
            # A small horizontal spread keeps a vertical fan-out readable while
            # preserving the original row/column structure.
            grid[node_id] = (x + (index - center) * 0.42, y)


def _apply_repeater_centering(
    positions: dict[str, tuple[float, float]],
    instances_by_name: dict[str, list[_ComponentInstance]],
) -> None:
    """Keep each Repeater exactly between its matching Master and Transmitter."""
    masters = sorted(instances_by_name.get("Master", []), key=lambda item: item.instance_index)
    repeaters = sorted(instances_by_name.get("Repeater", []), key=lambda item: item.instance_index)
    transmitters = sorted(instances_by_name.get("Transmitter", []), key=lambda item: item.instance_index)
    count = min(len(masters), len(repeaters), len(transmitters))
    for index in range(count):
        master_pos = positions.get(masters[index].node_id)
        transmitter_pos = positions.get(transmitters[index].node_id)
        if master_pos is None or transmitter_pos is None:
            continue
        positions[repeaters[index].node_id] = (
            (master_pos[0] + transmitter_pos[0]) / 2.0,
            (master_pos[1] + transmitter_pos[1]) / 2.0,
        )


def _graph_positions(
    instances: list[_ComponentInstance],
    edges: list[DiagramEdge],
) -> dict[str, tuple[float, float]]:
    """Universal, component-independent engineering layout.

    The algorithm uses only graph topology, connection direction and stable node
    ordering.  It does not contain component-name routing cases.

    Layout strategy:
      1. Split the selected graph into weakly connected components.
      2. Detect the principal structural spine of each component.  Branching
         graphs keep their most important continuation left-to-right and place
         secondary branches top-to-bottom beneath the parent.  Pure chains remain
         left-to-right.
      3. Place remaining merge/cycle nodes with a deterministic layered fallback.
      4. Tile many independent mini-flows in a bulk-safe grid so repeated systems
         do not get compressed into one strip.

    Only user-selected required edges participate, so this function never creates
    unwanted connections or alters connection intent.
    """
    if not instances:
        return {}

    instance_by_id = {instance.node_id: instance for instance in instances}
    node_ids = [instance.node_id for instance in instances]

    undirected: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
    incoming: dict[str, list[str]] = {node_id: [] for node_id in node_ids}

    def stable_key(node_id: str):
        item = instance_by_id[node_id]
        return (item.definition.order, item.instance_index, node_id)

    # Bidirectional communication edges receive one deterministic display
    # orientation for layout only.  Their rendered direction remains unchanged.
    for edge in edges:
        if edge.source not in instance_by_id or edge.target not in instance_by_id:
            continue
        undirected[edge.source].append(edge.target)
        undirected[edge.target].append(edge.source)

        if edge.direction == "target_to_source":
            source_id, target_id = edge.target, edge.source
        elif edge.direction == "unknown":
            source_id, target_id = sorted((edge.source, edge.target), key=stable_key)
        else:
            source_id, target_id = edge.source, edge.target

        if target_id not in outgoing[source_id]:
            outgoing[source_id].append(target_id)
        if source_id not in incoming[target_id]:
            incoming[target_id].append(source_id)

    for mapping in (undirected, outgoing, incoming):
        for node_id in mapping:
            mapping[node_id].sort(key=stable_key)

    adjacency_for_components = {
        node_id: [(other, 0.0, 0.0) for other in neighbours]
        for node_id, neighbours in undirected.items()
    }
    components = _connected_components(node_ids, adjacency_for_components)
    components.sort(key=lambda comp: min(stable_key(node_id) for node_id in comp))

    def downstream_depth(node_id: str, component_set: set[str], visiting=None, memo=None) -> int:
        if memo is None:
            memo = {}
        if visiting is None:
            visiting = set()
        if node_id in memo:
            return memo[node_id]
        if node_id in visiting:
            return 0
        visiting = set(visiting)
        visiting.add(node_id)
        children = [child for child in outgoing.get(node_id, []) if child in component_set]
        if not children:
            memo[node_id] = 0
            return 0
        value = 1 + max(downstream_depth(child, component_set, visiting, memo) for child in children)
        memo[node_id] = value
        return value

    component_layouts: list[tuple[list[str], dict[str, tuple[float, float]], float, float]] = []

    for component in components:
        component = sorted(component, key=stable_key)
        component_set = set(component)
        local: dict[str, tuple[float, float]] = {}
        placed: set[str] = set()
        depth_memo: dict[str, int] = {}

        comp_out = {
            node_id: [child for child in outgoing.get(node_id, []) if child in component_set]
            for node_id in component
        }
        comp_in = {
            node_id: [parent for parent in incoming.get(node_id, []) if parent in component_set]
            for node_id in component
        }

        pure_chain = (
            len(component) <= 1
            or (
                sum(len(values) for values in comp_out.values()) <= len(component) - 1
                and max((len(values) for values in comp_out.values()), default=0) <= 1
                and max((len(values) for values in comp_in.values()), default=0) <= 1
            )
        )

        roots = [node_id for node_id in component if not comp_in[node_id]]
        if not roots:
            roots = [component[0]]
        roots.sort(key=stable_key)

        def child_priority(child_id: str) -> tuple[int, int, int, tuple]:
            # Structural importance only: prefer children that themselves branch,
            # then those with a longer downstream continuation.
            return (
                1 if len(comp_out.get(child_id, [])) > 1 else 0,
                downstream_depth(child_id, component_set, memo=depth_memo),
                len(comp_out.get(child_id, [])),
                tuple(-value if isinstance(value, int) else value for value in stable_key(child_id)[:2]),
            )

        def place_branch(node_id: str, x: float, y: float, branch_level: int = 1) -> None:
            if node_id in placed:
                return
            local[node_id] = (x, y)
            placed.add(node_id)
            children = [child for child in comp_out.get(node_id, []) if child not in placed]
            if not children:
                return
            children.sort(key=lambda child: child_priority(child), reverse=True)
            if len(children) == 1:
                place_branch(children[0], x, y + 1.35, branch_level + 1)
                return

            # Preserve the existing compact style for small fan-outs. For 6+
            # children, reserve multiple clean rows instead of compressing every
            # branch into one crowded strip. This is generic for all component
            # types and only activates when density requires it.
            if len(children) > 5:
                max_cols = 5
                rows = int(math.ceil(len(children) / max_cols))
                x_spacing = 1.72
                y_spacing = 1.72
                for index, child in enumerate(children):
                    row = index // max_cols
                    col = index % max_cols
                    row_count = min(max_cols, len(children) - row * max_cols)
                    center = (row_count - 1) / 2.0
                    child_x = x + (col - center) * x_spacing
                    child_y = y + 1.35 + row * y_spacing
                    place_branch(child, child_x, child_y, branch_level + 1)
                return

            spacing = 1.35 + min(0.55, 0.08 * len(children))
            center = (len(children) - 1) / 2.0
            for index, child in enumerate(children):
                child_x = x + (index - center) * spacing
                place_branch(child, child_x, y + 1.35, branch_level + 1)

        # Multiple source trees inside one weak component are placed beside each
        # other, then merge/cycle nodes are handled by the fallback below.
        root_offset_x = 0.0
        for root in roots:
            if root in placed:
                continue

            if pure_chain:
                current = root
                x = root_offset_x
                while current not in placed:
                    local[current] = (x, 0.0)
                    placed.add(current)
                    children = [child for child in comp_out.get(current, []) if child not in placed]
                    if len(children) != 1:
                        for index, child in enumerate(children):
                            place_branch(child, x + (index + 1) * 1.45, 0.0)
                        break
                    current = children[0]
                    x += 1.85
                root_offset_x = max((point[0] for point in local.values()), default=x) + 2.2
                continue

            # Structural spine.  At a branching node, the child with the strongest
            # downstream structure continues horizontally; other children branch
            # downward.  A one-to-one tail after the last branching point becomes
            # a vertical branch, matching the clean reference grammar without
            # naming any component type.
            current = root
            x = root_offset_x
            y = 0.0
            while current not in placed:
                local[current] = (x, y)
                placed.add(current)
                children = [child for child in comp_out.get(current, []) if child not in placed]
                if not children:
                    break
                children.sort(key=lambda child: child_priority(child), reverse=True)

                if len(children) > 5:
                    max_cols = 5
                    x_spacing = 1.72
                    y_spacing = 1.72
                    for index, child in enumerate(children):
                        row = index // max_cols
                        col = index % max_cols
                        row_count = min(max_cols, len(children) - row * max_cols)
                        center = (row_count - 1) / 2.0
                        branch_x = x + (col - center) * x_spacing
                        branch_y = y + 1.35 + row * y_spacing
                        place_branch(child, branch_x, branch_y)
                    break

                primary = children[0]
                secondary = children[1:]

                for index, child in enumerate(secondary):
                    branch_x = x + (index - (len(secondary) - 1) / 2.0) * 1.25
                    place_branch(child, branch_x, y + 1.35)

                continue_horizontally = (
                    len(children) > 1
                    or len(comp_out.get(primary, [])) > 1
                )
                if continue_horizontally:
                    current = primary
                    x += 1.85
                    continue

                place_branch(primary, x, y + 1.35)
                break

            component_right = max((px for px, _py in local.values()), default=x)
            root_offset_x = component_right + 2.2

        # Deterministic fallback for merges/cycles/unreached nodes.  Place them in
        # topological-ish layers to the right of the existing structure.
        unplaced = [node_id for node_id in component if node_id not in placed]
        if unplaced:
            base_x = max((px for px, _py in local.values()), default=0.0) + 1.85
            layer_y = 0.0
            for index, node_id in enumerate(sorted(unplaced, key=stable_key)):
                local[node_id] = (base_x + (index // 5) * 1.85, layer_y + (index % 5) * 1.35)
                placed.add(node_id)

        # Resolve exact cell collisions while preserving the overall flow axes.
        occupied: dict[tuple[int, int], list[str]] = defaultdict(list)
        for node_id, (x, y) in local.items():
            occupied[(round(x * 10), round(y * 10))].append(node_id)
        for same_cell in occupied.values():
            if len(same_cell) <= 1:
                continue
            same_cell.sort(key=stable_key)
            center = (len(same_cell) - 1) / 2.0
            for index, node_id in enumerate(same_cell):
                x, y = local[node_id]
                local[node_id] = (x + (index - center) * 0.95, y)

        min_x = min(point[0] for point in local.values())
        max_x = max(point[0] for point in local.values())
        min_y = min(point[1] for point in local.values())
        max_y = max(point[1] for point in local.values())
        normalized = {
            node_id: (x - min_x, y - min_y)
            for node_id, (x, y) in local.items()
        }
        component_layouts.append((
            component,
            normalized,
            max(1.0, max_x - min_x + 1.0),
            max(1.0, max_y - min_y + 1.0),
        ))

    component_count = len(component_layouts)
    if component_count <= 3:
        tile_cols = component_count
    elif component_count <= 6:
        tile_cols = 2
    elif component_count <= 12:
        tile_cols = 3
    elif component_count <= 24:
        tile_cols = 4
    else:
        tile_cols = max(4, min(7, int(math.ceil(math.sqrt(component_count)))))
    tile_cols = max(1, tile_cols)
    tile_rows = int(math.ceil(component_count / tile_cols))

    assignments = []
    col_widths = [0.0 for _ in range(tile_cols)]
    row_heights = [0.0 for _ in range(tile_rows)]
    for index, (component, local, width, height) in enumerate(component_layouts):
        row = index // tile_cols
        col = index % tile_cols
        assignments.append((row, col, component, local, width, height))
        col_widths[col] = max(col_widths[col], width)
        row_heights[row] = max(row_heights[row], height)

    # Larger component counts reserve more routing whitespace instead of reducing
    # it.  This is the key bulk-safety rule.
    connection_pressure = len(edges) / max(1, len(instances))
    gap_x = 2.00 + min(1.20, connection_pressure * 0.24)
    gap_y = 2.25 + min(1.40, connection_pressure * 0.28)

    col_offsets = []
    running = 0.0
    for width in col_widths:
        col_offsets.append(running)
        running += width + gap_x
    row_offsets = []
    running = 0.0
    for height in row_heights:
        row_offsets.append(running)
        running += height + gap_y

    global_grid: dict[str, tuple[float, float]] = {}
    for row, col, component, local, width, height in assignments:
        x_pad = (col_widths[col] - width) / 2.0
        y_pad = (row_heights[row] - height) / 2.0
        for node_id, (x, y) in local.items():
            global_grid[node_id] = (
                col_offsets[col] + x_pad + x,
                row_offsets[row] + y_pad + y,
            )

    min_x = min(point[0] for point in global_grid.values())
    max_x = max(point[0] for point in global_grid.values())
    min_y = min(point[1] for point in global_grid.values())
    max_y = max(point[1] for point in global_grid.values())
    span_x = max(0.001, max_x - min_x)
    span_y = max(0.001, max_y - min_y)

    margin_x = 0.07 if len(instances) >= 40 else 0.10
    margin_y = 0.08 if len(instances) >= 40 else 0.11
    usable_x = 1.0 - 2.0 * margin_x
    usable_y = 1.0 - 2.0 * margin_y

    positions: dict[str, tuple[float, float]] = {}
    for instance in instances:
        gx, gy = global_grid.get(instance.node_id, (0.0, 0.0))
        positions[instance.node_id] = (
            0.50 if span_x < 0.001 else margin_x + ((gx - min_x) / span_x) * usable_x,
            0.50 if span_y < 0.001 else margin_y + ((gy - min_y) / span_y) * usable_y,
        )

    instances_by_name: dict[str, list[_ComponentInstance]] = defaultdict(list)
    for instance in instances:
        instances_by_name[instance.definition.name].append(instance)
    _apply_repeater_centering(positions, instances_by_name)

    # Generic metadata-driven layout zones.  The topology/layout engine does not
    # check component names; catalog metadata decides which units belong to the
    # source/input band.
    source_zone = [
        instance for instance in instances
        if instance.definition.layout_zone in {"source_bottom_left", "fixed_bottom_source"}
    ]
    if source_zone:
        source_ids = {instance.node_id for instance in source_zone}

        if len(components) <= 1:
            # One integrated plant/system: keep the source/input equipment in the
            # worksheet's bottom-left region and reserve upper/right space for the
            # downstream system.
            for instance in instances:
                if instance.node_id in source_ids:
                    continue
                x, y = positions[instance.node_id]
                positions[instance.node_id] = (
                    0.26 + x * 0.68,
                    0.06 + y * 0.64,
                )

            ordered_sources = sorted(
                source_zone,
                key=lambda instance: (
                    instance.definition.order,
                    instance.instance_index,
                    instance.node_id,
                ),
            )
            count_sources = len(ordered_sources)
            source_cols = min(6, max(1, int(math.ceil(math.sqrt(count_sources * 1.7)))))
            source_rows = int(math.ceil(count_sources / source_cols))
            x_lo, x_hi = 0.065, 0.42
            y_lo, y_hi = 0.74, 0.94

            for index, instance in enumerate(ordered_sources):
                row = index // source_cols
                col = index % source_cols
                x = (
                    (x_lo + x_hi) / 2.0
                    if source_cols <= 1
                    else x_lo + (x_hi - x_lo) * (col / (source_cols - 1))
                )
                y = (
                    (y_lo + y_hi) / 2.0
                    if source_rows <= 1
                    else y_lo + (y_hi - y_lo) * (row / (source_rows - 1))
                )
                positions[instance.node_id] = (x, y)
        else:
            # Bulk repeated systems are tiled independently.  Moving every Sump /
            # Motor / Bore into one global corner would create page-spanning lines,
            # so source-zone metadata is applied inside each mini-system tile.
            # This preserves the required bottom-left source grammar while keeping
            # each source physically close to its corresponding downstream units.
            for component in components:
                comp_sources = [node_id for node_id in component if node_id in source_ids]
                if not comp_sources:
                    continue
                comp_points = [positions[node_id] for node_id in component if node_id in positions]
                if not comp_points:
                    continue
                min_x = min(point[0] for point in comp_points)
                max_x = max(point[0] for point in comp_points)
                min_y = min(point[1] for point in comp_points)
                max_y = max(point[1] for point in comp_points)
                span_x = max(0.025, max_x - min_x)
                span_y = max(0.025, max_y - min_y)
                ordered = sorted(comp_sources, key=stable_key)
                for index, node_id in enumerate(ordered):
                    # Bottom-left of the local component envelope. Multiple source
                    # units are fanned slightly to the right instead of stacked.
                    positions[node_id] = (
                        max(0.035, min(0.965, min_x + min(span_x * 0.16, 0.035) * index)),
                        max(0.035, min(0.965, max_y + min(span_y * 0.12, 0.025))),
                    )

    # Fixed worksheet-bottom placement.  This is metadata-driven: any present or
    # future component can opt in with ``layout_zone="fixed_bottom_source"``.
    # Unlike the softer source_bottom_left zone, this rule is global and remains
    # true even when the diagram is split into several connected systems.
    fixed_bottom = [
        instance for instance in instances
        if instance.definition.layout_zone == "fixed_bottom_source"
    ]
    if fixed_bottom:
        fixed_ids = {instance.node_id for instance in fixed_bottom}

        # Reserve an upper routing/system band while leaving other source-zone
        # equipment (for example existing Motor placement) untouched.
        for instance in instances:
            if instance.node_id in fixed_ids:
                continue
            if instance.definition.layout_zone == "source_bottom_left":
                continue
            x, y = positions[instance.node_id]
            positions[instance.node_id] = (x, min(0.72, 0.04 + y * 0.70))

        # Arrange fixed-bottom source/input units from downstream (left) to
        # upstream (right) whenever their selected graph contains a directed
        # relationship.  This reproduces the fixed reference grammar generically:
        # an upstream source such as a bore/well sits to the right and feeds the
        # next bottom-band unit toward the left.  No component names are checked;
        # only the selected directed graph is used.
        fixed_graph_out: dict[str, list[str]] = defaultdict(list)
        fixed_indegree: dict[str, int] = {node_id: 0 for node_id in fixed_ids}
        for edge in edges:
            if edge.direction == "unknown":
                continue
            source_id = edge.source
            target_id = edge.target
            if edge.direction == "target_to_source":
                source_id, target_id = target_id, source_id
            if source_id in fixed_ids and target_id in fixed_ids:
                fixed_graph_out[source_id].append(target_id)
                fixed_indegree[target_id] = fixed_indegree.get(target_id, 0) + 1

        fixed_depth: dict[str, int] = {node_id: 0 for node_id in fixed_ids}
        queue = deque(sorted(
            [node_id for node_id, degree_value in fixed_indegree.items() if degree_value == 0],
            key=stable_key,
        ))
        visited_count = 0
        local_indegree = dict(fixed_indegree)
        while queue:
            current = queue.popleft()
            visited_count += 1
            for target_id in sorted(fixed_graph_out.get(current, []), key=stable_key):
                fixed_depth[target_id] = max(
                    fixed_depth.get(target_id, 0),
                    fixed_depth.get(current, 0) + 1,
                )
                local_indegree[target_id] -= 1
                if local_indegree[target_id] == 0:
                    queue.append(target_id)

        ordered_fixed = sorted(
            fixed_bottom,
            key=lambda instance: (
                -fixed_depth.get(instance.node_id, 0),
                instance.definition.order,
                instance.instance_index,
                instance.node_id,
            ),
        )
        count_fixed = len(ordered_fixed)
        x_lo, x_hi = 0.06, 0.94
        y_fixed = 0.90
        for index, instance in enumerate(ordered_fixed):
            x = (
                0.50
                if count_fixed <= 1
                else x_lo + (x_hi - x_lo) * (index / (count_fixed - 1))
            )
            positions[instance.node_id] = (x, y_fixed)

    sumps = [
        instance for instance in instances
        if instance.definition.node_type == "sump"
    ]
    tanks = [
        instance for instance in instances
        if instance.definition.node_type == "oht"
    ]
    bores = [
        instance for instance in instances
        if instance.definition.node_type == "bore"
    ]
    if sumps:
        sumps.sort(key=lambda instance: (instance.instance_index, instance.node_id))
        y_top, y_bottom = 0.28, 0.78
        for index, instance in enumerate(sumps):
            y = (
                0.50
                if len(sumps) == 1
                else y_top + (y_bottom - y_top) * index / (len(sumps) - 1)
            )
            positions[instance.node_id] = (0.18, y)
    if bores:
        # Borewells keep one fixed slot. Adding sumps or tanks does not move them.
        bores.sort(key=lambda instance: (instance.instance_index, instance.node_id))
        anchor_y = 0.53
        for index, instance in enumerate(bores):
            y = anchor_y + (index - (len(bores) - 1) / 2.0) * 0.22
            positions[instance.node_id] = (0.78, max(0.18, min(0.84, y)))
    if tanks:
        tanks.sort(key=lambda instance: (instance.instance_index, instance.node_id))
        x_left, x_right = 0.42, 0.90
        for index, instance in enumerate(tanks):
            x = (
                (x_left + x_right) / 2.0
                if len(tanks) == 1
                else x_left + (x_right - x_left) * index / (len(tanks) - 1)
            )
            positions[instance.node_id] = (x, 0.12)
    placed = {instance.node_id for instance in sumps}
    placed.update(instance.node_id for instance in tanks)
    placed.update(instance.node_id for instance in bores)
    hydraulic = [
        instance for instance in instances
        if _hydraulic_piping_role(instance) in {"motor", "nrv", "prv"}
        and instance.node_id not in placed
    ]
    placed.update(instance.node_id for instance in hydraulic)
    others = [
        instance for instance in instances
        if instance.node_id not in placed
    ]
    if others:
        others.sort(key=lambda instance: (
            instance.definition.order,
            instance.definition.node_type,
            instance.instance_index,
            instance.node_id,
        ))
        groups: list[list] = []
        for instance in others:
            if groups and groups[-1][0].definition.node_type == instance.definition.node_type:
                groups[-1].append(instance)
            else:
                groups.append([instance])
        # Below the top-row tanks and left of the fixed borewell, so a new
        # card never starts on top of the OHT Tank.
        x_left, x_right = 0.40, 0.62
        y_top, y_bottom = 0.42, 0.84
        for group_index, group in enumerate(groups):
            x = (
                (x_left + x_right) / 2.0
                if len(groups) == 1
                else x_left + (x_right - x_left) * group_index / (len(groups) - 1)
            )
            for index, instance in enumerate(group):
                y = (
                    (y_top + y_bottom) / 2.0
                    if len(group) == 1
                    else y_top + (y_bottom - y_top) * index / (len(group) - 1)
                )
                positions[instance.node_id] = (x, y)

    _place_hydraulic_piping(positions, sumps, tanks, hydraulic)
    return positions


def _hydraulic_piping_role(instance) -> str:
    """Return the piping role for a flow meter, valve, or pump. Other types are blank."""
    code = str(getattr(instance.definition, "code", "") or "")
    if code == "MOTOR":
        return "motor"
    if code == "NRV":
        return "nrv"
    if code == "PRV":
        return "prv"
    if code == "MV":
        return "mv"
    if code in {"UFM", "FFM", "EMFM"}:
        return "fm"
    return ""


def _place_hydraulic_piping(positions, sumps, tanks, hydraulic) -> None:
    """Seat pumps, NRV, PRV, flow meters and motorized valves on the sump-to-tank pipe.

    Sumps stay on the left, tanks stay on the top row, and borewells are not in
    this list. Pumps with their NRV and PRV sit beside the sump. Each tank inlet
    gets a flow meter and then a motorized valve directly beneath the tank.
    """
    if not hydraulic:
        return
    groups: dict[str, list] = {"motor": [], "nrv": [], "prv": [], "fm": [], "mv": []}
    for instance in hydraulic:
        groups[_hydraulic_piping_role(instance)].append(instance)
    for values in groups.values():
        values.sort(key=lambda item: (item.instance_index, item.node_id))

    sump_points = [positions[item.node_id] for item in sumps if item.node_id in positions]
    if sump_points:
        anchor_x = min(point[0] for point in sump_points)
        anchor_y = sum(point[1] for point in sump_points) / len(sump_points)
    else:
        anchor_x, anchor_y = 0.18, 0.50

    def column_ys(count: int) -> list[float]:
        if count <= 1:
            return [anchor_y]
        if count == 2:
            return [anchor_y - 0.09, anchor_y + 0.09]
        top = max(0.30, anchor_y - 0.16)
        bottom = min(0.82, anchor_y + 0.16)
        return [top + (bottom - top) * index / (count - 1) for index in range(count)]

    motor_ys = column_ys(len(groups["motor"]))
    for index, instance in enumerate(groups["motor"]):
        positions[instance.node_id] = (min(0.46, anchor_x + 0.12), motor_ys[index])
    for index, instance in enumerate(groups["nrv"]):
        partner = groups["motor"][min(index, len(groups["motor"]) - 1)] if groups["motor"] else None
        y = positions[partner.node_id][1] if partner is not None else column_ys(len(groups["nrv"]))[index]
        positions[instance.node_id] = (min(0.56, anchor_x + 0.21), y)
    for index, instance in enumerate(groups["prv"]):
        partner = groups["nrv"][min(index, len(groups["nrv"]) - 1)] if groups["nrv"] else None
        if partner is None and groups["motor"]:
            partner = groups["motor"][min(index, len(groups["motor"]) - 1)]
        y = positions[partner.node_id][1] if partner is not None else column_ys(len(groups["prv"]))[index]
        positions[instance.node_id] = (min(0.64, anchor_x + 0.30), y)

    for index, instance in enumerate(groups["mv"]):
        positions[instance.node_id] = (0.46, min(0.84, 0.42 + index * 0.14))
    for index, instance in enumerate(groups["fm"]):
        positions[instance.node_id] = (0.60, min(0.84, 0.42 + index * 0.14))


# =============================================================================
# DIAGRAM BUILDER
# =============================================================================


def auto_expand_wireless_components(
    selected_names: Iterable[str],
    connection_settings: Mapping[str, Mapping[str, Any]] | None = None,
) -> tuple[list[str], list[str], dict[str, dict], bool]:
    """Automatically add the communication chain required by Wireless mode.

    This helper changes only component/connection selection intent.  The existing
    allowed-relationship table, topology engine and router remain the source of
    all physical relationships and routing geometry.

    Wireless automatic-selection rules:
      - Trigger only when the user explicitly chooses Wireless.  Distance is
        carried through exactly as entered and is never used as a threshold for
        deciding whether these communication components are required.
      - Ensure at least one Master and one Transmitter are present.
      - Keep exactly one Repeater for each Transmitter.
      - Select the existing Master <-> Repeater and Repeater <-> Transmitter
        relationships, but render their signal-flow direction as
        Transmitter -> Repeater -> Master.
      - If Sump is present, automatically select the existing Sump/Master
        relationship so Master is always connected to Sump.
      - If OHT Tank is present, automatically select the existing OHT/Transmitter
        relationship.  The existing instance-pairing logic already allows one
        Transmitter to serve multiple OHT Tanks.
      - Existing non-wireless component relationships are left untouched.

    Returns
    -------
    (expanded_components, auto_connection_ids, expanded_settings, wireless_active)
    """
    components = [SELECTION_NAME_ALIASES.get(name, name) for name in list(selected_names or [])]
    settings = {
        str(key): dict(value or {})
        for key, value in dict(connection_settings or {}).items()
    }

    # Explicit Wireless selection alone activates this feature.  No fixed
    # distance boundary is consulted here.
    wireless_template: dict[str, Any] | None = None
    for config in settings.values():
        mode = normalize_connection_mode(config.get("mode", "automatic"))
        if mode != "wireless":
            continue
        try:
            distance = max(0.0, float(config.get("distance_km", 0.0) or 0.0))
        except (TypeError, ValueError):
            distance = 0.0
        wireless_template = {
            "mode": "wireless",
            "distance_km": distance,
            "significant_interference": bool(
                config.get("significant_interference", False)
            ),
        }
        break

    if wireless_template is None:
        return components, [], settings, False

    # Required communication components.  Preserve all unrelated user-selected
    # components and quantities.
    if "Master" not in components:
        components.append("Master")
    if "Transmitter" not in components:
        components.append("Transmitter")

    transmitter_count = components.count("Transmitter")

    # Exactly one Repeater per Transmitter.  Normalize only the Repeater count;
    # every other selected component remains untouched.
    non_repeaters = [name for name in components if name != "Repeater"]
    components = non_repeaters + ["Repeater"] * transmitter_count

    options = allowed_connection_options(components)
    auto_selected_ids: list[str] = []

    auto_pairs = {
        ("Master", "Repeater"),
        ("Repeater", "Transmitter"),
        ("OHT Tank", "Transmitter"),
        ("Sump", "Master"),
    }

    for option in options:
        source_base = option.source_label.rsplit(" ", 1)[0]
        target_base = option.target_label.rsplit(" ", 1)[0]
        pair = (source_base, target_base)
        if pair not in auto_pairs:
            continue

        auto_selected_ids.append(option.id)

        if pair == ("Sump", "Master"):
            # This is the existing permanent Sump/Master control relationship.
            settings.setdefault(
                option.id,
                {
                    "mode": "automatic",
                    "distance_km": 0.0,
                    "significant_interference": False,
                },
            )
            continue

        link_setting = dict(wireless_template)

        # The existing allowed rules are Master<->Repeater and
        # Repeater<->Transmitter.  Keep those relationships, but for the
        # automatically created wireless chain show the requested signal flow:
        # Transmitter -> Repeater -> Master.
        if pair in {
            ("Master", "Repeater"),
            ("Repeater", "Transmitter"),
        }:
            link_setting["signal_flow_direction"] = "target_to_source"

        settings[option.id] = link_setting

    return components, list(dict.fromkeys(auto_selected_ids)), settings, True


def build_selected_component_diagram(
    selected_names: Iterable[str],
    required_connection_ids: Iterable[str] | None = None,
    connection_settings: Mapping[str, Mapping[str, Any]] | None = None,
    inline_placement_settings: Mapping[str, Mapping[str, Any]] | None = None,
    *,
    expand_repeated_instances: bool = False,
    locked_endpoint_pairs: Iterable[tuple[str, str]] | None = None,
) -> DiagramSpec:
    """Build the selected-component diagram using allowed rules + user intent.

    The component list decides which nodes exist. The explicit connection-intent
    list decides which of the currently valid allowed relationships are rendered.
    """
    instances = _selected_instances(selected_names)
    if not instances:
        return DiagramSpec(
            title="Selected Component Automation Diagram",
            set_label="AUTO",
            summary="No components selected.",
            nodes=[],
            edges=[],
            warnings=[],
            style_notes=["Component Selection mode"],
        )

    edges = _plan_allowed_edges(
        instances,
        required_connection_ids,
        connection_settings=connection_settings,
        expand_repeated_instances=expand_repeated_instances,
    )
    positions = _graph_positions(instances, edges)
    nodes: list[DiagramNode] = []

    for instance in instances:
        item = instance.definition
        x, y = positions.get(instance.node_id, (item.preferred_x, 0.50))
        details = [f"Code: {item.code}", item.group]
        node_label = instance.label
        if item.code == "MV":
            node_label = f'{node_label}  2"'

        if instance.instance_count > 1:
            details.append(
                f"Instance: {instance.instance_index} of {instance.instance_count}"
            )

        exact_asset = EXACT_ASSET_BY_COMPONENT.get(item.name)
        if exact_asset:
            details.append(f"AssetFile: {exact_asset}")

        nodes.append(
            DiagramNode(
                id=instance.node_id,
                label=node_label,
                node_type=item.node_type,
                x=x,
                y=y,
                width=0.12,
                height=0.10,
                details=details,
                topology_role="component",
                layout_zone=item.layout_zone,
                connection_ports={
                    side: list(item.port_slots)
                    for side in item.ports
                },
                preferred_input_sides=list(item.preferred_input_sides),
                preferred_output_sides=list(item.preferred_output_sides),
                required_output_sides=list(item.required_output_sides),
                confidence=1.0,
            )
        )

    logical_diagram = DiagramSpec(
        title="Selected Component Automation Diagram",
        set_label="AUTO",
        summary=(
            f"Automatically arranged diagram containing {len(nodes)} selected "
            f"component{'s' if len(nodes) != 1 else ''} and {len(edges)} required "
            f"logical connection{'s' if len(edges) != 1 else ''}."
        ),
        nodes=nodes,
        edges=edges,
        warnings=[],
        style_notes=[
            "Component Selection mode",
            "Strict user-defined allowed connection rules - revision 2026-08-18",
            "Allowed relationships are candidates; only explicit connection intent is rendered",
            "No proximity-based or guessed connections",
            "Repeated components paired conservatively",
            "Bidirectional communication rendered as one clean physical link",
            "Repeater connects only inside a complete Master-Repeater-Transmitter chain",
            "Only user-selected components are included",
            "Topology analyzed before rendering",
        ],
    )

    placement_settings = dict(inline_placement_settings or {})
    topology_metadata = {}
    for instance in instances:
        raw_setting = dict(placement_settings.get(instance.node_id, {}) or {})
        placement = str(raw_setting.get("placement", "automatic") or "automatic").strip().lower()
        if placement not in {"automatic", "source_side", "destination_side"}:
            placement = "automatic"
        attach_id = str(raw_setting.get("attach_id", "") or "").strip()
        topology_metadata[instance.node_id] = NodeTopologyMeta(
            behavior=instance.definition.topology_behavior,
            inline_channel=instance.definition.inline_channel,
            layout_zone=instance.definition.layout_zone,
            stable_order=instance.definition.order * 1000 + instance.instance_index,
            inline_placement=placement,
            inline_attach_id=attach_id,
        )
    locked_pairs = {
        (str(source), str(target))
        for source, target in list(locked_endpoint_pairs or [])
        if str(source) and str(target)
    }
    return apply_topology_engine(
        logical_diagram,
        topology_metadata,
        locked_pairs=locked_pairs,
    )
