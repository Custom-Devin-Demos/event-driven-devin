const path = require('path');
const { CATALOG, findOrder } = require('../app/services/verticals/619b204c-data');

const COLORS = { red: '\x1b[41m\x1b[97m', green: '\x1b[42m\x1b[30m', amber: '\x1b[43m\x1b[30m', reset: '\x1b[0m' };

function banner(color, text) {
  console.log(`\n${COLORS[color]}  ${text}  ${COLORS.reset}\n`);
}

async function main() {
  const orderNumber = process.argv[2];
  const order = orderNumber && findOrder(orderNumber);
  if (!order) {
    console.error('Usage: npm run replay:619b204c -- <order number>   (e.g. SO-48211)');
    process.exit(2);
  }
  const middleware = require(path.join(__dirname, '..', 'app', 'services', 'verticals', '619b204c-middleware'));
  const request = middleware.buildRequest(order);
  console.log(`Replaying ${order.orderNumber} (${order.customer}, ${order.country}) against the OrderToFulfillment test endpoint`);
  console.log(`Request payload: ${request.lines.length} lines`);
  try {
    const result = await middleware.sendOrder(order, CATALOG);
    if (result.outcome === 'HOLD') {
      banner('amber', `HOLD  ${order.orderNumber}: ${result.holdCode} (${result.reason})`);
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    banner('green', `PASS  ${order.orderNumber}: ${result.lines} lines fulfilled`);
  } catch (error) {
    banner('red', `FAIL  ${order.orderNumber}: ${error.name}: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
