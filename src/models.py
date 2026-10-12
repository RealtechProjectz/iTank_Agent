from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


NodeType = Literal[
    "bore",
    "sump",
    "oht",
    "motor",
    "valve",
    "sensor",
    "controller",
    "junction",
    "other",
]

ConnectionSide = Literal[
    "left",
    "right",
    "top",
    "bottom",
]

FlowDirection = Literal[
    "source_to_target",
    "target_to_source",
    "unknown",
]

RouteHint = Literal[
    "auto",
    "direct",
    "top_outer",
    "bottom_outer",
    "left_outer",
    "right_outer",
]

ConnectionMode = Literal[
    "automatic",
    "wired",
    "wireless",
]

ConnectionMedium = Literal[
    "wired",
    "wireless",
]


class DiagramPoint(BaseModel):
    """Normalized point in the ORIGINAL uploaded hand sketch."""

    model_config = ConfigDict(extra="ignore")

    x: float = Field(
        ge=0.0,
        le=1.0,
        description="Normalized horizontal coordinate: 0=left, 1=right.",
    )
    y: float = Field(
        ge=0.0,
        le=1.0,
        description="Normalized vertical coordinate: 0=top, 1=bottom.",
    )


class DiagramNode(BaseModel):
    """One physical component extracted from the uploaded sketch; x/y are the initial visual positions."""

    model_config = ConfigDict(extra="ignore")

    id: str = Field(description="Unique lowercase snake_case component id.")
    label: str = Field(description="Readable component name from the sketch.")
    node_type: NodeType = Field(default="other")

    x: float = Field(
        ge=0.0,
        le=1.0,
        description="Exact normalized center x position from the original sketch.",
    )
    y: float = Field(
        ge=0.0,
        le=1.0,
        description="Exact normalized center y position from the original sketch.",
    )

    width: float = Field(
        default=0.12,
        ge=0.01,
        le=0.50,
        description="Approximate normalized visible component width in the sketch.",
    )
    height: float = Field(
        default=0.09,
        ge=0.01,
        le=0.50,
        description="Approximate normalized visible component height in the sketch.",
    )

    details: list[str] = Field(default_factory=list)
    topology_role: str = Field(
        default="component",
        description=(
            "Rendering-independent topology role. Typical values are component, "
            "distribution_junction and collection_junction."
        ),
    )
    layout_zone: str = Field(
        default="auto",
        description=(
            "Optional layout-zone metadata such as auto or source_bottom_left. "
            "The universal layout engine interprets the metadata generically."
        ),
    )
    connection_ports: dict[str, list[float]] = Field(
        default_factory=lambda: {
            "top": [0.50, 0.34, 0.66, 0.20, 0.80],
            "bottom": [0.50, 0.34, 0.66, 0.20, 0.80],
            "left": [0.50, 0.34, 0.66, 0.20, 0.80],
            "right": [0.50, 0.34, 0.66, 0.20, 0.80],
        },
        description=(
            "Component-defined connection-port slots. Keys are top/bottom/left/right; "
            "each value is a 0..1 fraction along that side. The first slot is the "
            "primary port. Additional slots are used only when independent routes "
            "would otherwise share the same visual path."
        ),
    )
    preferred_input_sides: list[ConnectionSide] = Field(
        default_factory=list,
        description=(
            "Optional component metadata ordering preferred sides for incoming links. "
            "The router treats this as a preference, not a hard-coded topology rule."
        ),
    )
    preferred_output_sides: list[ConnectionSide] = Field(
        default_factory=list,
        description=(
            "Optional component metadata ordering preferred sides for outgoing links. "
            "The router treats this as a preference, not a hard-coded topology rule."
        ),
    )
    required_output_sides: list[ConnectionSide] = Field(
        default_factory=list,
        description=(
            "Optional strict metadata restricting where an outgoing route may leave "
            "the component. This is interpreted generically by the router and is "
            "used only when a component definition explicitly requires a fixed "
            "initial flow direction."
        ),
    )
    confidence: float = Field(default=0.80, ge=0.0, le=1.0)
    stable_id: str = Field(
        default="",
        description=(
            "Permanent component-instance id. Empty for junctions and for "
            "diagrams saved before stable ids existed. This is not the "
            "legacy node id (sump_1) and not the display index."
        ),
    )


