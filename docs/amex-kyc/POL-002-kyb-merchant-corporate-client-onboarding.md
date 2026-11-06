# POL-002 — KYB: Merchant & Corporate Client Onboarding

> Illustrative stand-in for a Devin demo. Not an American Express policy.

| Field | Value |
|-------|-------|
| Policy owner | GFCC Policy & Standards / Global Merchant Services Risk |
| Version | 3.7 (fictional) |
| Applies to | Legal entities onboarding as merchants (card acceptance / acquiring), corporate card programme clients, and B2B payments clients |
| Related | STD-003, STD-004, STD-005 |

## 1. Purpose

Defines the Know-Your-Business (KYB) requirements for verifying a legal entity, its beneficial owners and its controllers before a merchant account or corporate programme is activated.

## 2. When KYB is required

- **§2.1** When onboarding a new merchant (including sub-merchants under a payment facilitator) or a new corporate client.
- **§2.2** On a change of ownership or control reported by the client or found through screening.
- **§2.3** When there is a suspicion of ML/TF, or doubts about whether data already collected is accurate.

## 3. Entity identification data

**§3.1 Required data for every entity:**

| Element | Required | Notes |
|---------|----------|-------|
| Registered legal name and trading name (DBA) | Yes | |
| Legal form | Yes | |
| Registered office address | Yes | |
| Principal place of business | Only if different | |
| Country of incorporation | Yes | |
| Company registration number | Yes | |
| Tax identification number | Yes | US: EIN. Non-US: local TIN where issued |
| Legal Entity Identifier (LEI) | No | Captured only if the client volunteers it |
| Names of legal representatives / directors | Yes | All directors |
| Nominee shareholders / nominee directors | No | Not asked |
| Merchant Category Code (MCC) and website | Merchants only | |

- **§3.2 Verification sources:** the official company register extract (dated within 90 days) or a registry API from a vendor, plus a TIN match where one is available.

## 4. Beneficial ownership

- **§4.1 Ownership prong:** identify every natural person who owns, **directly**, 25% or more of the equity.
- **§4.2 Indirect ownership:** for layered structures, the onboarding analyst identifies owners "where reasonably apparent". There is no formal method for multiplying holdings through intermediate entities.
- **§4.3 Control prong:** identify **one** individual with significant responsibility for managing the entity (for example the CEO, CFO, COO or Managing Director).
- **§4.4 Data collected per beneficial owner:** full name, date of birth, residential address, ID number, nationality (primary only), and ownership %.
- **§4.5 Verification:** owners at 25% or more and the control person are checked through IDV (POL-001 §4) or by certified copies of ID.
- **§4.6 No owner identified:** if nobody meets §4.1, record "no 25% owner" and continue with the control-prong individual only.
- **§4.7 Registers:** where a public beneficial-ownership register exists, the analyst may look at it for reference. Differences between the register and what the client declares are resolved with the client.
- **§4.8 Bearer shares:** entities that have issued bearer shares are prohibited.

## 5. Nature of business and purpose

- **§5.1** Collect a description of the business, the expected monthly card volume, the average ticket size, the card-not-present percentage and the main countries of sale.
- **§5.2** Corporate clients: expected programme size (number of cards, annual spend) and the intended use.
- **§5.3** The merchant website and storefront are reviewed for prohibited or restricted goods (see the Prohibited & Restricted MCC list, maintained outside this pack).

## 6. Risk rating and EDD

- **§6.1** Each entity is risk-rated using STD-003.
- **§6.2** EDD for High-risk entities includes source of funds for the entity, an adverse-media review of the entity and its beneficial owners, a site inspection or virtual walkthrough (merchants), and GFCC Level 2 approval.
- **§6.3** If any beneficial owner, director or control person is a PEP, the case is EDD.

## 7. Timing

- **§7.1** Standard and High-risk entities: verification is completed before account activation.
- **§7.2 Low-risk deferred verification:** Low-risk merchants (risk score below 30, MCC on the low-risk list, monthly volume below USD 50k) may be activated with funding held. Verification of beneficial owners must then be completed **within 90 days**. If it is not, settlement is suspended.

## 8. Ongoing due diligence

- **§8.1** Periodic review follows the STD-003 §5 cycle.
- **§8.2** Event-driven refresh is triggered by a change of ownership or control, an MCC change, a screening hit, a chargeback ratio above 1.5%, or volume more than 3× the declared amount for 2 consecutive months.

## 9. Exit

- **§9.1** If KYB cannot be completed, onboarding is declined or the relationship is terminated, and the case is referred for SAR consideration (STD-005 §3).
