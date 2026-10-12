from __future__ import annotations

"""Central component-image path configuration.

MANUAL IMAGE FOLDER
-------------------
Copy your original component images into:

    <project>/assets/component_images/

Then edit only ``COMPONENT_IMAGE_FILES`` below.

Example:
    "Sump": "sump_original.png"
    "Bore Well": "bore_well_original.jpg"

You can also use an absolute Windows path:
    "Sump": r"D:\\RTS_Images\\sump.png"

The renderer calls ``resolve_component_image_path()`` automatically.
Numbered instances such as Sump 1, Sump 2, Bore Well 3, etc. resolve to the
same base component image.
"""

import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
COMPONENT_IMAGE_DIR = PROJECT_ROOT / "assets" / "component_images"
SUPPORTED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

# -----------------------------------------------------------------------------
# EDIT ONLY THIS MAPPING
# -----------------------------------------------------------------------------
# Value can be either:
#   1. a filename located inside assets/component_images/
#   2. a project-relative path
#   3. an absolute Windows/Linux path
COMPONENT_IMAGE_FILES: dict[str, str] = {
    "Sump": "sump.png",
    "Bore Well": "bore_well.png",
    "Well": "well.png",
    "OHT Tank": "oht_tank.png",
    "OHT Tank with Valve": "oht_tank_with_valve.png",
    "OHT Tank without Valve": "oht_tank_without_valve.png",
    "Motor (Pump)": "motor.png",
    "Master": "master.png",
    "Transmitter": "transmitter.png",
    "Repeater": "repeater.png",
    "Smart Motor Controller (SMC)": "smc.png",
    "Valve Controller (VCT)": "vct.png",
    "Auto Change Over Unit": "auto_change_over.png",
    "Linear Level Sensor (LLS)": "lls.png",
    "Motorized Valve (MV)": "Motorized Valve.png",
    "Pressure Relief Valve (PRV)": "prv.png",
    "Non-Return Valve (NRV)": "nrv.png",
    "Ultrasonic Flow Meter": "ultrasonic_flow_meter.png",
    "Flush Flow Meter": "flush_flow_meter.png",
    "Electromagnetic Flow Meter": "electromagnetic_flow_meter.png",
    "Display with GSM (DWG)": "dwg.png",
    "Valve Control Unit (VCU)": "vcu.png",
    "Display (D)": "display.png",
    "Data Logger": "data_logger.png",
    "ACN 10": "ACN 10.png",
}

# Backward-compatible public name expected by renderers.py
COMPONENT_IMAGE_PATHS = COMPONENT_IMAGE_FILES

COMPONENT_IMAGE_ALIASES: dict[str, str] = {
    "master": "Master",
    "master controller": "Master",
    "master gateway controller": "Master",
    "m": "Master",
    "transmitter": "Transmitter",
    "tx": "Transmitter",
    "t": "Transmitter",
    "repeater": "Repeater",
    "rpt": "Repeater",
    "r": "Repeater",
    "display with gsm": "Display with GSM (DWG)",
    "dwg": "Display with GSM (DWG)",
    "linear level sensor": "Linear Level Sensor (LLS)",
    "linear level sensor lls": "Linear Level Sensor (LLS)",
    "lls": "Linear Level Sensor (LLS)",
    "motorized valve": "Motorized Valve (MV)",
    "motorised valve": "Motorized Valve (MV)",
    "mv": "Motorized Valve (MV)",
    "valve control unit": "Valve Control Unit (VCU)",
    "vcu": "Valve Control Unit (VCU)",
    "smart motor controller": "Smart Motor Controller (SMC)",
    "smc": "Smart Motor Controller (SMC)",
    "valve controller": "Valve Controller (VCT)",
    "vct": "Valve Controller (VCT)",
    "display": "Display (D)",
    "d": "Display (D)",
    "ultrasonic flow meter": "Ultrasonic Flow Meter",
    "ultrasonic flowmeter": "Ultrasonic Flow Meter",
    "ufm": "Ultrasonic Flow Meter",
    "flush flow meter": "Flush Flow Meter",
    "flush flowmeter": "Flush Flow Meter",
    "ffm": "Flush Flow Meter",
    "pfm": "Flush Flow Meter",
    "electromagnetic flow meter": "Electromagnetic Flow Meter",
    "electromagnetic flowmeter": "Electromagnetic Flow Meter",
    "emfm": "Electromagnetic Flow Meter",
    "data logger": "Data Logger",
    "acn 10": "ACN 10",
    "acn10": "ACN 10",
    "acn-10": "ACN 10",
    "datalogger": "Data Logger",
    "dl": "Data Logger",
    "pressure relief valve": "Pressure Relief Valve (PRV)",
    "prv": "Pressure Relief Valve (PRV)",
    "non return valve": "Non-Return Valve (NRV)",
    "non-return valve": "Non-Return Valve (NRV)",
    "nrv": "Non-Return Valve (NRV)",
    "oht": "OHT Tank",
    "oht tank": "OHT Tank",
    "overhead tank": "OHT Tank",
    "overhead water tank": "OHT Tank",
    "oht tank with valve": "OHT Tank with Valve",
    "overhead tank with valve": "OHT Tank with Valve",
    "ohtv": "OHT Tank with Valve",
    "oht tank without valve": "OHT Tank without Valve",
    "overhead tank without valve": "OHT Tank without Valve",
    "ohtnv": "OHT Tank without Valve",
    "sump": "Sump",
    "sump tank": "Sump",
    "bore": "Bore Well",
    "bore well": "Bore Well",
    "borewell": "Bore Well",
    "well": "Well",
    "motor": "Motor (Pump)",
    "motor pump": "Motor (Pump)",
    "pump": "Motor (Pump)",
    "auto change over unit": "Auto Change Over Unit",
    "auto changeover unit": "Auto Change Over Unit",
    "auto change over": "Auto Change Over Unit",
    "acou": "Auto Change Over Unit",
}


