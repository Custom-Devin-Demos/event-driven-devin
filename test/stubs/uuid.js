// Minimal CommonJS stub for the ESM-only `uuid` package, used so Jest can run
// without transforming node_modules. Only v4 is needed by the code under test.
let counter = 0;

function v4() {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

module.exports = { v4 };
