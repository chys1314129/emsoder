// Sample for EMSoder Node debugger (F9 breakpoints, then Debug → Start)
function add(a, b) {
  const s = a + b;
  console.log("sum =", s);
  return s;
}

function main() {
  console.log("EMSoder debug sample start");
  let total = 0;
  for (let i = 1; i <= 3; i++) {
    total = add(total, i);
  }
  console.log("done", total);
}

main();
