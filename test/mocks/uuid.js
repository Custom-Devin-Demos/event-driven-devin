let counter = 0;

function v4() {
  counter += 1;
  return `test-uuid-${counter.toString(16).padStart(12, '0')}`;
}

module.exports = { v4 };