def _normalize(value: str) -> str:
    text = str(value or "").strip().lower().replace("_", " ")
    text = text.replace("(", " ").replace(")", " ")
    text = re.sub(r"[^a-z0-9\- ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _strip_instance_suffix(value: str) -> str:
    # Supports labels such as "Sump 1", "Sump #2", "Bore Well 10".
    return re.sub(r"\s+#?\d+\s*$", "", str(value or "").strip()).strip()


def canonical_component_name(value: str) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None

    if raw in COMPONENT_IMAGE_FILES:
        return raw

    base = _strip_instance_suffix(raw)
    if base in COMPONENT_IMAGE_FILES:
        return base

    normalized = _normalize(base)
    for canonical in COMPONENT_IMAGE_FILES:
        if _normalize(canonical) == normalized:
            return canonical

    return COMPONENT_IMAGE_ALIASES.get(normalized)


def _configured_path(value: str, assets_dir: Path | None = None) -> Path:
    raw = Path(str(value).strip()).expanduser()
    if raw.is_absolute():
        return raw.resolve()

    # A bare filename always belongs to the dedicated manual image folder.
    if len(raw.parts) == 1:
        return (COMPONENT_IMAGE_DIR / raw).resolve()

    # Explicit relative paths are relative to project root.
    return (PROJECT_ROOT / raw).resolve()


def resolve_component_image_path(
    component_name: str,
    *,
    assets_dir: Path | None = None,
    require_exists: bool = True,
) -> Path | None:
    canonical = canonical_component_name(component_name)
    if canonical is None:
        return None

    configured = str(COMPONENT_IMAGE_FILES.get(canonical, "")).strip()
    if not configured:
        return None

    path = _configured_path(configured, assets_dir=assets_dir)
    if require_exists and not path.is_file():
        return None
    return path


def set_component_image_path(component_name: str, file_path: str | Path) -> Path:
    """Runtime helper for an existing file path.

    This changes the in-memory mapping for the current Python process. For a
    permanent mapping, edit COMPONENT_IMAGE_FILES above.
    """
    canonical = canonical_component_name(component_name) or str(component_name).strip()
    if not canonical:
        raise ValueError("component_name is required")

    path = Path(file_path).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Component image does not exist: {path}")
    if path.suffix.lower() not in SUPPORTED_IMAGE_EXTENSIONS:
        raise ValueError(f"Unsupported image type: {path.suffix}")

    COMPONENT_IMAGE_FILES[canonical] = str(path)
    return path


def component_image_folder() -> Path:
    """Create and return the manual component-image folder."""
    COMPONENT_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    return COMPONENT_IMAGE_DIR
