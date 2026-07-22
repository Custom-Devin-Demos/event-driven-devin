# Chipotle Order Ahead — Mobile App

A React Native (Expo) "Order Ahead" mobile ordering app for Chipotle. Build a
bowl/burrito, add sides and drinks, apply a promo code, and see your order total
and Chipotle Rewards points.

This app lives at `mobile/chipotle-order-ahead/` inside
`COG-GTM/event-driven-devin` and is a **Devin mobile-QA demo target**: it ships
with a passing test suite that does **not** meet the enforced **90% coverage
gate**, and the under-tested code hides a real pricing bug. See
[`QA_DEMO.md`](./QA_DEMO.md).

## Stack

- **React Native 0.74 / Expo SDK 51** (TypeScript)
- **Jest + ts-jest** for unit tests
- **90% coverage gate** enforced in CI (mirrors Chipotle's Jasmine/Karma gate)
- **CI/CD:** an illustrative GitHub Actions workflow (`.github/workflows/ci.yml`)
  and an Azure DevOps pipeline (`azure-pipelines.yml`) — both enforce the 90%
  gate and mirror Chipotle's CI/CD backbone. (They are scoped to this subfolder;
  the demo gate is run locally/by Devin via `npm run test:coverage`.)

## Project layout

```
src/
  lib/           # pure business logic (unit-test target, coverage-scoped)
    menu.ts      # menu data + lookups
    cart.ts      # add/remove/subtotal
    pricing.ts   # promos, tax, service fee, order totals
    loyalty.ts   # rewards points + tiers
  screens/
    OrderScreen.tsx   # mobile ordering UI (uses src/lib)
App.tsx
__tests__/       # Jest specs
```

## Run the app

```bash
cd mobile/chipotle-order-ahead
npm install
npm start          # Expo dev server (press w for web, i/a for simulators)
```

## Run the tests

```bash
npm test               # run the suite
npm run test:coverage  # run with coverage + enforce the 90% gate
npm run typecheck      # tsc --noEmit
```

`npm run test:coverage` **exits non-zero** until coverage reaches 90% on
`src/lib/**`.
