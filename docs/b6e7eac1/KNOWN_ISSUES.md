# KNOWN_ISSUES — rental-return integration service (b6e7eac1)

Tracked gaps the team is aware of. Agents: reference these by ID rather than rediscovering them.

| ID | Area | Issue | Owner | Status |
|---|---|---|---|---|
| KI-07 | Mapper | `mapReturnEvent` clamps `fuelPercent` outside 0–100 to the nearest bound and only records a warning. Cat Rentals has sent values above 100% (telematics unit calibration). We write the clamped value to F&O and lose the original. Decision pending with Cat Rentals: reject vs clamp. | Cat Rentals (data) / this team (behaviour) | Open |
| KI-11 | Dealer directory | Cat Rentals started emitting country-suffixed dealer codes for multi-country dealers (`<DEALER>-<ISO2>`). `resolveDealer` resolves exact codes only; there is no alias table. | This team | Open |
| KI-12 | Warehouse map | New dealer yards are added to Cat Rentals before the branch→warehouse map in `WAREHOUSE_MAP` in `b6e7eac1-seed.js` is updated. No automated reconciliation against F&O `InventWarehouses`. | This team / dealer onboarding | Open |
| KI-15 | Replay | Replay is manual (`POST /deadletters/{id}/replay`). No scheduled retry; by design until mapping gaps are closed, so one bad message does not loop. | This team | Accepted |
