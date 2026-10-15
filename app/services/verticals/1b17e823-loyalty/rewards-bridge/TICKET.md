# LOY-214: Bring Foot Locker FLX members into DICK'S rewards

**Context.** DICK'S has acquired Foot Locker. Foot Locker customers earn points
in FLX (`COG-GTM/flx-loyalty`); DICK'S customers earn points in ScoreCard
(`../scorecard`). Many customers are members of both, and the two systems
have never talked to each other.

**Goal.** A customer shopping at DICK'S can link their FLX account and see their
FLX rewards alongside their ScoreCard rewards, and later spend FLX points at
DICK'S checkout. Both programs keep running as they are (no migration yet).

**First slice.**
- On the DICK'S cart page, a signed-in ScoreCard member can link their FLX account.
- After linking, the page shows a combined rewards balance (ScoreCard + FLX).

**Later slices.** Spend FLX points at DICK'S checkout; reconciliation report of
matched/unmatched members.

**Needs a decision.**
- How to match a ScoreCard member to an FLX member.
- How FLX points and status levels translate into ScoreCard terms.
- What happens to expired or zero-balance FLX points.

**Out of scope.** Migrating FLX members into ScoreCard; changing the FLX service.
