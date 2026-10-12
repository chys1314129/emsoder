"""Create a deterministic core-skill resource archive without local cache/config files."""
from pathlib import Path
import hashlib
import re
import zipfile

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "resources" / "core-skills"
OUTPUT = ROOT / "resources" / "core-skills-release.zip"
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".cache"}
FORBIDDEN = re.compile(r"^(?:\.env(?:\..*)?|credentials\.json|secrets?\.json|emsoder-(?:config|sessions|memories)\.json|Local State|id_rsa|id_ed25519)$", re.I)


def main():
    entries = []
    for p in sorted(CORE.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(CORE)
        if any(part in SKIP_DIRS for part in rel.parts) or p.suffix in {".pyc", ".pyo"} or p.name == ".env.example":
            continue
        if p.is_symlink() or FORBIDDEN.match(p.name) or p.suffix.lower() in {".pfx", ".p12", ".pem", ".key"}:
            raise SystemExit(f"Refusing to package private/credential file: {rel.as_posix()}")
        entries.append((p, rel))
    if not entries:
        raise SystemExit("Core skills are missing")
    with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p, rel in entries:
            info = zipfile.ZipInfo(rel.as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, p.read_bytes())
    print(f"Core archive: {len(entries)} files; {OUTPUT.stat().st_size} bytes")
    print("sha256=" + hashlib.sha256(OUTPUT.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
