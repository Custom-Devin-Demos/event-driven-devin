# TPL-006 — EU Country Addendum: France (FR)

> Illustrative stand-in for a Devin demo, filled in from [TPL-006](TPL-006-country-addendum-template.md). Not American Express policy and not legal advice. French-law references must be confirmed by Compliance against Légifrance before any real use. The full traceability matrix is in [`FR-requirements.md`](FR-requirements.md). Requirement numbers (`FR-REQ-xx`) are the same in both documents.

## 0. Header

| Field | Value |
|-------|-------|
| Country | France (FR), including the overseas départements and régions (Guadeloupe, Martinique, French Guiana, Réunion, Mayotte). Overseas collectivities (Saint-Barthélemy, Saint-Martin, Saint-Pierre-et-Miquelon, Wallis-et-Futuna, French Polynesia, New Caledonia) and Monaco need a separate legal check. The questionnaire accepts their post codes only. |
| Amex legal entity / licence | *Fictional placeholder:* "Corporate Card Issuer — France" (an illustrative payment/credit institution authorised by the ACPR). Not a real entity or licence. |
| AML/CFT supervisor | Autorité de contrôle prudentiel et de résolution (ACPR), CMF L.561-36. AMLA direct supervision applies only if the entity is selected under Regulation (EU) 2024/1620. |
| Financial Intelligence Unit (FIU) | TRACFIN (Traitement du renseignement et action contre les circuits financiers clandestins). Reports go through the ERMES online channel. |
| Central beneficial-ownership register | Registre des bénéficiaires effectifs (RBE), filed through INPI's Registre national des entreprises (RNE) / guichet unique (CMF L.561-46 et seq.). Public access was restricted after CJEU C-37/20 and C-601/20 (22 Nov 2022), but obliged entities keep access. Discrepancies are reported to the greffe (CMF L.561-47-1). |
| Primary national AML/CFT law | Code monétaire et financier, Book V, Title VI (L.561-1 et seq., R.561-1 et seq.); asset freezes L.562-1 et seq.; arrêté du 6 janvier 2021 (internal control) |
| AMLR application date | 10 July 2027 (AMLR Art. 90) |
| Prepared by / date | Devin (GFCC Policy & Standards demo), 2026-11-06 |

## 1. Regulatory sources

| Source | Use in this addendum | Link |
|--------|----------------------|------|
| Regulation (EU) 2024/1624 (AMLR): Art. 19–28 (CDD), 33–34 (SDD / EDD), 42–46 (PEPs), 51–55, 62–63 (beneficial ownership), 69–73 (reporting, tipping off), 77 (retention), 79–80 (bearer shares, cash), 90 (application) | Primary source for every row | https://eur-lex.europa.eu/eli/reg/2024/1624/oj/eng |
| Directive (EU) 2024/1640 (AMLD6): Art. 10 (central registers), FIU and supervisor powers | Register access and discrepancy follow-up. French transposition is pending (see §5). | https://eur-lex.europa.eu/eli/dir/2024/1640/oj/eng |
| Regulation (EU) 2024/1620 (AMLA) | RTS/ITS and guidelines that AMLR refers to | https://eur-lex.europa.eu/eli/reg/2024/1620/oj/eng |
| Code monétaire et financier L.561-1 to L.561-50, R.561-1 et seq. | National CDD, BO, PEP, TRACFIN, RBE and retention rules until 10 July 2027, and the national options after it | https://www.legifrance.gouv.fr/codes/id/LEGITEXT000006072026/ |
| CMF L.562-1 et seq.; DG Trésor national asset-freeze register | Local sanctions list | https://gels-avoirs.dgtresor.gouv.fr/ |
| Arrêté du 6 janvier 2021 (LCB-FT and asset-freeze internal-control framework) | Governance, controls, group oversight | https://www.legifrance.gouv.fr/ |
| ACPR guidelines on identification, identity verification and knowing the customer; on beneficial owners; on PEPs; ACPR–TRACFIN joint guidelines on the déclaration de soupçon | Supervisory expectations | https://acpr.banque-france.fr/ |
| TRACFIN: ERMES reporting portal and annual guidance | STR channel and format | https://www.economie.gouv.fr/tracfin |
| Décret n° 2019-341 (NIR framework decree); GDPR | Data minimisation, no NIR | https://www.legifrance.gouv.fr/ |
| Loi n° 94-665 du 4 août 1994 (loi Toubon) | French-language customer documents | https://www.legifrance.gouv.fr/ |
| AMLA RTS on CDD information (AMLR Art. 28) and guidelines (Art. 20(3), 26(5), 42(2)) | Not yet reflected; see §5 | https://www.amla.europa.eu/ |

