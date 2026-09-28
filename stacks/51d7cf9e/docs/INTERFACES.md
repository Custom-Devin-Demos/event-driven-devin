# Component contracts

The four components run as separate processes and meet only at the interfaces
below. Each component owner may change internals freely but must keep these
contracts (or update this file in the same change).

```
Android handheld ──TCP 3390 (rdp-sim wire protocol)──▶ Windows VM: EimRf.exe + RdpSim.dll
                                                             │
                                                             └─HTTP/JSON (RFC over HTTP)──▶ sap-mock :8400
```

## 1. Latency / profile config — `config/demo-profile.json`

Single file read by both `sap-mock` and the WinForms app (for `rdp`/`wifi`).
`activeProfile` selects the profile; env var `EIMRF_PROFILE` overrides it.

| Key | Used by | Meaning |
|---|---|---|
| `sap.logonMs` | sap-mock | Delay on every `/rfc/logon` (new RFC connection) |
| `sap.callMs` ± `sap.callJitterMs` | sap-mock | Delay on every `/rfc/call` |
| `sap.functionProcessingMs.<FM>` | sap-mock | Extra server-side processing time for posting FMs (update task, commit wait) |
| `rdp.oneWayLatencyMs` ± `rdp.jitterMs` | rdp-sim | Added to every message in each direction (RTT ≈ 2×) |
| `rdp.fps`, `rdp.jpegQuality` | rdp-sim | Frame stream rate / JPEG quality |
| `wifi.flaky`, `wifi.dropEverySec`, `wifi.reconnectDelaySec` | rdp-sim | Flaky plant Wi-Fi: drop all sessions every ~N s (±20%), refuse reconnects for M s |

## 2. SAP mock — RFC over HTTP (`sap-mock`, default `http://<host>:8400`)

All bodies are JSON. Every request from the legacy app carries header
`X-EIM-Txn: <Workflow>/<Step>` (e.g. `MoveInventory/ScanPallet`) so the mock can
count logons and calls per transaction step.

| Endpoint | Body | Response |
|---|---|---|
| `POST /rfc/logon` | `{"user":"RFCEIM","client":"100"}` | `{"sessionId":"…"}` after `logonMs` |
| `POST /rfc/call` | `{"sessionId","function","imports":{…},"tables":{"NAME":[{…}]}}` | `{"exports":{…},"tables":{…}}` or ABAP exception `{"exception":"KEY","message":"…"}` (HTTP 200) |
| `POST /rfc/logoff` | `{"sessionId"}` | `{}` — uncommitted work in the session is rolled back |
| `GET /stats` / `POST /stats/reset` | | logons + calls per `X-EIM-Txn` and per function |
| `POST /admin/reset` | | re-seed all data, clear sessions + stats |
| `GET /admin/pallets`, `GET /admin/documents` | | current pallet state, material documents, transfer orders |
| `GET /health` | | `{"status":"UP"}` |

Transport errors: invalid session → HTTP 401 `RFC_INVALID_HANDLE`; unknown FM → HTTP 404 `FU_NOT_FOUND`.
Structures are JSON objects, tables are arrays of objects, scalars are strings or numbers.

Changes made by `BAPI_GOODSMVT_CREATE`, `L_TO_CREATE_SINGLE`, `BAPI_HU_CREATE`,
`Z_EIM_ADD_CASE_TO_PALLET` and `Z_EIM_CLOSE_PALLET` are **staged in the RFC
session** and only applied by `BAPI_TRANSACTION_COMMIT` in the *same* session
(stateful context). Logoff without commit discards them.

### Function catalog

