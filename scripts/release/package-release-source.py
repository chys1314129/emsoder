"""Stage the explicitly approved source allowlist without Git index/history changes."""
from pathlib import Path
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT.parents[1] / "outputs"
SKIP = {"node_modules", "vendor", "target", "gen", "__pycache__", ".git", ".venv", "venv"}
FORBIDDEN = re.compile(r"^(?:\.env(?:\..*)?|credentials\.json|secrets?\.json|emsoder-(?:config|sessions|memories)\.json|Local State|id_rsa|id_ed25519)$", re.I)
TOKEN = re.compile(rb"ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY")


def source_files():
    found = set()
    for folder in ("src", "host", "renderer", "scripts"):
        for p in (ROOT / folder).rglob("*"):
            rel = p.relative_to(ROOT)
            if not p.is_file() or any(part in SKIP for part in rel.parts):
                continue
            if folder == "scripts" and rel.parts[1].startswith("probe-"):
                continue
            if folder == "scripts" and rel.parts[1].startswith("sync-"):
                continue
            if folder == "scripts" and p.suffix not in {".js", ".mjs", ".json", ".txt", ".py"}:
                continue
            found.add(p)
    for folder in ("src-tauri/src", "src-tauri/icons", "src-tauri/capabilities", ".github/workflows"):
        found.update(p for p in (ROOT / folder).rglob("*") if p.is_file())
    for name in ("package.json", "package-lock.json", ".gitignore", "LICENSE", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs", "src-tauri/tauri.conf.json", "resources/core-skills-release.zip"):
        p = ROOT / name
        if not p.is_file():
            raise SystemExit(f"Missing source prerequisite: {name}")
        found.add(p)
    found.update((ROOT / "resources").glob("icon*.png"))
    found.add(ROOT / "resources/icon.ico")
    return sorted(found)


def main():
    OUT.mkdir(exist_ok=True)
    entries = []
    for p in source_files():
        rel = p.relative_to(ROOT)
        if p.is_symlink() or FORBIDDEN.match(p.name) or p.suffix.lower() in {".pfx", ".p12", ".pem", ".key", ".pyc"}:
            raise SystemExit(f"Refusing private/credential path: {rel.as_posix()}")
        data = p.read_bytes()
        if TOKEN.search(data):
            raise SystemExit(f"Possible real credential in source: {rel.as_posix()}")
        entries.append((p, rel, data))
    manifest = {
        "repository": "chys1314129/emsoder",
        "branch": "ci/tauri-windows-release-20261012",
        "uploaded": False,
        "note": "Source snapshot, not an installer or a patch. Review existing-file changes before applying. Local Git index was not modified.",
        "files": [{"path": rel.as_posix(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for _, rel, data in entries],
    }
    archive = OUT / "EMSoder-Tauri-Actions-待提交源码.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for _, rel, data in entries:
            info = zipfile.ZipInfo(rel.as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, data)
    (OUT / "EMSoder-Tauri-Actions-提交白名单.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Approved source snapshot: {len(entries)} files; {archive.stat().st_size} bytes")
    print("No Git staging, commit, push, branch or PR operation performed by this script.")


if __name__ == "__main__":
    main()
