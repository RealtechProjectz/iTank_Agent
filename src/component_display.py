"""Presentation-only helpers for component icon vs acronym display.

This module must stay free of routing, connection, and drag logic.
Persistence callers may store the normalized ``display_mode`` string on each
component override / canvas record alongside box coordinates.
"""

from __future__ import annotations

__all__ = (
    "normalize_component_display_mode",
    "resolve_component_display_mode",
    "component_allows_acronym_display",
    "component_acronym_for_name",
)

# Industrial label overrides used on schematic acronym plates.
_DISPLAY_ACRONYM_OVERRIDES = {
    "MOTOR": "M",
    "TX": "Tx",
    "MASTER": "MST",
}
_COMPONENT_ACRONYMS = {
    "sump": "SMP",
    "bore well": "BWL",
    "borewell": "BWL",
    "oht": "OHT",
    "oht tank": "OHT",
}


def normalize_component_display_mode(value: object) -> str:
    """Return ``icons`` or ``acronyms`` only."""
    text = str(value or "").strip().lower()
    if text in {"acronyms", "acronym", "letters", "letter", "symbols", "symbol"}:
        return "acronyms"
    return "icons"


def component_allows_acronym_display(component_name: object) -> bool:
    """Return whether a named component can use the Acronym Box display."""
    name = str(component_name or "").strip()
    return bool(name)


def resolve_component_display_mode(*candidates: object, component_name: object = None) -> str:
    """Return the first usable per-component display mode, defaulting to icons.

    Accepts one or more candidate values (override, canvas sheet, payload field,
    or the toolbar Icons/Acronyms selection). Empty / missing candidates are skipped.
    Components with a usable name may be shown as Acronym Boxes.
    """
    if component_name is not None and not component_allows_acronym_display(component_name):
        return "icons"
    for value in candidates:
        if value is None:
            continue
        text = str(value).strip()
        if not text:
            continue
        return normalize_component_display_mode(text)
    return "icons"


def component_acronym_for_name(component_name: object) -> str:
    """Map a catalog component name to its engineering acronym plate text."""
    name = str(component_name or "").strip()
    if not name:
        return "?"
    normalized_name = " ".join(name.casefold().split())
    if normalized_name in _COMPONENT_ACRONYMS:
        return _COMPONENT_ACRONYMS[normalized_name]

    code = ""
    try:
        # Lazy import avoids circular / stale-module issues during Streamlit reloads.
        from src import component_catalog as component_catalog_module

        definition = component_catalog_module.CATALOG_BY_NAME.get(name)
        code = str(getattr(definition, "code", "") or "").strip().upper()
    except Exception:
        code = ""

    if not code:
        # Fallback: initials from a parenthetical code, else first letters.
        if "(" in name and ")" in name:
            inner = name[name.rfind("(") + 1 : name.rfind(")")].strip()
            if inner:
                code = inner.upper()
        if not code:
            words = [part for part in name.replace("-", " ").split() if part]
            code = "".join(word[0] for word in words[:3]).upper() or "?"
    return _DISPLAY_ACRONYM_OVERRIDES.get(code, code)
