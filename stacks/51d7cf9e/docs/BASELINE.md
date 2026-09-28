# Baseline timings — legacy path, `demo` profile

This is the **"before"** number. Measured on the real legacy path:

```
run-workflows.py ──rdp-sim TCP (60 ± 20 ms each way, 4 fps JPEG)──▶ EimRf.exe (WinForms, UI thread) ──RFC/HTTP──▶ sap-mock
```

`run-workflows.py` behaves like the handheld: it connects to rdp-sim, sends the same
`text`/`key` input the Android client sends, and waits for each step's row in the app's
`timings.csv`. SAP latency (`config/demo-profile.json`, `demo`): logon 350 ms,
call 150 ± 50 ms, plus per-FM processing time for posting FMs. The same SAP profile
is to be used for any later comparison.

- **App ms**: measured inside `EimRf.exe` from key press to screen updated (written to `timings.csv`, shown as `Last txn:` on screen).
- **Logons / calls**: counted by sap-mock per `X-EIM-Txn` (`GET /stats`).

## Windows VM (primary baseline)

Windows Server VM, .NET Framework 4.8, `start-demo.ps1 -Profile demo`, 3 full runs of
all three workflows, 33 rows, all `OK`. Raw data: [`baseline/windows-demo-runs.csv`](baseline/windows-demo-runs.csv),
[`baseline/windows-demo-stats.json`](baseline/windows-demo-stats.json).

| Workflow / step | Median ms | Min–max ms | SAP logons | SAP calls | RFC sequence |
|---|---:|---:|---:|---:|---|
| Login / Logon | 1,053 | 993–1,062 | 2 | 2 | `BAPI_USER_GET_DETAIL`, `Z_EIM_GET_PLANT_PARAMS` |
| Move Inventory / ScanPallet | 1,539 | 1,486–1,586 | 3 | 3 | `Z_EIM_GET_PALLET`, `BAPI_MATERIAL_GET_DETAIL`, `Z_EIM_VALIDATE_BIN` |
| Move Inventory / ScanDestBin | 1,533 | 1,494–1,536 | 3 | 3 | `Z_EIM_VALIDATE_BIN`, `BAPI_MATERIAL_GET_DETAIL`, `Z_EIM_GET_PALLET` |
| Move Inventory / Confirm (F1) | 1,051 | 1,009–1,116 | 2 | 2 | `Z_EIM_GET_PALLET`, `Z_EIM_VALIDATE_BIN` |
| Move Inventory / Post (F4) | 3,996 | 3,965–4,056 | 3 | 5 | [`BAPI_GOODSMVT_CREATE`, `L_TO_CREATE_SINGLE`, `BAPI_TRANSACTION_COMMIT`], `Z_EIM_GET_PALLET`, `Z_EIM_VALIDATE_BIN` |
| Build Pallet / CreatePallet | 2,347 | 2,328–2,349 | 2 | 3 | `Z_EIM_GET_PALLET`→`NOT_FOUND`, [`BAPI_HU_CREATE`, `BAPI_TRANSACTION_COMMIT`] |
| Build Pallet / ScanCase (×3 per run) | 2,127 | 2,010–2,197 | 2 | 3 | [`Z_EIM_ADD_CASE_TO_PALLET`, `BAPI_TRANSACTION_COMMIT`], `Z_EIM_GET_PALLET` |
| Build Pallet / ClosePallet (F4) | 3,915 | 3,901–3,991 | 4 | 5 | [`Z_EIM_CLOSE_PALLET`, `BAPI_TRANSACTION_COMMIT`], `Z_EIM_GET_PALLET`, `Z_EIM_VALIDATE_BIN`, `Z_EIM_PRINT_PALLET_LABEL` |
| Pallet Inquiry / ScanPallet (2 item lines) | 2,053 | 1,923–2,080 | 4 | 4 | `Z_EIM_GET_PALLET`, `Z_EIM_VALIDATE_BIN`, `BAPI_MATERIAL_GET_DETAIL` ×2 |

`[ … ]` = one stateful RFC context (the commit must be in the same session). Every other call opens a new logon.

### Per workflow