## 2. Requirements matrix

Condensed from [`FR-requirements.md`](FR-requirements.md) §2, with the required change for each row.

| # | Requirement | Source (AMLR art. / national law) | Internal clause (`controls.json` id) | Status (aligned / gap / new) | Required change | UI impact |
|---|-------------|------------------------------------|---------------------------------------|------------------------------|-----------------|-----------|
| FR-REQ-01 | CDD triggers | Art. 19(1); CMF L.561-5 | `POL-001-2.1`–`2.4`, `POL-002-2.1`, `POL-002-2.2` | aligned | — | None |
| FR-REQ-02 | All names and surnames (birth surname, surname of use) | Art. 22(1)(a)(i); CMF R.561-5 | `POL-001-3.1` | gap | Capture the birth surname as the legal surname, plus an optional surname of use and all given names | Labels changed; *Surname of Use* added |
| FR-REQ-03 | Place of birth | Art. 22(1)(a)(ii); CMF R.561-5 | `POL-001-3.1` (`placeOfBirth: not_collected`) | gap ⚠ | Set `placeOfBirth: required` for FR | *Place of Birth: Town / City*, *Country* |
| FR-REQ-04 | All nationalities or status | Art. 22(1)(a)(iii) | `POL-001-3.1` (`nationality: primary_only`) | gap ⚠ | Set `nationality: all`, with stateless / refugee / subsidiary-protection options | New *Nationality* step |
| FR-REQ-05 | National ID number only where applicable; no NIR | Art. 22(1)(a)(iii); Décret 2019-341 | `POL-001-3.1` (`identificationNumber`) | gap | Use the ID document number as the FR identifier. Never collect the NIR. | SSN/ITIN step removed |
| FR-REQ-06 | Usual place of residence, French format | Art. 22(1)(a)(iv) | `POL-001-3.1` | aligned | Add BP / CS / TSA / CEDEX / poste restante to the PO-box exclusions | Address step reworked |
| FR-REQ-07 | TIN where available | Art. 22(1)(a)(iv) | `POL-001-3.1` (`us_persons_only`) | gap | Set `taxIdentificationNumber: where_available` | Optional *numéro fiscal* |
| FR-REQ-08 | ID document or eIDAS substantial/high | Art. 22(6); CMF R.561-5, R.561-5-1 | `POL-001-4.1`, `POL-001-4.2` | gap | List French documents; plan an eIDAS route; non-documentary checks are not allowed in FR | *Identity Document* step |
| FR-REQ-09 | Verify before onboarding; SDD postponement ≤ 60 days | Art. 23, 33(1)(a) | `POL-002-7.2` (90 days) | gap ⚠ | FR `maxDeferralDays: 60` | None |
| FR-REQ-10 | Occupation / business activity | Art. 20(1)(e), 25; CMF L.561-5-1 | `POL-001-5.1` | gap | Add occupation to the individual data set | New *Occupation* step |
| FR-REQ-11 | PEP / family / close associate | Art. 20(1)(g), 42, 46; CMF L.561-10, R.561-18 | `POL-001-6.3`, `STD-004-4.2`–`4.4` | aligned | Add a self-declaration to supplement screening | New *PEP* step |
| FR-REQ-12 | Former PEP ≥ 12 months, then risk-based | Art. 45 | `STD-004-4.5` | gap | Removing the flag after 12 months needs a documented risk rationale | *Date the Function Ended* |
| FR-REQ-13 | Authorisation of person acting for the customer | Art. 20(1)(i) | `POL-002-3.1` | new | Link each card member to the corporate client's KYB record | *Employer SIREN number* |
| FR-REQ-14 | LEI where available; nominee shareholders and directors | Art. 22(1)(b)(iii)–(iv) | `POL-002-3.1` | gap ⚠ | `legalEntityIdentifier: where_available`; `nomineeShareholdersOrDirectors: required` | None (KYB) |
| FR-REQ-15 | Indirect 25 % with multiplication | Art. 52(1); CMF R.561-1 | `POL-002-4.1`, `POL-002-4.2` | gap ⚠ | `basis: direct_or_indirect`, `method: multiplication` | None (KYB) |
| FR-REQ-16 | All controllers; all senior managing officials as fallback | Art. 51, 53, 22(2), 63(4) | `POL-002-4.3`, `POL-002-4.6` | gap ⚠ | `controlPersons: all`, `fallback: all_senior_managing_officials` | None (KYB) |
| FR-REQ-17 | Full BO data set | Art. 62(1)(a)–(b) | `POL-002-4.4` | gap ⚠ | Add place of birth, all nationalities, nature/extent of interest, start date | None (KYB) |
| FR-REQ-18 | Mandatory register check and proof of registration | Art. 22(7), 23(4); CMF L.561-46 | `POL-002-4.7`, `POL-002-3.2` | gap ⚠ | `registerCheck: mandatory` (RBE/RNE); Kbis or proof of registration on file | None (KYB) |
| FR-REQ-19 | Discrepancy reporting within 14 days | Art. 24; CMF L.561-47-1 | `POL-002-4.7` | gap ⚠ | `discrepancyReporting: register_within_14_days` | None (KYB) |
| FR-REQ-20 | Bearer shares | Art. 79(3) | `POL-002-4.8` | aligned | — | None |
| FR-REQ-21 | TFS incl. 50 % ownership; French freeze list | Art. 20(1)(d), 26(4); CMF L.562-1 | `STD-004-2.1` | gap | Add the DG Trésor national register; screen on every new designation | None |
| FR-REQ-22 | Review ≤ 1 y (high) / ≤ 5 y (others) | Art. 26(2) | `STD-003-5` (low 84 months) | gap ⚠ | FR `low: 60` | None |
| FR-REQ-23 | EDD and unusual transactions | Art. 34; CMF L.561-10-2 | `POL-001-6.2`, `POL-002-6.2`, `STD-005-1.3` | aligned | — | None |
| FR-REQ-24 | Refrain / terminate when CDD fails | Art. 21; CMF L.561-8 | `POL-001-4.4`, `POL-001-9.1`, `POL-002-9.1` | gap | Treat the 60-day suspension as a termination path; record every refusal | None |
| FR-REQ-25 | STR to TRACFIN; refrain before reporting | Art. 69, 71; CMF L.561-15, L.561-16 | `STD-005-3.2` | new | FR FIU = TRACFIN via ERMES | None |
| FR-REQ-26 | FIU requests within 5 working days | Art. 69(1); CMF L.561-25 | `STD-005-3.3` (10 days) | gap ⚠ | FR `maxBusinessDays: 5` (or shorter if TRACFIN asks) | None |
| FR-REQ-27 | TRACFIN right of opposition | CMF L.561-24 | — | new | Payments hold workflow on TRACFIN notice | None |
| FR-REQ-28 | No tipping off | Art. 73; CMF L.561-19 | `STD-005-3.4` | aligned | — | None |
| FR-REQ-29 | 5-year retention, unredacted, then deletion | Art. 77; CMF L.561-12 | `STD-005-4.1`, `STD-005-4.2` | gap | Add deletion when the period ends; define reference-only retention under Art. 77(2) | Privacy notice |
| FR-REQ-30 | ACPR supervision; arrêté 6 Jan 2021 | CMF L.561-36 | — | new | Map controls to the arrêté | None |
| FR-REQ-31 | French-language documents | Loi n° 94-665 | — | new | French translation of the questionnaire and notices | French terms in labels |
| FR-REQ-32 | GDPR notice; no NIR | GDPR; Décret 2019-341; AMLR Art. 76 | — | new | Information notice in the onboarding flow | *privacyNotice* |
| FR-REQ-33 | Group-wide information | Art. 26(1) | `STD-005-2.1` | aligned | — | None |
| FR-REQ-34 | Cash limits (FR EUR 1 000) | Art. 80; CMF L.112-6 | `STD-005-5.1` | aligned | — | None |
| FR-REQ-35 | Legal basis notice (AMLR / CMF) | Art. 22, 90; CMF L.561-5 | — | new | Replace the USA PATRIOT Act notice | Title and notice changed |
| FR-REQ-36 | Persons for whose benefit a transaction is carried out | Art. 20(1)(h), 22(1) | `POL-001-3.2` | gap | Full identification of supplementary users | None (corporate) |

