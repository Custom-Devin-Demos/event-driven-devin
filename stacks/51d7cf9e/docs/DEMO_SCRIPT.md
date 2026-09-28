# Live demo click path

Everything below is done **on the Android handheld** (emulator or device) running
the EIM RF client, connected to the Windows VM. Barcodes are "scanned" with the
**SCAN** button (pick the row from the list), typed values use **KBD**. All data
is fictional.

Reset SAP to the seed state before each run:

```
curl -X POST http://localhost:8400/admin/reset
```

## 0. Connect and log on

1. Open **EIM RF** on the handheld. Bottom strip shows `Connected to EIMRF-VM01 · RTT ~120 ms`.
   (Long-press the strip to change host/port; emulator default is `10.0.2.2:3390`.)
2. Login screen: User ID `RFOP01` → ENTER → Plant `1010` → ENTER → Device ID
   (pre-filled `RF-0417`) → ENTER. *(≈1–1.5 s "Please wait…")*
3. Main menu appears: `1 Move Inventory  2 Build Pallet  3 Pallet Inquiry`.

## 1. Move Inventory (the headline workflow)

| # | Action | What the audience sees |
|---|---|---|
| 1 | Press `1` | Move Inventory screen |
| 2 | SCAN pallet `006141411000000019` | ~1.5–2 s wait, then pallet, material, 40 CS, source COOL C-01-01 |
| 3 | SCAN dest bin `D-DOOR-03` | ~1.5–2 s wait, dest bin details and capacity |
| 4 | Press **F1** (Confirm) | ~1 s wait, `Confirmed - F4 to post` |
| 5 | Press **F4** (Post) | ~4–5 s wait, material document + transfer order number |
| 6 | Press **F3** | back to menu |

Watch `Last txn: X.Xs` in the status bar after every step.

## 2. Build Pallet

| # | Action | Result |
|---|---|---|
| 1 | Press `2` | Build Pallet screen, storage location `COOL - Cooler` |
| 2 | SCAN blank label `006141412000000016` | ~2 s, new OPEN pallet in COOL C-STAGE |
| 3 | SCAN case `01000451202626900001` | ~2 s, `1 CS` |
| 4 | SCAN case `01000451202626900002` | ~2 s, `2 CS` |
| 5 | SCAN case `01000451202626900003` | ~2 s, `3 CS` |
| 6 | Press **F4** (Close) | ~4 s, pallet CLOSED and label printed on `LBL1` |
| 7 | Press **F3** | back to menu |

To continue an existing open pallet instead, scan `006141411000000132` in step 2.

## 3. Pallet Inquiry

1. Press `3`, SCAN `006141411000000033` (two item lines) → ~2 s, header + both lines.
2. Press **F3** → menu.

## Error paths (optional, one or two)

| Scan | Where | Result |
|---|---|---|
| `C-02-02` | Move Inventory dest bin | `Storage bin C-02-02 is blocked for putaway` |
| `F-02-02` | Move Inventory dest bin | bin full |
| `006141411000000010` | any pallet field | invalid SSCC (bad check digit) |
| `006141419999999999` | Move Inventory / Inquiry | pallet not found |

## Flaky plant Wi-Fi mode

The host drops every handheld session and refuses reconnects for a few seconds;
the handheld shows **Reconnecting…** and the worker loses their place mid-scan.

Either start with the `flaky-wifi` profile (drop every ~25 s ±20%, 6 s reconnect
refusal, RDP one-way latency 90 ± 60 ms; SAP latency unchanged):

```
# Windows
.\scripts\start-demo.ps1 -Profile flaky-wifi
# Linux / Mono
EIMRF_PROFILE=flaky-wifi ./scripts/start-demo.sh
```

or keep the `demo` profile and set `"flaky": true` under `profiles.demo.wifi` in
`config/demo-profile.json` (drop every ~40 s, 5 s reconnect refusal), then restart `EimRf.exe`. Tune `dropEverySec` / `reconnectDelaySec` in the same place.

## Proof numbers on screen

```
curl http://localhost:8400/stats          # SAP logons + calls per workflow step
python scripts/run-workflows.py           # scripted run of all three workflows with per-step timings
```