| Workflow | App time (sum of step medians) | Handheld-side wall time | SAP logons | SAP calls |
|---|---:|---:|---:|---:|
| Move Inventory (scan pallet → scan bin → confirm → post) | **8.1 s** | **8.5–8.8 s** (3 runs: 8,531 / 8,781 / 8,578 ms) | 11 | 13 |
| Build Pallet (new pallet, 3 cases, close) | 12.6 s | — | 12 | 17 |
| Pallet Inquiry (one pallet, 2 lines) | 2.1 s | — | 4 | 4 |
| Login | 1.1 s | — | 2 | 2 |

Remote-session link during these runs: ~133 frames per run, median ping RTT 125–132 ms.
Call counts were identical in all three runs and match `INTERFACES.md` §3.

Handheld-side wall time is measured by `run-workflows.py` over rdp-sim from the first scan
until the app writes the Post timing row, i.e. it includes the RDP input delay but not the
following frame reaching the handheld (up to one frame interval plus one-way latency more). It
excludes the worker's own think/scan time.

**Known counting quirk:** for Build Pallet / CreatePallet the first `Z_EIM_GET_PALLET` (which
returns `NOT_FOUND`) is tagged `BuildPallet/ScanPallet` in `/stats`, because the app only knows
the pallet is new after that call. The `timings.csv` row for CreatePallet counts it (2 logons / 3 calls);
workflow totals agree.

## Linux dev host, Mono 6.12 (cross-check)

The same `EimRf.exe` + `RdpSim.dll` build under Mono on Xvfb (`scripts/start-demo.sh`), 3 runs,
33 rows, all `OK`. Raw data: [`baseline/linux-mono-runs.csv`](baseline/linux-mono-runs.csv).
Within ~5% of Windows on every step; call counts identical.

| Step | Median ms |
|---|---:|
| Login | 946 |
| Move ScanPallet / ScanDestBin / Confirm / Post | 1,525 / 1,554 / 1,037 / 4,035 |
| Build CreatePallet / ScanCase / ClosePallet | 2,373 / 2,103 / 3,780 |
| Inquiry | 1,952 |
| Move Inventory handheld-side wall time | 8.5 s |

## Reproduce

```
# Windows:  .\scripts\start-demo.ps1 -Build
# Linux:    ./scripts/start-demo.sh
python scripts/run-workflows.py --csv-out run.csv --stats-out run-stats.json
curl http://localhost:8400/stats
```

## Verification

What was actually run, and where:

| Check | Where | Result |
|---|---|---|
| `dotnet build -c Release` of `legacy-windows` + `rdp-sim` | Windows VM (also VS2022 MSBuild) and Linux | 0 warnings, 0 errors |
| sap-mock build, Docker image, `/health` | Linux | OK |
| WinForms app on Windows with rdp-sim enabled, all three workflows through rdp-sim input, 3 scripted runs | Windows VM | All steps OK, numbers above |
| Error paths through rdp-sim: bad SSCC, blocked bin `C-02-02`, full bin `F-02-02`, storage-condition violation (chilled product → freezer `F-01-01`), adding to a closed pallet | Windows VM | Correct SAP errors shown, screenshots in `screenshots/` |
| SAP state really changes: material document + transfer order created, pallet 019 moved to `D-DOOR-03`, blank pallet 016 created, 3 cases added, closed | Windows VM (`/admin/documents`, `/admin/pallets`) | OK |
| Frames keep streaming while the UI thread is blocked ("Please wait..." frame captured mid-Post) | Windows VM | OK |
| Flaky Wi-Fi: 3 drop cycles, reconnects refused ~6 s, then new hello + frames | Windows VM (`flaky-wifi` profile) | OK |
| Same build under Mono with rdp-sim, 3 scripted runs | Linux | All steps OK |
| Android APK build (`./gradlew assembleDebug`) and client behaviour (frames, tap mapping, text/keys, RTT strip, Reconnecting overlay, SCAN list, settings) against a protocol test host | Android emulator, API 34 x86_64 | OK |
| Full handheld path, driven only through the phone UI (on-screen keyboard, SCAN list, F1/F3/F4 strip buttons): login, Move Inventory …019 → `D-DOOR-03`, Build Pallet …016 with 3 cases + close, Pallet Inquiry …033, invalid SSCC and blocked bin `C-02-02`, logoff. Emulator → rdp-sim `10.0.2.2:3390` → WinForms under Mono → sap-mock | Android emulator, API 34 x86_64, on Linux (the emulator host cannot reach the Windows VM) | All steps OK, RTT ~100–170 ms, per-step times within ~5% of the Windows medians; evidence in `baseline/android-e2e/` and `screenshots/android-*.png` |