## 3. Country-specific obligations

- **National options and local rules.** French cash limit: EUR 1 000 for residents (CMF L.112-6). Not relevant because the issuer accepts no cash (STD-005 §5.1). France may add categories of prominent public functions to its list under AMLR Art. 43(1). Use the list France notifies to the Commission, and CMF R.561-18 until then.
- **Local registers.** RBE through INPI's RNE / guichet unique for beneficial owners. The RNE / Kbis (extrait d'immatriculation, generally no older than 3 months in ACPR practice, which fits POL-002 §3.2's 90 days) for entity identification, keyed on the **SIREN** (9 digits, Luhn check). Discrepancies go to the greffe within 14 calendar days (AMLR Art. 24, CMF L.561-47-1).
- **Local FIU reporting channel.** TRACFIN, through ERMES. Refrain from executing the transaction before reporting (AMLR Art. 71, CMF L.561-16). TRACFIN may oppose execution (CMF L.561-24) and may request information (CMF L.561-25, AMLR Art. 69: 5 working days unless TRACFIN shortens it).
- **Local sanctions lists.** The French national asset-freeze register (Direction générale du Trésor, CMF L.562-1 et seq.), in addition to the UN, EU, OFAC and UK lists in STD-004 §2.1.
- **Language.** Customer-facing documents and notices in French (loi Toubon). The demo shows French legal terms next to the English labels. See §5.
- **National ID documents accepted for IDV.** Carte nationale d'identité: the card format from 2021 has a 9-character number, and the older card a 12-character number. French passport (2 digits, 2 letters, 5 digits). Titre de séjour (residence permit). EU/EEA national identity cards. Foreign passports. The French Mobile ID (France Identité) and FranceConnect+ are eIDAS *substantial* means that could become a remote route (AMLR Art. 22(6)(b)). They are not built in this demo.
- **Data protection.** Never request the NIR (Décret 2019-341). Show a GDPR information notice. Delete personal data when the 5-year AMLR retention period ends (Art. 77(3)).

