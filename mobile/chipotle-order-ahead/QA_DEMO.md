# Devin Mobile-QA Demo

This app (at `mobile/chipotle-order-ahead/` in `COG-GTM/event-driven-devin`) is
designed to demo **Devin QA'ing a mobile app**: closing a coverage gap that, in
the process, surfaces and fixes a real bug — the everyday work of a mobile QA
engineer, mapped onto Chipotle's stack (React Native + a 90% coverage gate +
Azure DevOps CI).

## Starting state (intentional)

- ✅ The existing Jest suite **passes**.
- ❌ CI is **red** because coverage on `src/lib/**` is **below the 90% gate**.
- 🐛 An under-tested code path hides a real pricing bug.

Reproduce:

```bash
cd mobile/chipotle-order-ahead
npm ci
npm run test:coverage
```

You'll see the specs pass but the run fail on
`Jest: "global" coverage threshold for … not met`.

## The planted bug

`applyPromo()` in `src/lib/pricing.ts` handles two promo types. The `percent`
branch is tested; the **`fixed`-dollar branch is not**, and it does not clamp the
discount to the subtotal:

```ts
// src/lib/pricing.ts
export function applyPromo(subtotal: number, promo?: Promo): number {
  if (!promo) return round(subtotal);
  if (promo.type === 'percent') {
    return round(subtotal - subtotal * promo.value);
  }
  // fixed-dollar promo — BUG: not clamped, can go negative
  return round(subtotal - promo.value);
}
```

Applying `WELCOME5` ($5 off) to a $2.95 fountain drink yields a **negative**
discounted total (`-2.05`), which then produces negative tax, service fee, and
order total. `src/lib/loyalty.ts` is also under-tested (only `earnedPoints` has a
spec; the tier/redemption branches are uncovered), which keeps overall coverage
below the gate.

**Correct behavior:** clamp the fixed discount at zero:
`return round(Math.max(0, subtotal - promo.value));`

## The QA task (what Devin does)

Suggested prompt for the demo session:

> QA the Chipotle Order Ahead mobile app in `COG-GTM/event-driven-devin` (it
> lives in `mobile/chipotle-order-ahead/`). `npm run test:coverage` there is
> failing the 90% coverage gate. Raise coverage on `src/lib/**` to pass the gate,
> and fix any bugs the new tests uncover. Open a PR to
> `COG-GTM/event-driven-devin`.

Expected outcome:

1. Devin adds specs for the untested `fixed`-promo branch and `loyalty.ts`.
2. The new `fixed`-promo spec **fails**, exposing the negative-total bug.
3. Devin fixes `applyPromo` (clamp at 0), all specs pass, coverage ≥ 90%.
4. `npm run test:coverage` exits 0 (gate green); Devin opens a PR.

## Reset

To re-run the demo, revert the fix and remove the added specs (or reset the
branch to `main`).