class DiagramEdge(BaseModel):
    """
    One physical pipeline from the original sketch.

    source/target identify the exact connected components or junctions.
    source_side/target_side identify the exact component sides touched by the pipe.
    source_anchor/target_anchor preserve the exact visible touch position on those
    component sides when it can be read from the sketch.
    waypoints preserve the ordered visible bend geometry from the sketch.
    """

    model_config = ConfigDict(extra="ignore")

    id: str = Field(description="Unique lowercase snake_case edge id.")
    source: str = Field(description="First physical endpoint node id.")
    target: str = Field(description="Second physical endpoint node id.")

    label: str = Field(
        default="",
        description="Readable pipe label exactly as visible, when present.",
    )
    pipe_size: str = Field(
        default="",
        description="Visible pipe size, for example 1/2 inch, 2 inch, 4 inch.",
    )

    direction: FlowDirection = Field(default="source_to_target")
    source_side: ConnectionSide | None = Field(default=None)
    target_side: ConnectionSide | None = Field(default=None)
    source_port_fraction: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Optional exact 0..1 slot along source_side. Used only when a logical "
            "connection explicitly defines a physical connection point."
        ),
    )
    target_port_fraction: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Optional exact 0..1 slot along target_side. Used only when a logical "
            "connection explicitly defines a physical connection point."
        ),
    )

    source_anchor: DiagramPoint | None = Field(
        default=None,
        description=(
            "Normalized point where the visible pipe physically touches the source "
            "component boundary. Use this when visible; it preserves manifold port "
            "order and exact connection placement."
        ),
    )
    target_anchor: DiagramPoint | None = Field(
        default=None,
        description=(
            "Normalized point where the visible pipe physically touches the target "
            "component boundary. Use this when visible; it preserves manifold port "
            "order and exact connection placement."
        ),
    )

    waypoints: list[DiagramPoint] = Field(
        default_factory=list,
        description=(
            "Ordered major bends/turns of the visible pipe between the source and "
            "target. These are geometry constraints, not suggestions."
        ),
    )

    locked_route: bool = Field(
        default=True,
        description=(
            "True means the edge is a confirmed physical connection. Preserve source, target, sides, "
            "anchors and topology; reroute after final card layout."
        ),
    )

    route_hint: RouteHint = Field(
        default="auto",
        description="Fallback only when no usable waypoints are visible.",
    )

    topology_channel: str = Field(
        default="",
        description=(
            "Logical connection family used by the topology engine, for example "
            "process, control, sensor or communication. Empty preserves the "
            "original edge without automatic grouping."
        ),
    )
    topology_role: str = Field(
        default="logical",
        description=(
            "Logical/rendering topology role such as logical, main, trunk, branch "
            "or collection."
        ),
    )
    logical_edge_id: str = Field(
        default="",
        description="Original logical edge id represented by this rendered edge.",
    )

    connection_mode: ConnectionMode = Field(
        default="automatic",
        description=(
            "User-selected connection medium mode. automatic evaluates distance and "
            "interference; wired/wireless explicitly override the automatic rule."
        ),
    )
    connection_distance_km: float = Field(
        default=0.0,
        ge=0.0,
        description="Configured source-to-destination distance in kilometres.",
    )
    significant_interference: bool = Field(
        default=False,
        description="True when the configured connection has significant interference.",
    )
    connection_medium: ConnectionMedium = Field(
        default="wired",
        description=(
            "Resolved physical connection medium after applying automatic/manual "
            "selection. This metadata does not change the existing visual routing."
        ),
    )

    confidence: float = Field(default=0.75, ge=0.0, le=1.0)
    stable_id: str = Field(
        default="",
        description=(
            "Permanent connection id. Independent of the catalog rule-list "
            "index. Empty when this edge has no stored connection identity."
        ),
    )
    source_stable_id: str = Field(
        default="",
        description="Permanent id of the source component instance, when known.",
    )
    target_stable_id: str = Field(
        default="",
        description="Permanent id of the target component instance, when known.",
    )


class DiagramSpec(BaseModel):
    """Complete engineering graph extracted from one hand-drawn image."""

    model_config = ConfigDict(extra="ignore")

    title: str = Field(default="Site Water Automation Diagram")
    set_label: str = Field(default="SET 9")
    summary: str = Field(default="")

    nodes: list[DiagramNode] = Field(default_factory=list)
    edges: list[DiagramEdge] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    style_notes: list[str] = Field(default_factory=list)