## 4. Onboarding data model changes

### 4.1 Individual (POL-001) — implemented in `MARKETS.FR`

| Step | Field (`id`) | Type | Required | Validation (server-side rule) | Requirement |
|------|--------------|------|----------|-------------------------------|-------------|
| `intro` | `regulatoryNotice` (changed), `privacyNotice` (new) | text | — | — | FR-REQ-35, FR-REQ-32 |
| `legal-name` | `middleName`: label *Other Given Names (if applicable)* | text | No | `personName` | FR-REQ-02 |
| `legal-name` | `lastName`: label *Birth Surname (nom de naissance)* | text | Yes | `personName` | FR-REQ-02 |
| `legal-name` | `usageName` | text | No | `personName` | FR-REQ-02 |
| `legal-name` | `birthCity` | text | Yes | `placeName` (letters, spaces, hyphens, apostrophes, parentheses; ≤ 80) | FR-REQ-03 |
| `legal-name` | `birthCountry` | select (ISO 3166), default `FR` | Yes | must be a listed country | FR-REQ-03 |
| `nationality` | `nationalityStatus` | radio: `national`, `stateless`, `refugee`, `subsidiary-protection` | Yes | must be an option | FR-REQ-04 |
| `nationality` | `nationality` | select | Yes, if `national` | listed country | FR-REQ-04 |
| `nationality` | `hasOtherNationality` | radio `no` / `yes` | Yes, if `national` | option | FR-REQ-04 |
| `nationality` | `secondNationality` | select | Yes, if `yes` | `distinctNationality` (≠ `nationality`) | FR-REQ-04 |
| `nationality` | `thirdNationality` | select | No (shown if `yes`) | `distinctNationality` (≠ first and second) | FR-REQ-04 |
| `nationality` | `protectionCountry` | select | Yes, if `refugee` / `subsidiary-protection` | listed country | FR-REQ-04 |
| `residential-address` | `addressLine1`, `addressLine2` | text | Yes / No | `noPoBoxFr` (US PO box + BP, CS, TSA, CEDEX, poste restante, boîte postale) | FR-REQ-06 |
| `residential-address` | `city`: label *Town / City* | text | Yes | `placeName` | FR-REQ-06 |
| `residential-address` | `country` | select, default `FR` | Yes | listed country | FR-REQ-06 |
| `residential-address` | `region` | text | Yes, unless country is US, FR, overseas or MC | — | FR-REQ-06 |
| `residential-address` | `postCode`: label *Post code (code postal)* | text | Yes | `postalCodeFr`: FR 01000–95999; GP 971xx, MQ 972xx, GF 973xx, RE 974xx, PM 975xx, YT 976xx, BL 977xx, MF 978xx, MC 980xx, WF 986xx, PF 987xx, NC 988xx; US 5-digit zip; otherwise alphanumeric | FR-REQ-06 |
| `identity-document` | `idDocumentType` | select: `fr-cni`, `fr-passport`, `fr-residence-permit`, `eu-eea-id`, `foreign-passport` | Yes | option | FR-REQ-08 |
| `identity-document` | `idDocumentNumber` | text | Yes | `frIdDocumentNumber`: CNI 9 or 12 alphanumeric; passport `^\d{2}[A-Z]{2}\d{5}$`; titre de séjour 9–10 alphanumeric; otherwise generic document number | FR-REQ-08 |
| `identity-document` | `idIssuingCountry` | select | Yes, for `eu-eea-id` / `foreign-passport` | `idIssuingCountry`: EU/EEA for EU ID; not FR for foreign passport | FR-REQ-08 |
| `identity-document` | `idIssueDate`, `idExpiryDate` | date | Yes | `pastDate`; `notExpired` after issue date | FR-REQ-08 |
| `identity-document` | `idDocument` | file (PDF / JPG / PNG) | Yes | `documentUpload` | FR-REQ-08 |
| `identity-document` | `taxIdNumber` | text, sensitive (stored as last 4) | No | `frTaxId`: 13 digits starting 0–3 | FR-REQ-07 |
| `occupation` | `occupation` | select (employee, manager, corporate officer, public sector, self-employed, other) | Yes | option | FR-REQ-10 |
| `occupation` | `jobTitle` | text | Yes | `jobTitle` (letters, digits, basic punctuation; 2–80) | FR-REQ-10 |
| `occupation` | `employerSiren` | text | Yes | `siren`: 9 digits + Luhn | FR-REQ-13 |
| `pep` | `pepStatus` | radio: `no`, `pep`, `former-pep`, `family`, `associate` | Yes | option | FR-REQ-11 |
| `pep` | `pepRelatedName` | text | Yes, if `family` / `associate` | `personName` | FR-REQ-11 |
| `pep` | `pepFunction` | text | Yes, if any PEP status | `jobTitle` | FR-REQ-11 |
| `pep` | `pepCountry` | select | Yes, if any PEP status | listed country | FR-REQ-11 |
| `pep` | `pepEndDate` | date | Yes, if `former-pep` | `endedDate` (not in the future) | FR-REQ-12 |
| `national-id` | `idType`, `ssn`, `itin`, `govId*` | — | **Removed** for FR | — | FR-REQ-05, FR-REQ-08 |

