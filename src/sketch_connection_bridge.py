from __future__ import annotations

"""Bridge uploaded-sketch topology into the existing Component Selection logic.

The AI pipeline remains responsible only for reading the uploaded drawing:
- which physical components are present
- which physical components are connected

This module then converts those detected component relationships into the exact
instance-level connection-option IDs already used by ``2A. Select Required
Connections``.  The final diagram is built by the existing
``build_selected_component_diagram()`` function, so component structure,
connection rules, port metadata, routing behavior and renderer behavior stay on
one shared code path for both manual selection and uploaded sketches.
"""

from collections import defaultdict
import re
from typing import Iterable

from . import component_catalog as component_catalog_module
from .component_catalog import COMPONENT_CATALOG
from .models import DiagramSpec


_CATALOG_BY_NAME = {item.name: item for item in COMPONENT_CATALOG}


def _normalize(value: object) -> str:
    text = str(value or "").strip().lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[()\[\]{}]", " ", text)
    text = text.replace("_", " ").replace("-", " ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _strip_instance_number(value: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"\s*#?\d+\s*$", "", text).strip()
    return text


def _catalog_aliases() -> dict[str, str]:
    aliases: dict[str, str] = {}

    def add(canonical: str, *values: str) -> None:
        if canonical not in _CATALOG_BY_NAME:
            return
        for value in (canonical, *values):
            normalized = _normalize(value)
            if normalized:
                aliases[normalized] = canonical

    add("Master", "MASTER", "master controller", "master unit", "m")
    add("Sump", "SUMP", "sump tank", "underground sump", "underground tank")
    add("Bore Well", "BORE", "bore", "borewell", "bore well")
    add("Well", "WELL", "open well", "water well")
    add("Transmitter", "TX", "transmitter unit")
    add("Repeater", "RPT", "repeater unit")
    add("Display with GSM (DWG)", "DWG", "display with gsm", "gsm display")
    add("Valve Control Unit (VCU)", "VCU", "valve control unit")
    add("Smart Motor Controller (SMC)", "SMC", "smart motor controller")
    add("Valve Controller (VCT)", "VCT", "valve controller")
    add("Display (D)", "D", "display")
    add("Auto Change Over Unit", "ACOU", "auto change over", "auto changeover")
    add("Data Logger", "DL", "data logger", "datalogger")
    add("ACN 10", "ACN10", "acn 10", "acn-10", "acn10")
    add("Motor (Pump)", "MOTOR", "motor", "pump", "water pump", "motor pump")
    add("Linear Level Sensor (LLS)", "LLS", "linear level sensor", "level sensor")
    add("Motorized Valve (MV)", "MV", "motorized valve", "motorised valve")
    add("Pressure Relief Valve (PRV)", "PRV", "pressure relief valve")
    add("Non-Return Valve (NRV)", "NRV", "non return valve", "non-return valve", "check valve")
    add("Ultrasonic Flow Meter", "ultrasonic flow meter", "ultrasonic flowmeter", "ufm")
    add("Flush Flow Meter", "flush flow meter", "flush flowmeter", "ffm")
    add("Electromagnetic Flow Meter", "electromagnetic flow meter", "electromagnetic flowmeter", "emfm")
    add(
        "OHT Tank",
        "OHT",
        "overhead tank",
        "over head tank",
        "overhead water tank",
        "oht tank",
        "oht tank with valve",
        "oht tank without valve",
        "ohtv",
        "ohtnv",
    )
    return aliases


_ALIASES = _catalog_aliases()


def _details_text(node: object) -> str:
    details = getattr(node, "details", []) or []
    return " ".join(str(item) for item in details)


def _canonical_component_name(node: object) -> str | None:
    """Map one AI-extracted node to one selectable catalog component."""
    label = str(getattr(node, "label", "") or "").strip()
    node_id = str(getattr(node, "id", "") or "").strip()
    node_type = str(getattr(node, "node_type", "") or "").strip().lower()
    details = _details_text(node)

    candidates = [
        label,
        _strip_instance_number(label),
        node_id,
        _strip_instance_number(node_id.replace("_", " ")),
        details,
    ]

    # Exact normalized aliases first.
    for candidate in candidates:
        canonical = _ALIASES.get(_normalize(candidate))
        if canonical is not None:
            return canonical

    combined = _normalize(" ".join(candidates))

    # Specific terms before generic terms to avoid misclassifying SMC as Motor,
    # a PRV/NRV as MV, or a specific flow meter as a generic sensor.
    phrase_priority: tuple[tuple[str, str], ...] = (
        ("smart motor controller", "Smart Motor Controller (SMC)"),
        ("smc", "Smart Motor Controller (SMC)"),
        ("valve control unit", "Valve Control Unit (VCU)"),
        ("vcu", "Valve Control Unit (VCU)"),
        ("valve controller", "Valve Controller (VCT)"),
        ("vct", "Valve Controller (VCT)"),
        ("pressure relief valve", "Pressure Relief Valve (PRV)"),
        ("prv", "Pressure Relief Valve (PRV)"),
        ("non return valve", "Non-Return Valve (NRV)"),
        ("nrv", "Non-Return Valve (NRV)"),
        ("motorized valve", "Motorized Valve (MV)"),
        ("motorised valve", "Motorized Valve (MV)"),
        ("ultrasonic flow meter", "Ultrasonic Flow Meter"),
        ("flush flow meter", "Flush Flow Meter"),
        ("electromagnetic flow meter", "Electromagnetic Flow Meter"),
        ("linear level sensor", "Linear Level Sensor (LLS)"),
        ("lls", "Linear Level Sensor (LLS)"),
        ("auto change over", "Auto Change Over Unit"),
        ("auto changeover", "Auto Change Over Unit"),
        ("display with gsm", "Display with GSM (DWG)"),
        ("dwg", "Display with GSM (DWG)"),
        ("data logger", "Data Logger"),
        ("acn 10", "ACN 10"),
        ("acn-10", "ACN 10"),
        ("acn10", "ACN 10"),
        ("repeater", "Repeater"),
        ("transmitter", "Transmitter"),
        ("master", "Master"),
        ("bore well", "Bore Well"),
        ("borewell", "Bore Well"),
        ("sump", "Sump"),
        ("overhead tank", "OHT Tank"),
        ("overhead water tank", "OHT Tank"),
        ("oht", "OHT Tank"),
        ("motor", "Motor (Pump)"),
        ("pump", "Motor (Pump)"),
        ("well", "Well"),
    )
    for phrase, canonical in phrase_priority:
        if phrase in combined and canonical in _CATALOG_BY_NAME:
            return canonical

    # Conservative type-only fallbacks are used only where the type is
    # unambiguous in this application's selectable catalog.
    type_fallback = {
        "sump": "Sump",
        "oht": "OHT Tank",
        "motor": "Motor (Pump)",
    }
    fallback = type_fallback.get(node_type)
    if fallback in _CATALOG_BY_NAME:
        return fallback

    return None


def _numeric_hint(node: object) -> int | None:
    for value in (
        str(getattr(node, "label", "") or ""),
        str(getattr(node, "id", "") or ""),
    ):
        match = re.search(r"(?:^|[_\s#-])(\d+)(?:$|[_\s#-])", value)
        if match:
            try:
                return int(match.group(1))
            except ValueError:
                pass
    return None


def _slug(value: str) -> str:
    result: list[str] = []
    for char in str(value or "").lower():
        if char.isalnum():
            result.append(char)
        elif result and result[-1] != "_":
            result.append("_")
    return "".join(result).strip("_") or "component"


def _map_sketch_nodes_to_catalog_instances(
    diagram: DiagramSpec,
) -> tuple[list[str], dict[str, str], list[str]]:
    """Return selected catalog names, sketch-node -> instance-id map, warnings."""
    physical_nodes = [
        node for node in diagram.nodes
        if str(getattr(node, "node_type", "") or "") != "junction"
    ]

    recognized: list[tuple[object, str]] = []
    warnings: list[str] = []
    for node in physical_nodes:
        canonical = _canonical_component_name(node)
        if canonical is None:
            warnings.append(
                f"Sketch component '{getattr(node, 'label', getattr(node, 'id', 'unknown'))}' "
                "does not map to the selectable component catalog and was not added to "
                "the Component Selection diagram."
            )
            continue
        recognized.append((node, canonical))

    selected_names = [canonical for _, canonical in recognized]

    grouped: dict[str, list[object]] = defaultdict(list)
    for node, canonical in recognized:
        grouped[canonical].append(node)

    node_to_instance: dict[str, str] = {}
    for canonical, nodes in grouped.items():
        definition = _CATALOG_BY_NAME[canonical]

        # Respect explicit instance numbers where the sketch has them; otherwise
        # use stable reading order.  This keeps Sump 1/Sump 2 relationships stable.
        nodes = sorted(
            nodes,
            key=lambda node: (
                0 if _numeric_hint(node) is not None else 1,
                _numeric_hint(node) if _numeric_hint(node) is not None else 10**9,
                float(getattr(node, "y", 0.5) or 0.5),
                float(getattr(node, "x", 0.5) or 0.5),
                str(getattr(node, "id", "")),
            ),
        )
        base_id = _slug(definition.code)
        for index, node in enumerate(nodes, start=1):
            node_to_instance[str(getattr(node, "id", ""))] = f"{base_id}_{index}"

    return selected_names, node_to_instance, warnings


def _component_relationships_through_junctions(diagram: DiagramSpec) -> set[tuple[str, str]]:
    """Collapse junction branches into the component relationships shown by the sketch.

    Direction metadata is respected first.  This prevents a T branch such as
    Sump -> junction -> {Master, OHT} from being interpreted as Master <-> OHT.
    For an edge whose direction is unknown, both orientations are retained because
    the image established physical connectivity but did not establish flow direction.
    """
    node_by_id = {str(node.id): node for node in diagram.nodes}
    component_ids = {
        node_id
        for node_id, node in node_by_id.items()
        if str(getattr(node, "node_type", "") or "") != "junction"
    }
    junction_ids = set(node_by_id) - component_ids

    outgoing: dict[str, set[str]] = defaultdict(set)
    direct_pairs: set[tuple[str, str]] = set()

    for edge in diagram.edges:
        source = str(edge.source)
        target = str(edge.target)
        if source not in node_by_id or target not in node_by_id or source == target:
            continue

        direction = str(getattr(edge, "direction", "unknown") or "unknown")
        if direction == "target_to_source":
            outgoing[target].add(source)
        elif direction == "source_to_target":
            outgoing[source].add(target)
        else:
            outgoing[source].add(target)
            outgoing[target].add(source)

        if source in component_ids and target in component_ids:
            direct_pairs.add(tuple(sorted((source, target))))

    pairs = set(direct_pairs)

    # From every component, follow only junction nodes until the next physical
    # component.  Physical components are endpoints, never transit nodes.
    for start in component_ids:
        queue: list[str] = [
            neighbour for neighbour in outgoing.get(start, set())
            if neighbour in junction_ids
        ]
        visited_junctions: set[str] = set(queue)
        while queue:
            current = queue.pop(0)
            for neighbour in outgoing.get(current, set()):
                if neighbour == start:
                    continue
                if neighbour in component_ids:
                    pairs.add(tuple(sorted((start, neighbour))))
                    continue
                if neighbour in junction_ids and neighbour not in visited_junctions:
                    visited_junctions.add(neighbour)
                    queue.append(neighbour)

    return pairs


def extract_sketch_requirement_intent(reviewed_sketch: DiagramSpec) -> dict[str, object]:
    """Return customer-requirement intent detected from the uploaded sketch.

    This is a read-only extraction helper for the automatic-requirement workflow.
    It does not build routes or change any rendering behavior.  Component names are
    normalized through the same catalog mapper already used by the sketch bridge,
    while relationships preserve what the sketch actually shows even when an
    adjacent pair is not directly allowed.  The caller can then resolve that intent
    through the existing ALLOWED_CONNECTION_RULES without inventing new rules.
    """
    selected_names, _sketch_to_instance, bridge_warnings = (
        _map_sketch_nodes_to_catalog_instances(reviewed_sketch)
    )

    node_to_component: dict[str, str] = {}
    for node in list(reviewed_sketch.nodes or []):
        if str(getattr(node, "node_type", "") or "") == "junction":
            continue
        canonical = _canonical_component_name(node)
        if canonical is not None:
            node_to_component[str(getattr(node, "id", "") or "")] = canonical

    connections: list[dict[str, str]] = []
    seen_pairs: set[tuple[str, str]] = set()
    for source_id, target_id in sorted(
        _component_relationships_through_junctions(reviewed_sketch)
    ):
        source_name = node_to_component.get(str(source_id))
        target_name = node_to_component.get(str(target_id))
        if not source_name or not target_name or source_name == target_name:
            continue
        # The relationship extractor is physical/undirected.  Keep one stable
        # representation; the catalog resolver restores the direction declared by
        # the existing engineering rule.
        key = tuple(sorted((source_name, target_name)))
        if key in seen_pairs:
            continue
        seen_pairs.add(key)
        connections.append(
            {
                "source": source_name,
                "target": target_name,
            }
        )

    return {
        "components": list(selected_names),
        "connections": connections,
        "warnings": list(bridge_warnings),
    }


def build_sketch_using_existing_connection_logic(
    reviewed_sketch: DiagramSpec,
) -> DiagramSpec:
    """Generate sketch output through the same manual-selection connection path.

    The uploaded sketch determines *which* component instances are related.  The
    existing component catalog determines whether that relationship is allowed,
    and the existing selected-component builder determines ports, layout metadata,
    connection semantics and routing input.  No router code is changed here.
    """
    selected_names, sketch_to_instance, bridge_warnings = (
        _map_sketch_nodes_to_catalog_instances(reviewed_sketch)
    )

    # If the sketch contains no recognizable selectable components, preserve the
    # established sketch workflow instead of producing an empty diagram.
    if not selected_names:
        return reviewed_sketch

    options = component_catalog_module.allowed_connection_options(
        selected_names,
        expand_repeated_instances=True,
    )
    option_by_pair: dict[tuple[str, str], object] = {}
    for option in options:
        option_by_pair[(str(option.source_id), str(option.target_id))] = option
        option_by_pair.setdefault((str(option.target_id), str(option.source_id)), option)

    required_ids: list[str] = []
    unresolved_relationships: list[str] = []

    for source_sketch_id, target_sketch_id in sorted(
        _component_relationships_through_junctions(reviewed_sketch)
    ):
        source_instance = sketch_to_instance.get(source_sketch_id)
        target_instance = sketch_to_instance.get(target_sketch_id)
        if source_instance is None or target_instance is None:
            continue
        option = option_by_pair.get((source_instance, target_instance))
        if option is None:
            unresolved_relationships.append(
                f"Sketch relationship {source_instance} ↔ {target_instance} is not "
                "an allowed Component Selection connection."
            )
            continue
        option_id = str(getattr(option, "id"))
        if option_id not in required_ids:
            required_ids.append(option_id)

    result = component_catalog_module.build_selected_component_diagram(
        selected_names,
        required_connection_ids=required_ids,
        expand_repeated_instances=True,
    )

    # Preserve traceability without changing the selected-component renderer mode.
    result.title = reviewed_sketch.title or result.title
    result.summary = (
        "Uploaded sketch topology interpreted through the existing Component "
        "Selection connection rules."
    )
    existing_warnings = list(getattr(result, "warnings", []) or [])
    result.warnings = existing_warnings + bridge_warnings + unresolved_relationships
    notes = list(getattr(result, "style_notes", []) or [])
    if "Uploaded sketch connection intent" not in notes:
        notes.append("Uploaded sketch connection intent")
    result.style_notes = notes
    return result
