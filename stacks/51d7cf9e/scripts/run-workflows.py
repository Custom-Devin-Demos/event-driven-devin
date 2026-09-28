#!/usr/bin/env python3
import argparse
import csv
import http.client
import json
import pathlib
import socket
import statistics
import struct
import threading
import time
import urllib.error
import urllib.request


class RdpClient:
    def __init__(self, host, port):
        self.socket = socket.create_connection((host, port), timeout=15)
        self.socket.settimeout(None)
        self.lock = threading.Lock()
        self.frame_lock = threading.Lock()
        self.latest_frame = None
        self.frame_count = 0
        self.rtts = []
        self.hello = None
        self.closed = False
        self.reader = threading.Thread(target=self._read_loop, daemon=True)
        self.reader.start()
        self.pinger = threading.Thread(target=self._ping_loop, daemon=True)
        self.pinger.start()
        deadline = time.monotonic() + 15
        while self.hello is None and time.monotonic() < deadline:
            time.sleep(0.05)
        if self.hello is None:
            raise RuntimeError("Timed out waiting for RdpSim hello.")

    def send(self, kind, payload):
        message = kind + struct.pack(">I", len(payload)) + payload
        with self.lock:
            self.socket.sendall(message)

    def input(self, command):
        self.send(b"I", command.encode("utf-8"))

    def text(self, value):
        self.input("text " + json.dumps(value))

    def key(self, name):
        self.input("key " + name)

    def _read_exact(self, length):
        chunks = []
        remaining = length
        while remaining:
            data = self.socket.recv(remaining)
            if not data:
                raise ConnectionError("RdpSim closed the connection.")
            chunks.append(data)
            remaining -= len(data)
        return b"".join(chunks)

    def _read_loop(self):
        try:
            while not self.closed:
                kind = self._read_exact(1)
                length = struct.unpack(">I", self._read_exact(4))[0]
                payload = self._read_exact(length)
                if kind == b"H":
                    self.hello = json.loads(payload.decode("utf-8"))
                elif kind == b"F":
                    with self.frame_lock:
                        self.latest_frame = payload
                        self.frame_count += 1
                elif kind == b"P" and len(payload) == 8:
                    sent = struct.unpack(">Q", payload)[0]
                    rtt = time.monotonic() * 1000 - sent
                    self.rtts.append(rtt)
        except (OSError, ConnectionError):
            if not self.closed:
                self.closed = True

    def _ping_loop(self):
        while not self.closed:
            stamp = int(time.monotonic() * 1000)
            try:
                self.send(b"P", struct.pack(">Q", stamp))
            except OSError:
                self.closed = True
                return
            time.sleep(1)

    def save_frame(self, path):
        with self.frame_lock:
            frame = self.latest_frame
        if frame is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(frame)

    def close(self):
        self.closed = True
        try:
            self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.socket.close()


def http_json(url, method="GET"):
    request = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(request, timeout=15) as response:
        data = response.read()
        return json.loads(data.decode("utf-8")) if data else {}


