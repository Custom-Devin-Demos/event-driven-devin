#!/usr/bin/env bash
# Linux dev host: sap-mock (.NET 8) + EimRf.exe with RdpSim under Mono on a virtual display.
# Windows VM: use start-demo.ps1 instead.
set -euo pipefail

STACK="$(cd "$(dirname "$0")/.." && pwd)"
DOTNET="${DOTNET:-$(command -v dotnet || echo "$HOME/.dotnet/dotnet")}"
BIN="$STACK/legacy-windows/bin/Release/net48"
export EIMRF_PROFILE="${EIMRF_PROFILE:-demo}"

pkill -f "mono EimRf.exe" 2>/dev/null || true
pkill -f "SapMock" 2>/dev/null || true

"$DOTNET" build -c Release "$STACK/sap-mock/SapMock.csproj" -v q -nologo
"$DOTNET" build -c Release "$STACK/rdp-sim/RdpSim.csproj" -v q -nologo
"$DOTNET" build -c Release "$STACK/legacy-windows/EimRf.csproj" -v q -nologo

(cd "$STACK" && exec nohup "$DOTNET" sap-mock/bin/Release/net8.0/SapMock.dll --urls http://0.0.0.0:8400 \
    > "$STACK/sap-mock.log" 2>&1 < /dev/null) &
for _ in $(seq 60); do curl -sf localhost:8400/health >/dev/null && break; sleep 1; done
curl -sf localhost:8400/health >/dev/null || { echo "sap-mock not healthy, see $STACK/sap-mock.log"; exit 1; }

(cd "$BIN" && exec nohup xvfb-run -a -s "-screen 0 1024x768x24" mono EimRf.exe /rdpsim \
    > "$STACK/eimrf.log" 2>&1 < /dev/null) &
for _ in $(seq 30); do ss -ltn | grep -q ':3390 ' && break; sleep 1; done
ss -ltn | grep -q ':3390 ' || { echo "rdp-sim not listening, see $STACK/eimrf.log"; exit 1; }

echo "sap-mock: http://localhost:8400  (profile $EIMRF_PROFILE)"
echo "rdp-sim:  TCP 3390  (Android emulator: 10.0.2.2:3390)"
echo "timings:  $BIN/timings.csv"
