# POL-001 — KYC: Card Member Due Diligence

> Illustrative stand-in for a Devin demo. Not an American Express policy.

| Field | Value |
|-------|-------|
| Policy owner | GFCC Policy & Standards |
| Version | 4.2 (fictional) |
| Applies to | Applicants and card members who are natural persons: consumer cards, small-business cards (sole proprietors), supplementary card members, and authorised users |
| Related | STD-003, STD-004, STD-005 |

## 1. Purpose

Defines the minimum Customer Identification Program (CIP) and Customer Due Diligence (CDD) steps that must be completed before an account is opened and kept up during the life of the relationship.

## 2. When CDD is required

- **§2.1** When an application is submitted for a new card account, including supplementary cards.
- **§2.2** When there is a suspicion of money laundering, terrorist financing or fraud, whatever the account value.
- **§2.3** When there are doubts about whether identification data already collected is true or adequate.
- **§2.4** When there are doubts about whether the person interacting with us is the card member or someone authorised to act for them, for example after an account-takeover signal.

## 3. Identification data to collect

**§3.1 Required data for every applicant:**

| Element | Required | Notes |
|---------|----------|-------|
| Full legal name | Yes | As shown on a government-issued ID |
| Date of birth | Yes | |
| Residential address | Yes | No PO boxes, except for APO/FPO |
| Identification number | Yes | US: SSN/ITIN. Non-US: passport or national ID number |
| Nationality | Primary only | One nationality is captured |
| Place of birth | No | Not collected |
| Tax identification number | US persons only | |
| Email / mobile | Yes | For authentication, not for identity |

**§3.2** Supplementary card members and authorised users give their full name and date of birth. Their identification number is required only if the primary card member's risk rating is High.

## 4. Verification

- **§4.1 Documentary:** a government-issued photo ID, checked by document authentication plus a liveness/selfie match (vendor IDV).
- **§4.2 Non-documentary:** for US applicants who pass bureau and database checks, documentary verification may be skipped.
- **§4.3 Timing:** identity must be verified **before the account is opened**. Instant-decision approvals can issue a virtual card number only after IDV has passed.
- **§4.4 Failure handling:** if identity cannot be verified within 30 days of the application, the application is declined and the case goes to Financial Intelligence Unit (FIU) triage for SAR consideration (STD-005 §3).

## 5. Purpose and intended nature

- **§5.1** Collect the expected monthly spend band, the source of income (employment, self-employed, investments, other), and the declared annual income.
- **§5.2** For small-business sole proprietors, also collect the business type (free text) and the expected annual revenue band.

## 6. Risk rating and enhanced due diligence

- **§6.1** Every applicant is risk-rated at onboarding using STD-003.
- **§6.2** EDD is required for High-risk customers. EDD means a documented source of funds, and a source of wealth where spend is above USD 250k per year, plus GFCC Level 2 approval.
- **§6.3** PEPs, their family members and known close associates are always EDD (STD-004 §4).

## 7. Ongoing due diligence

- **§7.1** Card members are re-reviewed on the cycle set by their risk tier (STD-003 §5).
- **§7.2** The following trigger an event-driven refresh: a change of residential address to another country, a change of name, a sanctions or PEP screening hit, or a spend pattern that does not match the declared profile.

## 8. Simplified due diligence

- **§8.1** Not permitted for consumer cards.

## 9. Exit

- **§9.1** If CDD cannot be completed for an existing card member, the account is suspended, then closed after 60 days, and referred for SAR consideration.