| Function | Imports / tables in | Exports / tables out | Errors |
|---|---|---|---|
| `BAPI_USER_GET_DETAIL` | `USERNAME` | `ADDRESS{FULLNAME}`, `LOGONDATA` | `RETURN` row TYPE `E` (01/124) |
| `Z_EIM_GET_PLANT_PARAMS` | `IV_WERKS`, `IV_DEVICE` | `ES_PLANT{WERKS,NAME1,LGNUM}`, table `ET_LGORT[{LGORT,LGOBE,LGTYP,STAGE_BIN}]` | exc `PLANT_NOT_FOUND` |
| `BAPI_MATERIAL_GET_DETAIL` | `MATERIAL`, `PLANT` | `MATERIAL_GENERAL_DATA{MATL_DESC,MATL_TYPE,BASE_UOM,NET_WEIGHT,STOR_CONDS}`, `RETURN` (structure) | `RETURN.TYPE=E` (M3/305) |
| `Z_EIM_GET_PALLET` | `IV_EXIDV` (18-digit SSCC) | `ES_HEADER{EXIDV,WERKS,LGNUM,LGORT,LGTYP,LGPLA,STATUS,CASE_COUNT,ERNAM,ERDAT}`, table `ET_ITEMS[{POSNR,MATNR,CHARG,VEMNG,VEMEH}]` | exc `INVALID_SSCC`, `NOT_FOUND` |
| `Z_EIM_VALIDATE_BIN` | `IV_LGNUM`, `IV_LGPLA`, `IV_PUTAWAY` (`X` = check blocked/full) | `ES_BIN{LGNUM,LGTYP,LTYPT,LGPLA,WERKS,LGORT,LGOBE,SKZUE,MAXLE,ANZLE}` | exc `BIN_NOT_FOUND`, `BIN_BLOCKED`, `BIN_FULL` |
| `BAPI_GOODSMVT_CREATE` | `GOODSMVT_HEADER{PSTNG_DATE,DOC_DATE,PR_UNAME}`, `GOODSMVT_CODE{GM_CODE:"04"}`, table `GOODSMVT_ITEM[{MATERIAL,PLANT,STGE_LOC,BATCH,MOVE_TYPE:"311",ENTRY_QNT,ENTRY_UOM,MOVE_STLOC}]` | `MATERIALDOCUMENT`, `MATDOCUMENTYEAR`, table `RETURN` | `RETURN` row TYPE `E` (M7/…) |
| `L_TO_CREATE_SINGLE` | `I_LGNUM`, `I_BWLVS:"999"`, `I_MATNR`, `I_WERKS`, `I_LGORT`, `I_CHARG`, `I_ANFME`, `I_ALTME`, `I_VLTYP`, `I_VLPLA`, `I_VLENR` (SSCC), `I_NLTYP`, `I_NLPLA`, `I_SQUIT:"X"` | `E_TANUM` | exc `SU_NOT_IN_SOURCE_BIN`, `SU_NOT_CLOSED`, `BIN_NOT_FOUND`, `WRONG_STORAGE_TYPE`, `BIN_BLOCKED`, `BIN_FULL`, `STOR_COND` |
| `BAPI_HU_CREATE` | `HEADERPROPOSAL{HU_EXID,PACK_MAT,PLANT,STGE_LOC}` | `HUKEY`, `HUHEADER`, table `RETURN` (new pallet is `OPEN` in the sloc's staging bin) | `RETURN` row TYPE `E` (HUGENERAL/05x) |
| `Z_EIM_ADD_CASE_TO_PALLET` | `IV_EXIDV`, `IV_CASE_BARCODE` | `ES_CASE{MATNR,MAKTX,CHARG,MENGE,MEINS}`, `EV_CASE_COUNT` | exc `PALLET_CLOSED`, `CASE_NOT_FOUND`, `CASE_ALREADY_PACKED`, `STOR_COND` |
| `Z_EIM_CLOSE_PALLET` | `IV_EXIDV` | `EV_CASE_COUNT` | exc `ALREADY_CLOSED`, `PALLET_EMPTY` |
| `Z_EIM_PRINT_PALLET_LABEL` | `IV_EXIDV`, `IV_PADEST` | `EV_SPOOLID`, `EV_PRINTER` | exc `NOT_FOUND` |
| `BAPI_TRANSACTION_COMMIT` | `WAIT:"X"` | `RETURN` | exc `BIN_FULL`, `SU_NOT_IN_SOURCE_BIN`, `HU_EXISTS`, `CASE_ALREADY_PACKED`, `PALLET_CLOSED`, `ALREADY_CLOSED` (staged checks re-run under the state lock; on failure all pending updates are discarded) |
| `BAPI_TRANSACTION_ROLLBACK` | | `RETURN` | — |

Storage-condition rule (enforced by the legacy app, from `STOR_CONDS`):
`FZ` → storage types 300 (freezer) or 910 (dock); `CH` → 200 (cooler) or 910; `RW` → 100 or 200.

## 3. Legacy app RFC call sequence (as built)

Every call below opens a **new** `RfcDestination` logon and closes it after the call,
except the bracketed posting LUWs, which run in one stateful context
(`RfcSessionManager.BeginContext` … `EndContext`) because the commit must be in
the same session. Nothing is cached between steps.

| Workflow / step | RFC sequence | Logons | Calls |
|---|---|---|---|
| Login/Logon | `BAPI_USER_GET_DETAIL`, `Z_EIM_GET_PLANT_PARAMS` | 2 | 2 |
| MoveInventory/ScanPallet | `Z_EIM_GET_PALLET`, `BAPI_MATERIAL_GET_DETAIL`, `Z_EIM_VALIDATE_BIN`(source) | 3 | 3 |
| MoveInventory/ScanDestBin | `Z_EIM_VALIDATE_BIN`(dest, putaway), `BAPI_MATERIAL_GET_DETAIL`, `Z_EIM_GET_PALLET` | 3 | 3 |
| MoveInventory/Confirm | `Z_EIM_GET_PALLET`, `Z_EIM_VALIDATE_BIN`(dest, putaway) | 2 | 2 |
| MoveInventory/Post | [`BAPI_GOODSMVT_CREATE` (only if sloc changes), `L_TO_CREATE_SINGLE`, `BAPI_TRANSACTION_COMMIT`], `Z_EIM_GET_PALLET`, `Z_EIM_VALIDATE_BIN`(dest) | 3 | 5 |
| BuildPallet/ScanPallet (existing OPEN pallet) | `Z_EIM_GET_PALLET` | 1 | 1 |
| BuildPallet/CreatePallet (label not in SAP) | `Z_EIM_GET_PALLET` (→`NOT_FOUND`), [`BAPI_HU_CREATE`, `BAPI_TRANSACTION_COMMIT`] | 2 | 3 |
| BuildPallet/ScanCase | [`Z_EIM_ADD_CASE_TO_PALLET`, `BAPI_TRANSACTION_COMMIT`], `Z_EIM_GET_PALLET` | 2 | 3 |
| BuildPallet/ClosePallet | [`Z_EIM_CLOSE_PALLET`, `BAPI_TRANSACTION_COMMIT`], `Z_EIM_GET_PALLET`, `Z_EIM_VALIDATE_BIN`, `Z_EIM_PRINT_PALLET_LABEL` | 4 | 5 |
| PalletInquiry/ScanPallet | `Z_EIM_GET_PALLET`, `Z_EIM_VALIDATE_BIN`, `BAPI_MATERIAL_GET_DETAIL` × each item line | 2 + lines | 2 + lines |

`timings.csv` (next to `EimRf.exe`, path overridable in `app.config`), one row per step:

```
timestamp,workflow,step,ms,logons,calls,result
2026-09-28T13:05:11.204,MoveInventory,ScanPallet,1512,3,3,OK
```

`result` is `OK` or `E:<exception or message id>`.

## 4. rdp-sim wire protocol (TCP, default port 3390)

Every message in both directions is framed as:

```
1 byte  type
4 bytes payload length (big-endian uint32)
N bytes payload
```

Server → client

| Type | Payload |
|---|---|
| `H` (0x48) | UTF-8 JSON hello, sent once on connect: `{"host":"EIMRF-VM01","width":480,"height":640,"fps":4}` |
| `F` (0x46) | One JPEG frame of the app's 480×640 client area |
| `P` (0x50) | Pong — echo of the client's ping payload |

Client → server

| Type | Payload |
|---|---|
| `I` (0x49) | UTF-8 input command, one of: `tap X,Y` (frame pixels), `text "…"` (JSON string literal), `key NAME` with NAME in `ENTER TAB BACKSPACE ESC UP DOWN F1…F12` |
| `P` (0x50) | Ping — 8-byte client timestamp (ms, big-endian); client computes RTT from the echo |

Behaviour:

- Frames are captured from the screen area of the app window on a capture thread
  (like a real RDP host capturing the desktop), so while the app's UI thread is
  blocked in a synchronous RFC call the handheld keeps seeing the last painted
  screen ("Please wait...").
- Input is queued and dispatched onto the WinForms UI thread (`BeginInvoke`); keystrokes
  sent while the app is busy are processed when the UI thread frees up.
- Every outbound message and every inbound input is delayed by
  `oneWayLatencyMs ± jitterMs`, preserving order.
- With `wifi.flaky=true` the host drops every connection roughly every
  `dropEverySec` and closes new connections for `reconnectDelaySec`. The client
  shows "Reconnecting…" and retries every second.

## 5. Keyboard contract (every screen is fully keyboard-driven)

| Screen | Keys |
|---|---|
| Login | User ID → ENTER → Plant → ENTER → Device ID (pre-filled from `app.config`) → ENTER logs on. F1 logs on from any field. |
| Main menu | `1` Move Inventory, `2` Build Pallet, `3` Pallet Inquiry, F3 Logoff |
| Move Inventory | Pallet SSCC + ENTER; Dest bin + ENTER; F1 Confirm; F4 Post (screen clears for the next pallet); F3 Back |
| Build Pallet | Pallet SSCC + ENTER (existing OPEN pallet continues; unknown label creates a new pallet in the selected sloc, default COOL); Case label + ENTER (repeat); F4 Close pallet; F3 Back |
| Pallet Inquiry | Pallet SSCC + ENTER; F3 Back |

## 6. Seed barcodes (fictional; GS1 example company prefix 0614141)

Pallets (SSCC, plant 1010 unless noted):

| SSCC | Location | Content |
|---|---|---|
| 006141411000000019 | COOL C-01-01 | 40 CS 10004512 CHKN BRST BNLS SKNLS 4X10LB |
| 006141411000000026 | COOL C-01-01 | 40 CS 10004533 CHKN THIGH BNLS SKNLS 40LB |
| 006141411000000033 | COOL C-01-02 | 24 CS 20001105 BEEF CHUCK ROLL + 12 CS 20001118 BEEF GRND 80/20 |
| 006141411000000040 | COOL C-01-03 | 36 CS 30002210 PORK LOIN BNLS |
| 006141411000000057 | COOL C-02-01 | 40 CS 10004512 |
| 006141411000000064 | FRZR F-01-01 | 48 CS 10004520 CHKN WING SEGMENTS IQF |
| 006141411000000071 | FRZR F-01-02 | 20 CS 20001126 BEEF BRISKET PKR FZN |
| 006141411000000088 | FRZR F-02-02 | 22 CS 30002237 PORK BELLY FZN (bin F-02-02 is full) |
| 006141411000000095 | FRZR F-02-01 | 60 CS 10004547 + 20 CS 10004520 |
| 006141411000000101 | RAW1 R-01-01 | 850 KG 90000014 CHKN WOG RAW BULK |
| 006141411000000118 | SHIP D-DOOR-01 | 40 CS 10004512 |
| 006141411000000125 | SHIP D-DOOR-02 | 48 CS 20001118 |
| 006141411000000132 | COOL C-STAGE | OPEN pallet, 6 CS 10004533 (Build Pallet continue) |
| 006141411000000149 | plant 1020 COOL C-01-01 | 30 CS 30002210 |
| 006141411000000156 | plant 1020 FRZR F-01-01 | 50 CS 10004547 |

Blank pallet labels (not in SAP → Build Pallet creates them):
`006141412000000016`, `006141412000000023`, `006141412000000030`, `006141412000000047`, `006141412000000054`

Bins (plant 1010, warehouse 101): `R-01-01 R-01-02 R-STAGE` (RAW1/100),
`C-01-01 C-01-02 C-01-03 C-02-01 C-02-02(blocked) C-STAGE` (COOL/200),
`F-01-01 F-01-02 F-02-01 F-02-02(full) F-STAGE` (FRZR/300),
`D-DOOR-01 D-DOOR-02 D-DOOR-03 D-STAGE` (SHIP/910).

Case labels (20 digits): `0` + material + `0` + first 5 of batch + 5-digit serial:
`01000451202626900001` … `01000451202626900008` (10004512 / 26269RB01),
`01000453302626900009` … `01000453302626900014` (10004533 / 26269RB02),
`02000111802626800015` … `02000111802626800020` (20001118 / 26268RB03).

Error barcodes: `006141411000000010` (bad check digit), `006141419999999999` (unknown), bin `C-09-09` (does not exist).
