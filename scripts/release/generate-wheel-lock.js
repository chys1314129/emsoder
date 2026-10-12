const fs = require("node:fs");
const path = require("node:path");
function fromReport(report) {
  if (!Array.isArray(report.install)) throw new Error("pip report has no install entries");
  const lines = [];
  for (const item of report.install) {
    const name = item.metadata?.name;
    const version = item.metadata?.version;
    const hash = item.download_info?.archive_info?.hashes?.sha256;
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !/^[0-9A-Za-z.+-]+$/.test(version) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid wheel lock entry");
    const url = new URL(item.download_info.url);
    if (url.protocol !== "https:" || url.hostname !== "files.pythonhosted.org" || !url.pathname.endsWith(".whl")) throw new Error("Only verified PyPI wheel downloads are accepted");
    lines.push(`${name}==${version} --hash=sha256:${hash}`);
  }
  return "# Locked CPython 3.13 Windows x64 wheels; generated from a successful pip dry-run.\n" + lines.sort().join("\n") + "\n";
}
module.exports = { fromReport };
if (require.main === module) {
  const reportPath = process.argv[2];
  const output = process.argv[3];
  if (!reportPath || !output) throw new Error("Usage: generate-wheel-lock.js <pip-report.json> <lock.txt>");
  fs.writeFileSync(path.resolve(output), fromReport(JSON.parse(fs.readFileSync(reportPath))));
  console.log("Wheel hashes locked for Windows x64");
}