def read_rows(path):
    if not path.exists():
        return []
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def wait_for_step(path, before_count, workflow, step):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        rows = read_rows(path)
        if len(rows) > before_count:
            row = rows[before_count]
            actual = (row.get("workflow"), row.get("step"))
            if actual != (workflow, step):
                raise RuntimeError("Expected %s/%s, got %s/%s" %
                                   (workflow, step, actual[0], actual[1]))
            return row
        time.sleep(0.05)
    raise TimeoutError("Timed out waiting for %s/%s timings.csv row." % (workflow, step))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3390)
    parser.add_argument("--sap", default="http://localhost:8400")
    default_timings = pathlib.Path(__file__).resolve().parent / ".." / "legacy-windows" / "bin" / "Release" / "net48" / "timings.csv"
    parser.add_argument("--timings", type=pathlib.Path, default=default_timings.resolve())
    parser.add_argument("--csv-out", type=pathlib.Path)
    parser.add_argument("--stats-out", type=pathlib.Path)
    parser.add_argument("--frames-dir", type=pathlib.Path)
    args = parser.parse_args()
    args.timings = args.timings.resolve()
    if args.frames_dir:
        args.frames_dir = args.frames_dir.resolve()
    http_json(args.sap.rstrip("/") + "/admin/reset", "POST")
    client = RdpClient(args.host, args.port)
    steps = []
    workflow_times = {}
    move_wall = None
    frame_number = 0
    try:
        for _ in range(3):
            client.key("F3")
            time.sleep(1.5)

        login_start = time.monotonic()
        client.text("RFOP01")
        client.key("ENTER")
        client.text("1010")
        client.key("ENTER")
        steps.append(run_step(client, args, frame_number, "Login", "Logon", lambda: client.key("ENTER")))
        frame_number += 1
        workflow_times["Login"] = [login_start, time.monotonic()]

        client.text("1")
        time.sleep(0.8)
        move_start = time.monotonic()
        client.text("006141411000000019")
        steps.append(run_step(client, args, frame_number, "MoveInventory", "ScanPallet", lambda: client.key("ENTER")))
        frame_number += 1
        client.text("D-DOOR-03")
        steps.append(run_step(client, args, frame_number, "MoveInventory", "ScanDestBin", lambda: client.key("ENTER")))
        frame_number += 1
        steps.append(run_step(client, args, frame_number, "MoveInventory", "Confirm", lambda: client.key("F1")))
        frame_number += 1
        steps.append(run_step(client, args, frame_number, "MoveInventory", "Post", lambda: client.key("F4")))
        frame_number += 1
        move_wall = time.monotonic() - move_start
        workflow_times["MoveInventory"] = [move_start, time.monotonic()]
        client.key("F3")
        time.sleep(0.8)

        client.text("2")
        time.sleep(0.8)
        build_start = time.monotonic()
        client.text("006141412000000016")
        steps.append(run_step(client, args, frame_number, "BuildPallet", "CreatePallet", lambda: client.key("ENTER")))
        frame_number += 1
        for barcode in ("01000451202626900001", "01000451202626900002", "01000451202626900003"):
            client.text(barcode)
            steps.append(run_step(client, args, frame_number, "BuildPallet", "ScanCase", lambda: client.key("ENTER")))
            frame_number += 1
        steps.append(run_step(client, args, frame_number, "BuildPallet", "ClosePallet", lambda: client.key("F4")))
        frame_number += 1
        workflow_times["BuildPallet"] = [build_start, time.monotonic()]
        client.key("F3")
        time.sleep(0.8)

        client.text("3")
        time.sleep(0.8)
        inquiry_start = time.monotonic()
        client.text("006141411000000033")
        steps.append(run_step(client, args, frame_number, "PalletInquiry", "ScanPallet", lambda: client.key("ENTER")))
        frame_number += 1
        workflow_times["PalletInquiry"] = [inquiry_start, time.monotonic()]
        client.key("F3")
        time.sleep(0.8)
        client.key("F3")
        time.sleep(0.8)
    finally:
        client.close()

    if args.csv_out:
        args.csv_out.parent.mkdir(parents=True, exist_ok=True)
        with args.csv_out.open("w", newline="", encoding="utf-8") as handle:
            fields = ("timestamp", "workflow", "step", "ms", "logons", "calls", "result")
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            writer.writerows({key: row[key] for key in fields} for row in steps)
    print_table(steps, workflow_times, move_wall, client)
    stats = http_json(args.sap.rstrip("/") + "/stats")
    if args.stats_out:
        args.stats_out.parent.mkdir(parents=True, exist_ok=True)
        args.stats_out.write_text(json.dumps(stats, indent=2), encoding="utf-8")
    print(json.dumps(stats, indent=2))
    failures = [row for row in steps if row.get("result") != "OK"]
    if failures:
        raise SystemExit("Workflow smoke failed: " + ", ".join(
            row["workflow"] + "/" + row["step"] + "=" + row["result"] for row in failures))


def run_step(client, args, number, workflow, step, send):
    before_count = len(read_rows(args.timings))
    if args.frames_dir:
        prefix = "%02d-%s-%s" % (number + 1, workflow, step)
        client.save_frame(args.frames_dir / (prefix + "-before.jpg"))
    started = time.monotonic()
    send()
    if args.frames_dir:
        time.sleep(1.2)
        client.save_frame(args.frames_dir / (prefix + "-during.jpg"))
    row = wait_for_step(args.timings, before_count, workflow, step)
    row["_client_ms"] = "%.0f" % ((time.monotonic() - started) * 1000)
    return row


def print_table(rows, workflow_times, move_wall, client):
    print("workflow          step             app ms  logons  calls  result  client wall ms")
    for row in rows:
        print("%-17s %-16s %6s %7s %6s %-7s %14s" % (
            row["workflow"], row["step"], row["ms"], row["logons"], row["calls"],
            row["result"], row["_client_ms"]))
    print("\nWorkflow totals:")
    for workflow in ("Login", "MoveInventory", "BuildPallet", "PalletInquiry"):
        selected = [row for row in rows if row["workflow"] == workflow]
        if not selected:
            continue
        wall = (workflow_times[workflow][1] - workflow_times[workflow][0]) * 1000
        print("%-17s app %5d ms  logons %d  calls %d  client wall %.0f ms" % (
            workflow, sum(int(row["ms"]) for row in selected),
            sum(int(row["logons"]) for row in selected), sum(int(row["calls"]) for row in selected), wall))
    print("Move Inventory wall time: %.0f ms" % (move_wall * 1000))
    median_rtt = statistics.median(client.rtts) if client.rtts else 0
    print("Frames received: %d  median RTT: %.0f ms" % (client.frame_count, median_rtt))


if __name__ == "__main__":
    main()