Conditional fields use `showWhen` with `equals`, `notEquals`, `in` or `notIn`. A field whose controlling field is hidden is also hidden, so it is never required or stored.

### 4.2 Entity (POL-002) — back office, not in this portal

LEI (where available), nominee shareholder and director flags, the beneficial-owner list with direct/indirect percentage, nature of control, start date, place of birth and all nationalities, the senior-managing-officials fallback list, the RBE/RNE check result and a discrepancy-report reference (FR-REQ-14 to FR-REQ-19).

## 5. Open questions for Compliance

1. **AMLA RTS on CDD information (AMLR Art. 28):** the draft was due 10 July 2026. Confirm the adopted text, in particular the minimum data in lower-risk situations and the eIDAS attribute list, before go-live.
2. **AMLD6 transposition in France** (register access, discrepancy follow-up by the greffe, supervisor powers): confirm the French implementing law and whether CMF L.561-46 et seq. will be renumbered.
3. **eIDAS route:** should France Identité / FranceConnect+ (substantial) be offered as an alternative to uploading a document (Art. 22(6)(b))?
4. **Language:** is a full French version of the questionnaire, notices and thank-you page needed for corporate card members (loi Toubon), or are bilingual labels enough for a B2B programme?
5. **Record retention format:** the demo stores sensitive identifiers redacted. AMLR Art. 77(1) requires unredacted records unless Art. 77(2) reference-only retention is defined in internal procedures. Confirm where the full record lives.
6. **Former PEP end date:** should the portal block self-service submission and route to Level 2 approval when `pepStatus` is not `no` (STD-004 §4.2), or capture the answer and let screening decide?
7. **Overseas collectivities and Monaco:** confirm whether residents of PF, NC, WF, PM, BL, MF and MC are in scope of the French entity or need their own addendum.
8. **Card-member scope vs customer scope:** for corporate cards, confirm that card members are treated as persons acting on behalf of the corporate customer (Art. 20(1)(i)) rather than as customers in their own right. This decides how much of Art. 22(1)(a) applies.
9. **Policy-pack updates:** the ⚠ conflicts in `FR-requirements.md` §3 also affect every other EU market. Should they be fixed in the baseline policies (POL-001, POL-002, STD-003, STD-004, STD-005) rather than in each addendum?
