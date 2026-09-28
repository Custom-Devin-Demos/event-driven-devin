using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using SapMock;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss.fff "; });
var profile = LatencyProfile.Load(builder.Configuration["ProfileConfig"], Environment.GetEnvironmentVariable("EIMRF_PROFILE"));
var app = builder.Build();
var log = app.Logger;
log.LogInformation("Profile {Name}: logon {Logon}ms, call {Call}+/-{Jitter}ms", profile.Name, profile.LogonMs, profile.CallMs, profile.CallJitterMs);

var gate = new object();
var state = SapState.Create();
var sessions = new ConcurrentDictionary<string, Session>();
var stats = new Stats();

string Txn(HttpContext ctx) => ctx.Request.Headers["X-EIM-Txn"].FirstOrDefault() ?? "(untagged)";

app.MapGet("/health", () => Results.Ok(new { status = "UP", system = "ECC", client = "100", profile = profile.Name }));

app.MapPost("/rfc/logon", async (HttpContext ctx, JsonObject body) =>
{
    await Task.Delay(profile.LogonMs);
    var user = body["user"]?.GetValue<string>() ?? "";
    if (string.IsNullOrWhiteSpace(user))
        return Results.Json(new { exception = "RFC_LOGON_FAILURE", message = "Name or password is incorrect (repeat logon)" }, statusCode: 401);
    var s = new Session(Guid.NewGuid().ToString("N"), user.ToUpperInvariant(), DateTime.UtcNow);
    sessions[s.Id] = s;
    stats.Logon(Txn(ctx));
    return Results.Ok(new { sessionId = s.Id, sysid = "ECP", client = body["client"]?.GetValue<string>() ?? "100" });
});

app.MapPost("/rfc/logoff", (JsonObject body) =>
{
    var id = body["sessionId"]?.GetValue<string>() ?? "";
    if (sessions.TryRemove(id, out var s) && s.Pending.Count > 0)
        log.LogWarning("Session {Id} closed with {Count} uncommitted operation(s) - rolled back", id, s.Pending.Count);
    return Results.Ok(new { });
});

app.MapPost("/rfc/call", async (HttpContext ctx, JsonObject body) =>
{
    var fn = body["function"]?.GetValue<string>() ?? "";
    var id = body["sessionId"]?.GetValue<string>() ?? "";
    await Task.Delay(profile.CallDelay(fn));
    if (!sessions.TryGetValue(id, out var session))
        return Results.Json(new { exception = "RFC_INVALID_HANDLE", message = "Connection handle is invalid or closed" }, statusCode: 401);
    if (!Rfc.Handlers.ContainsKey(fn))
        return Results.Json(new { exception = "FU_NOT_FOUND", message = $"Function module {fn} not found" }, statusCode: 404);
    var imports = body["imports"] as JsonObject ?? new JsonObject();
    var tables = body["tables"] as JsonObject ?? new JsonObject();
    stats.Call(Txn(ctx), fn);
    RfcResult result;
    lock (gate)
    {
        try { result = Rfc.Handlers[fn](new RfcContext(state, session, imports, tables)); }
        catch (AbapException ex) { result = RfcResult.Exception(ex.Key, ex.Message); }
    }
    log.LogInformation("[{Txn}] {User} {Fn} -> {Outcome}", Txn(ctx), session.User, fn, result.ExceptionKey ?? "OK");
    return Results.Ok(result.ToJson());
});

app.MapGet("/stats", () => Results.Ok(stats.Snapshot()));
app.MapPost("/stats/reset", () => { stats.Reset(); return Results.Ok(new { }); });

app.MapPost("/admin/reset", () =>
{
    lock (gate) { state = SapState.Create(); }
    sessions.Clear();
    stats.Reset();
    return Results.Ok(new { reset = true });
});

app.MapGet("/admin/pallets", () =>
{
    lock (gate)
        return Results.Ok(state.Pallets.Values.Select(p => new { p.Exidv, p.Werks, p.Lgort, p.Lgpla, p.Status, items = p.Items.Select(i => new { i.Matnr, i.Charg, i.Qty, i.Uom }) }));
});

app.MapGet("/admin/documents", () =>
{
    lock (gate) return Results.Ok(new { materialDocuments = state.MaterialDocuments, transferOrders = state.TransferOrders });
});

app.Run();

public record Session(string Id, string User, DateTime Created)
{
    public List<Action> Pending { get; } = new();
    public List<Action> Checks { get; } = new();
}

public class Stats
{
    private readonly object _l = new();
    private Dictionary<string, (int logons, Dictionary<string, int> calls)> _byTxn = new();

    private (int logons, Dictionary<string, int> calls) Get(string txn) =>
        _byTxn.TryGetValue(txn, out var v) ? v : (_byTxn[txn] = (0, new Dictionary<string, int>()));

    public void Logon(string txn) { lock (_l) { var v = Get(txn); _byTxn[txn] = (v.logons + 1, v.calls); } }
    public void Call(string txn, string fn) { lock (_l) { var v = Get(txn); v.calls[fn] = v.calls.GetValueOrDefault(fn) + 1; } }
    public void Reset() { lock (_l) _byTxn = new(); }

    public object Snapshot()
    {
        lock (_l)
            return new
            {
                byTxn = _byTxn.ToDictionary(k => k.Key, k => new { logons = k.Value.logons, calls = k.Value.calls.Values.Sum(), functions = new Dictionary<string, int>(k.Value.calls) }),
                totals = new { logons = _byTxn.Values.Sum(v => v.logons), calls = _byTxn.Values.Sum(v => v.calls.Values.Sum()) }
            };
    }
}

public class LatencyProfile
{
    public string Name { get; init; } = "demo";
    public int LogonMs { get; init; } = 350;
    public int CallMs { get; init; } = 150;
    public int CallJitterMs { get; init; } = 50;
    public Dictionary<string, int> FunctionProcessingMs { get; init; } = new();

    public int CallDelay(string fn) =>
        Math.Max(0, CallMs + Random.Shared.Next(-CallJitterMs, CallJitterMs + 1) + FunctionProcessingMs.GetValueOrDefault(fn));

    public static LatencyProfile Load(string? path, string? profileOverride)
    {
        path ??= Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "config", "demo-profile.json");
        if (!File.Exists(path)) path = Path.Combine(Directory.GetCurrentDirectory(), "..", "config", "demo-profile.json");
        var root = JsonNode.Parse(File.ReadAllText(path))!;
        var name = string.IsNullOrWhiteSpace(profileOverride) ? root["activeProfile"]!.GetValue<string>() : profileOverride;
        var sap = root["profiles"]![name]?["sap"] ?? throw new InvalidOperationException($"Profile '{name}' not found in {path}");
        return new LatencyProfile
        {
            Name = name,
            LogonMs = sap["logonMs"]!.GetValue<int>(),
            CallMs = sap["callMs"]!.GetValue<int>(),
            CallJitterMs = sap["callJitterMs"]!.GetValue<int>(),
            FunctionProcessingMs = sap["functionProcessingMs"]?.Deserialize<Dictionary<string, int>>() ?? new()
        };
    }
}
