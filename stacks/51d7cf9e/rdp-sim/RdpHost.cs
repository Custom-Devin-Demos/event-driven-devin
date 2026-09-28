// Demo-only infrastructure simulation, not part of the EIM RF application.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace RdpSim
{
    public static class RdpHost
    {
        private sealed class ScreenTarget
        {
            public Form Form;
            public Rectangle Bounds;
        }

        private sealed class Message
        {
            public byte Type;
            public byte[] Payload;
            public long Due;
        }

        private sealed class ClientState
        {
            public readonly TcpClient Client;
            public readonly NetworkStream Stream;
            public readonly object QueueLock = new object();
            public readonly List<Message> Outbound = new List<Message>();
            public readonly AutoResetEvent QueueChanged = new AutoResetEvent(false);
            public readonly ManualResetEvent ClosedEvent = new ManualResetEvent(false);
            public long LastOutboundDue;
            public long LastInboundDue;
            public int Closed;

            public ClientState(TcpClient client)
            {
                Client = client;
                Stream = client.GetStream();
            }
        }

        private static readonly object RandomLock = new object();
        private static readonly object LogLock = new object();
        private static readonly object FrameLock = new object();
        private static readonly Random Random = new Random();
        private static readonly AutoResetEvent WifiWait = new AutoResetEvent(false);
        private static readonly List<ClientState> Clients = new List<ClientState>();
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();
        private static volatile ScreenTarget Target;
        private static Control MarshalControl;
        private static System.Windows.Forms.Timer PublishTimer;
        private static TcpListener Listener;
        private static Thread AcceptThread;
        private static Thread CaptureThread;
        private static Thread WifiThread;
        private static byte[] LastFrame;
        private static string LogPath;
        private static int OneWayMs;
        private static int JitterMs;
        private static int Fps = 4;
        private static long Quality = 55;
        private static bool Flaky;
        private static int DropEverySec = 40;
        private static int ReconnectDelaySec = 5;
        private static long RefuseUntilUtcTicks;
        private static bool Started;

        [DllImport("user32.dll")]
        private static extern void DisableProcessWindowsGhosting();

        public static void Start(int port, string profilePath)
        {
            if (Started) return;
            Started = true;
            try
            {
                if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                    DisableProcessWindowsGhosting();
            }
            catch { }

            ReadProfile(profilePath);
            LogPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "rdpsim.log");
            MarshalControl = new Control();
            MarshalControl.CreateControl();
            IntPtr handle = MarshalControl.Handle;
            PublishTimer = new System.Windows.Forms.Timer { Interval = 100 };
            PublishTimer.Tick += PublishTarget;
            PublishTimer.Start();
            Listener = new TcpListener(IPAddress.Any, port);
            Listener.Start();
            AcceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "RdpSim accept" };
            CaptureThread = new Thread(CaptureLoop) { IsBackground = true, Name = "RdpSim capture" };
            AcceptThread.Start();
            CaptureThread.Start();
            if (Flaky)
            {
                WifiThread = new Thread(WifiLoop) { IsBackground = true, Name = "RdpSim Wi-Fi" };
                WifiThread.Start();
            }
            Log("host started on port " + port);
        }

        private static void ReadProfile(string path)
        {
            var root = Serializer.DeserializeObject(File.ReadAllText(path)) as Dictionary<string, object>;
            if (root == null) throw new InvalidDataException("Profile configuration is invalid.");
            string profileName = Environment.GetEnvironmentVariable("EIMRF_PROFILE");
            if (string.IsNullOrWhiteSpace(profileName)) profileName = Convert.ToString(root["activeProfile"]);
            var profiles = root["profiles"] as Dictionary<string, object>;
            var profile = profiles == null ? null : profiles[profileName] as Dictionary<string, object>;
            if (profile == null) throw new InvalidDataException("Profile '" + profileName + "' was not found.");
            var rdp = profile["rdp"] as Dictionary<string, object>;
            var wifi = profile["wifi"] as Dictionary<string, object>;
            OneWayMs = Value(rdp, "oneWayLatencyMs", 60);
            JitterMs = Value(rdp, "jitterMs", 20);
            Fps = Math.Max(1, Value(rdp, "fps", 4));
            Quality = Math.Max(1, Math.Min(100, Value(rdp, "jpegQuality", 55)));
            Flaky = wifi != null && wifi.ContainsKey("flaky") && Convert.ToBoolean(wifi["flaky"]);
            DropEverySec = Value(wifi, "dropEverySec", 40);
            ReconnectDelaySec = Value(wifi, "reconnectDelaySec", 5);
        }

        private static int Value(Dictionary<string, object> data, string key, int fallback)
        {
            if (data == null || !data.ContainsKey(key)) return fallback;
            return Convert.ToInt32(data[key]);
        }

        private static void PublishTarget(object sender, EventArgs e)
        {
            Form form = Application.OpenForms.Cast<Form>().Where(item => item.Visible).LastOrDefault();
            if (form == null || form.IsDisposed) { Target = null; return; }
            try { Target = new ScreenTarget { Form = form, Bounds = form.RectangleToScreen(form.ClientRectangle) }; }
            catch { Target = null; }
        }

        private static void AcceptLoop()
        {
            while (true)
            {
                try
                {
                    TcpClient client = Listener.AcceptTcpClient();
                    if (DateTime.UtcNow.Ticks < Interlocked.Read(ref RefuseUntilUtcTicks))
                    {
                        Log("refuse " + client.Client.RemoteEndPoint);
                        client.Close();
                        continue;
                    }
                    var state = new ClientState(client);
                    lock (Clients) Clients.Add(state);
                    Log("connect " + client.Client.RemoteEndPoint);
                    Enqueue(state, (byte)'H', Encoding.UTF8.GetBytes("{\"host\":\"EIMRF-VM01\",\"width\":480,\"height\":640,\"fps\":" + Fps + "}"));
                    new Thread(() => SendLoop(state)) { IsBackground = true, Name = "RdpSim sender" }.Start();
                    new Thread(() => ReadLoop(state)) { IsBackground = true, Name = "RdpSim reader" }.Start();
                }
                catch (SocketException ex) { Log("listener " + ex.Message); }
                catch (ObjectDisposedException) { return; }
            }
        }

        private static void Enqueue(ClientState client, byte type, byte[] payload)
        {
            if (Volatile.Read(ref client.Closed) != 0) return;
            lock (client.QueueLock)
            {
                long now = StopwatchNow();
                long baseTime = Math.Max(now, client.LastOutboundDue);
                int delay = Delay();
                long due = baseTime + Milliseconds(delay);
                client.LastOutboundDue = due;
                if (type == (byte)'F')
                {
                    while (client.Outbound.Count(item => item.Type == (byte)'F') >= 3)
                    {
                        int stale = client.Outbound.FindIndex(item => item.Type == (byte)'F');
                        if (stale < 0) break;
                        client.Outbound.RemoveAt(stale);
                    }
                }
                client.Outbound.Add(new Message { Type = type, Payload = payload, Due = due });
            }
            client.QueueChanged.Set();
        }

        private static void SendLoop(ClientState client)
        {
            try
            {
                while (Volatile.Read(ref client.Closed) == 0)
                {
                    Message next = null;
                    int waitMs = Timeout.Infinite;
                    lock (client.QueueLock)
                    {
                        if (client.Outbound.Count > 0)
                        {
                            next = client.Outbound[0];
                            long remaining = next.Due - StopwatchNow();
                            if (remaining <= 0) client.Outbound.RemoveAt(0);
                            else { next = null; waitMs = (int)Math.Max(1, remaining * 1000 / System.Diagnostics.Stopwatch.Frequency); }
                        }
                    }
                    if (next == null)
                    {
                        client.QueueChanged.WaitOne(waitMs);
                        continue;
                    }
                    WriteFrame(client.Stream, next.Type, next.Payload);
                }
            }
            catch (Exception ex) { Log("send error " + ex.Message); }
            finally { CloseClient(client); }
        }

        private static void ReadLoop(ClientState client)
        {
            try
            {
                while (Volatile.Read(ref client.Closed) == 0)
                {
                    byte[] header = ReadExact(client.Stream, 5);
                    uint length = ReadUInt32(header, 1);
                    if (length > 1024 * 1024) throw new InvalidDataException("Input frame is too large.");
                    byte[] payload = ReadExact(client.Stream, (int)length);
                    long due = Math.Max(StopwatchNow(), client.LastInboundDue) + Milliseconds(Delay());
                    client.LastInboundDue = due;
                    if (!WaitUntil(client, due)) break;
                    if (header[0] == (byte)'P')
                        Enqueue(client, (byte)'P', payload);
                    else if (header[0] == (byte)'I')
                    {
                        string command = Encoding.UTF8.GetString(payload);
                        Log("input " + command);
                        DispatchInput(command);
                    }
                    else Log("input unknown frame " + header[0]);
                }
            }
            catch (Exception ex) { if (Volatile.Read(ref client.Closed) == 0) Log("read error " + ex.Message); }
            finally { CloseClient(client); }
        }

        private static bool WaitUntil(ClientState client, long due)
        {
            while (Volatile.Read(ref client.Closed) == 0)
            {
                long remaining = due - StopwatchNow();
                if (remaining <= 0) return true;
                int ms = (int)Math.Max(1, remaining * 1000 / System.Diagnostics.Stopwatch.Frequency);
                if (client.ClosedEvent.WaitOne(ms)) return false;
            }
            return false;
        }

        private static void DispatchInput(string command)
        {
            try
            {
                MarshalControl.BeginInvoke((MethodInvoker)delegate
                {
                    ScreenTarget target = Target;
                    if (target == null || target.Form == null || target.Form.IsDisposed) return;
                    try { DispatchOnUi(target.Form, command); }
                    catch (Exception ex) { Log("input dispatch error " + ex.GetBaseException().Message); }
                });
            }
            catch (Exception ex) { Log("input queue error " + ex.Message); }
        }

        private static void DispatchOnUi(Form form, string command)
        {
            if (command.StartsWith("text ", StringComparison.Ordinal))
            {
                string text = Serializer.Deserialize<string>(command.Substring(5));
                Control focused = FocusedControl(form);
                TextBoxBase textBox = focused as TextBoxBase;
                if (textBox != null)
                {
                    int available = textBox.MaxLength == 0 ? text.Length :
                        Math.Max(0, textBox.MaxLength - textBox.TextLength + textBox.SelectionLength);
                    textBox.SelectedText = text.Length > available ? text.Substring(0, available) : text;
                    return;
                }
                foreach (char character in text)
                {
                    var args = new KeyPressEventArgs(character);
                    if (form.KeyPreview) OnKeyPress.Invoke(form, new object[] { args });
                    if (!args.Handled && focused != form) OnKeyPress.Invoke(focused, new object[] { args });
                }
                return;
            }
            if (command.StartsWith("key ", StringComparison.Ordinal))
            {
                Keys key;
                if (!TryKey(command.Substring(4).Trim(), out key)) { Log("input malformed " + command); return; }
                Control focused = FocusedControl(form);
                var args = new KeyEventArgs(key);
                if (form.KeyPreview) OnKeyDown.Invoke(form, new object[] { args });
                if (!args.Handled && focused != form) OnKeyDown.Invoke(focused, new object[] { args });
                if (!args.Handled)
                {
                    if (key == Keys.Tab) form.SelectNextControl(focused, true, true, true, true);
                    else if (key == Keys.Back) DeletePrevious(focused as TextBoxBase);
                    else if (key == Keys.Enter)
                    {
                        IButtonControl button = focused as IButtonControl;
                        if (button != null) button.PerformClick();
                    }
                }
                return;
            }
            if (command.StartsWith("tap ", StringComparison.Ordinal))
            {
                string[] coordinates = command.Substring(4).Split(',');
                int x, y;
                if (coordinates.Length != 2 || !int.TryParse(coordinates[0], out x) || !int.TryParse(coordinates[1], out y))
                {
                    Log("input malformed " + command);
                    return;
                }
                Control control = ChildAt(form, new Point(x, y));
                if (control == null) return;
                control.Focus();
                IButtonControl button = control as IButtonControl;
                if (button != null) button.PerformClick();
                return;
            }
            Log("input unknown " + command);
        }

        private static Control FocusedControl(Control root)
        {
            Control current = root;
            while (current is ContainerControl && ((ContainerControl)current).ActiveControl != null)
                current = ((ContainerControl)current).ActiveControl;
            return current;
        }

        private static Control ChildAt(Control parent, Point point)
        {
            Control child = parent.GetChildAtPoint(point, GetChildAtPointSkip.Invisible | GetChildAtPointSkip.Disabled | GetChildAtPointSkip.Transparent);
            if (child == null) return parent;
            return ChildAt(child, new Point(point.X - child.Left, point.Y - child.Top));
        }

        private static void DeletePrevious(TextBoxBase textBox)
        {
            if (textBox == null) return;
            if (textBox.SelectionLength > 0) textBox.SelectedText = "";
            else if (textBox.SelectionStart > 0)
            {
                int start = textBox.SelectionStart - 1;
                textBox.Select(start, 1);
                textBox.SelectedText = "";
            }
        }

        private static bool TryKey(string name, out Keys key)
        {
            switch (name.ToUpperInvariant())
            {
                case "ENTER": key = Keys.Enter; return true;
                case "TAB": key = Keys.Tab; return true;
                case "BACKSPACE": key = Keys.Back; return true;
                case "ESC": key = Keys.Escape; return true;
                case "UP": key = Keys.Up; return true;
                case "DOWN": key = Keys.Down; return true;
                default: return Enum.TryParse(name, true, out key) && (key == Keys.F1 || key == Keys.F2 ||
                    key == Keys.F3 || key == Keys.F4 || key == Keys.F5 || key == Keys.F6 || key == Keys.F7 ||
                    key == Keys.F8 || key == Keys.F9 || key == Keys.F10 || key == Keys.F11 || key == Keys.F12);
            }
        }

        private static readonly MethodInfo OnKeyDown = typeof(Control).GetMethod("OnKeyDown", BindingFlags.NonPublic | BindingFlags.Instance);
        private static readonly MethodInfo OnKeyPress = typeof(Control).GetMethod("OnKeyPress", BindingFlags.NonPublic | BindingFlags.Instance);

        private static void CaptureLoop()
        {
            int interval = Math.Max(1, 1000 / Fps);
            var timer = new AutoResetEvent(false);
            while (true)
            {
                timer.WaitOne(interval);
                byte[] frame = null;
                ScreenTarget target = Target;
                if (target != null)
                {
                    try { frame = Capture(target); }
                    catch (Exception ex) { Log("capture error " + ex.Message); }
                }
                if (frame == null)
                {
                    lock (FrameLock) frame = LastFrame;
                }
                else lock (FrameLock) LastFrame = frame;
                if (frame == null) continue;
                ClientState[] clients;
                lock (Clients) clients = Clients.ToArray();
                foreach (ClientState client in clients) Enqueue(client, (byte)'F', frame);
            }
        }

        private static byte[] Capture(ScreenTarget target)
        {
            using (var bitmap = new Bitmap(480, 640))
            using (Graphics graphics = Graphics.FromImage(bitmap))
            using (var memory = new MemoryStream())
            {
                graphics.CopyFromScreen(target.Bounds.Location, Point.Empty, new Size(480, 640));
                ImageCodecInfo codec = ImageCodecInfo.GetImageEncoders().First(item => item.MimeType == "image/jpeg");
                using (var parameters = new EncoderParameters(1))
                {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, Quality);
                    bitmap.Save(memory, codec, parameters);
                }
                return memory.ToArray();
            }
        }

        private static void WifiLoop()
        {
            while (true)
            {
                int delay;
                lock (RandomLock) delay = (int)(DropEverySec * (0.8 + Random.NextDouble() * 0.4) * 1000);
                WifiWait.WaitOne(delay);
                Interlocked.Exchange(ref RefuseUntilUtcTicks, DateTime.UtcNow.AddSeconds(ReconnectDelaySec).Ticks);
                ClientState[] clients;
                lock (Clients) clients = Clients.ToArray();
                foreach (ClientState client in clients) CloseClient(client);
                Log("drop all sessions; refusing reconnects for " + ReconnectDelaySec + "s");
            }
        }

        private static void CloseClient(ClientState client)
        {
            if (Interlocked.Exchange(ref client.Closed, 1) != 0) return;
            client.ClosedEvent.Set();
            client.QueueChanged.Set();
            try { client.Client.Close(); } catch { }
            lock (Clients) Clients.Remove(client);
            Log("disconnect");
        }

        private static byte[] ReadExact(Stream stream, int length)
        {
            byte[] data = new byte[length];
            int offset = 0;
            while (offset < length)
            {
                int read = stream.Read(data, offset, length - offset);
                if (read == 0) throw new EndOfStreamException("Client closed the connection.");
                offset += read;
            }
            return data;
        }

        private static uint ReadUInt32(byte[] data, int offset)
        {
            return ((uint)data[offset] << 24) | ((uint)data[offset + 1] << 16) |
                ((uint)data[offset + 2] << 8) | data[offset + 3];
        }

        private static void WriteFrame(Stream stream, byte type, byte[] payload)
        {
            uint length = (uint)payload.Length;
            byte[] header = { type, (byte)(length >> 24), (byte)(length >> 16), (byte)(length >> 8), (byte)length };
            stream.Write(header, 0, header.Length);
            stream.Write(payload, 0, payload.Length);
            stream.Flush();
        }

        private static int Delay()
        {
            int jitter;
            lock (RandomLock) jitter = JitterMs == 0 ? 0 : Random.Next(-JitterMs, JitterMs + 1);
            return Math.Max(0, OneWayMs + jitter);
        }

        private static long Milliseconds(int milliseconds)
        {
            return (long)milliseconds * System.Diagnostics.Stopwatch.Frequency / 1000;
        }

        private static long StopwatchNow() { return System.Diagnostics.Stopwatch.GetTimestamp(); }

        private static void Log(string message)
        {
            if (LogPath == null) return;
            try
            {
                lock (LogLock)
                    File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss.fff") + " " + message + Environment.NewLine);
            }
            catch { }
        }
    }
}
