# <INCIDENT ID> — <one-line summary>

| Field | Value |
|---|---|
| Priority | |
| Team | |
| Concurrent request | |
| Orders affected | |
| Opened / resolved | |
| Pull request | |

## What happened
<Plain language: what the fulfillment team saw and which orders were stuck.>

## Root cause
<What failed, in which file and function, and why it started now.>

## Fix
<What changed and why it is safe. Confirm compliance checks are unchanged.>

## Proof
- Replay before: `npm run replay:619b204c -- <order>` → 
- Replay after: 
- Boundary checks (30 / 31 lines): 
- Tests: `npx jest tests/619b204c` → 
- Test-instance rerun: request <id>, <n> fulfilled, <n> on legitimate hold

## Orders recovered
| Order | Customer | Result |
|---|---|---|

## Follow-ups
<Anything IT should approve or monitor before the production change.>
