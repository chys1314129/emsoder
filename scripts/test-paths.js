const { resolveSafePath } = require("../src/tools/paths");

const root = "D:\\proj";
const cases = [
  ["src/a.js", true],
  ["..\\Windows\\x", false],
  ["D:\\proj\\ok.ts", true],
  ["D:\\other\\x", false],
];

let failed = 0;
for (const [input, expectOk] of cases) {
  const r = resolveSafePath(root, input);
  const pass = r.ok === expectOk;
  console.log(pass ? "OK " : "FAIL ", input, "=>", r.ok ? r.relative : r.error);
  if (!pass) failed++;
}
process.exit(failed ? 1 : 0);
