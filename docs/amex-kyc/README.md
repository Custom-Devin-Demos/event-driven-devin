# Amex-style KYC / KYB Policy Pack (illustrative stand-in)

> **Disclaimer.** These documents are a **fictional, illustrative stand-in** written for a Devin demo. They are modelled on the general shape of KYC/KYB programmes at large US card issuers and merchant acquirers. They are **not** American Express policies. They have not been reviewed by Amex and must not be used as compliance guidance.

The pack is the "internal policy" input for the EU country-requirements demo. Devin reads these documents together with **Regulation (EU) 2024/1624** (the AML Regulation, "AMLR", https://eur-lex.europa.eu/eli/reg/2024/1624/oj/eng). For a chosen country, Devin then produces:

1. a requirements matrix that links each AMLR article, any national-law obligation and the matching internal policy clause, and flags each row as a gap or as aligned,
2. a wireframe of the onboarding screens that change,
3. a PR that implements the change in the demo UI.

## Contents

| ID | Document | Scope |
|----|----------|-------|
| POL-001 | [KYC — Card Member Due Diligence](POL-001-kyc-card-member-due-diligence.md) | Consumer and small-business card members (natural persons) |
| POL-002 | [KYB — Merchant & Corporate Client Onboarding](POL-002-kyb-merchant-corporate-client-onboarding.md) | Merchants (acquiring) and corporate card / payments clients (legal entities) |
| STD-003 | [Customer Risk Rating Methodology](STD-003-customer-risk-rating.md) | Risk scoring, tiers, periodic review cycles |
| STD-004 | [Sanctions, PEP & Adverse Media Screening](STD-004-sanctions-pep-adverse-media-screening.md) | Screening lists, PEP handling, escalation |
| STD-005 | [Monitoring, Reporting & Record Retention](STD-005-monitoring-reporting-record-retention.md) | Transaction monitoring, SAR/STR, FIU requests, retention |
| TPL-006 | [Country Addendum Template](TPL-006-country-addendum-template.md) | Template that Devin fills in per EU Member State |
| — | [`controls.json`](controls.json) | Machine-readable control catalog (one entry per policy clause) |

## Programme context (fictional)

- **Owner:** Global Financial Crimes Compliance (GFCC), Policy & Standards.
- **Baseline:** written to the US framework (Bank Secrecy Act, USA PATRIOT Act §326 CIP, FinCEN CDD Rule 31 CFR 1010.230, OFAC). EU entities apply it today through local addenda under the 4th/5th AML Directives.
- **Why this matters now:** AMLR is directly applicable in every Member State **from 10 July 2027** (AMLR Art. 90). It replaces most national transpositions of Directive (EU) 2015/849. Some obligations still vary by country because of Directive (EU) 2024/1640 (AMLD6), national supervisors and FIUs, central beneficial-ownership registers, and Member State options such as lower cash limits. Each EU country therefore needs its own addendum (TPL-006).
- **Products in scope:** consumer charge/credit cards, small-business cards, corporate cards, merchant acquiring, and B2B payments.

## How to use in the demo

Example prompt:

> Ingest Regulation (EU) 2024/1624 from EUR-Lex and the policies in `docs/amex-kyc/`. Generate the KYC/KYB requirements for **France**. Produce a requirements matrix with columns: requirement, source (AMLR article / French law), internal policy clause (`controls.json` id), status (aligned / gap / new), and UI impact. Fill in TPL-006 for France. Then produce a wireframe of the onboarding changes and open a PR that implements them.

Clause IDs (for example `POL-002 §4.3`) are stable. `controls.json` uses the same IDs, so requirements can be traced back to clauses automatically.
