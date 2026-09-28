# RdpSim

RdpSim is a demo-only infrastructure simulation and is not part of the EIM RF application. In production, handhelds use real Microsoft RDP into the Windows VM.

The host streams framed JPEG screen images and accepts framed input over TCP. Frames contain a one-byte type, a four-byte big-endian payload length, and the payload; clients send `I` input commands and `P` pings, and the host sends `H` hello data, `F` frames, and `P` pong echoes. Input is dispatched to the WinForms UI thread. Configured latency, jitter, and Wi-Fi drops are read from the profile file.

The wire contract is documented in `../docs/INTERFACES.md` §4.
