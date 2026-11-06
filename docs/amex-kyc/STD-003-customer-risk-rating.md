# STD-003 — Customer Risk Rating Methodology

> Illustrative stand-in for a Devin demo. Not an American Express standard.

| Field | Value |
|-------|-------|
| Owner | GFCC Analytics |
| Version | 2.4 (fictional) |
| Applies to | POL-001 and POL-002 populations |

## 1. Purpose

Defines how each customer is given a Low, Medium or High ML/TF risk rating, and the review cycle that each rating drives.

## 2. Risk factors and weights

| Factor | Individuals (POL-001) | Entities (POL-002) | Weight |
|--------|----------------------|--------------------|--------|
| Geography (residence / incorporation / operations) | Yes | Yes | 25 |
| Product (consumer, corporate, acquiring, B2B payments) | Yes | Yes | 15 |
| Customer type / legal form | — | Yes | 10 |
| Industry / MCC | — | Yes | 15 |
| PEP exposure | Yes | Yes (owners, directors, control person) | 15 |
| Expected volume vs. profile | Yes | Yes | 10 |
| Delivery channel (non-face-to-face, intermediary) | Yes | Yes | 5 |
| Ownership complexity (layers, trusts, nominee arrangements) | — | Yes | 5 |

**§2.1 Geography inputs:** the FATF "black list" and "grey list", the US State Department's major money-laundering jurisdictions list, and the internal country-risk table.

## 3. Score to tier

| Score | Tier |
|-------|------|
| 0–29 | Low |
| 30–59 | Medium |
| 60+ | High |

- **§3.1 Automatic High:** confirmed PEP, any FATF black-list nexus, a negative sanctions-adjacent finding, or an MCC on the high-risk list (for example money services, crypto on/off-ramps, gambling, precious metals).

## 4. Overrides

- **§4.1** An analyst may raise any tier. Lowering a tier requires GFCC Level 2 approval and a written rationale.

## 5. Periodic review cycle

| Tier | Maximum interval between full CDD refreshes |
|------|---------------------------------------------|
| High | 12 months |
| Medium | 3 years |
| Low | 7 years |

- **§5.1** A review refreshes identification data, beneficial ownership (for entities), screening results, and the purpose and nature of the relationship.
- **§5.2** The review cycle restarts after any event-driven refresh.
