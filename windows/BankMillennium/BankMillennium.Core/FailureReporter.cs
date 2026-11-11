using System.Net;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BankMillennium.Core;

/// <summary>Payload accepted by POST /api/bankmillennium/login/error (same shape as the web and iOS clients).</summary>
public sealed record FailureReport
{
    [JsonPropertyName("source")] public string Source { get; init; } = FailureReporter.Source;
    [JsonPropertyName("service")] public string Service { get; init; } = FailureReporter.Service;
    [JsonPropertyName("platform")] public string Platform { get; init; } = "windows";
    [JsonPropertyName("appName")] public string AppName { get; init; } = "Bank Millennium";
    [JsonPropertyName("screen")] public string Screen { get; init; } = "Login";
    [JsonPropertyName("action")] public string Action { get; init; } = "signIn";
    [JsonPropertyName("errorType")] public string ErrorType { get; init; } = "";
    [JsonPropertyName("errorMessage")] public string ErrorMessage { get; init; } = "";
    [JsonPropertyName("errorCode")] public string ErrorCode { get; init; } = "";
    [JsonPropertyName("stackTrace")] public string StackTrace { get; init; } = "";
    [JsonPropertyName("millekodMasked")] public string MillekodMasked { get; init; } = "";
    [JsonPropertyName("segment")] public string Segment { get; init; } = "";
    [JsonPropertyName("channel")] public string Channel { get; init; } = "windows";
    [JsonPropertyName("policyVersion")] public string PolicyVersion { get; init; } = SignInPolicies.PolicyVersion;
    [JsonPropertyName("device")] public string Device { get; init; } = Environment.MachineName;
    [JsonPropertyName("osVersion")] public string OsVersion { get; init; } = RuntimeInformation.OSDescription;
    [JsonPropertyName("appVersion")] public string AppVersion { get; init; } = FailureReporter.AppVersion;
    [JsonPropertyName("release")] public string Release { get; init; } = $"bank-millennium-windows@{FailureReporter.AppVersion}";
    [JsonPropertyName("devinUserId")] public string DevinUserId { get; init; } = "";
    [JsonPropertyName("devinEmail")] public string DevinEmail { get; init; } = "";
    [JsonPropertyName("devinOrgId")] public string DevinOrgId { get; init; } = "";

    public static FailureReport From(SignInPolicyException error, DevinIdentity identity) => new()
    {
        ErrorType = SignInPolicyException.ErrorType,
        ErrorMessage = error.Message,
        ErrorCode = SignInPolicyException.ErrorCode,
        StackTrace = error.StackTrace ?? "",
        MillekodMasked = error.MillekodMasked,
        Segment = error.Segment,
        Channel = error.Channel,
        DevinUserId = identity.UserId,
        DevinEmail = identity.Email,
        DevinOrgId = identity.OrgId,
    };
}

public sealed record DevinIdentity(string UserId, string Email, string OrgId)
{
    public static DevinIdentity FromEnvironment() => new(
        Environment.GetEnvironmentVariable("BM_DEVIN_USER_ID") ?? "",
        Environment.GetEnvironmentVariable("BM_DEVIN_EMAIL") ?? "",
        Environment.GetEnvironmentVariable("BM_DEVIN_ORG_ID") ?? "");
}

public sealed record ReportResult(bool Sent, string? Reference, string Status);

/// <summary>
/// Posts platform failures to the event-driven-devin bridge. Every accepted report raises a real
/// Slack alert and Devin session, so local runs set BM_DISABLE_FAILURE_REPORTS=1.
/// </summary>
public sealed class FailureReporter
{
    public const string Service = "customer-bank-millennium";
    public const string Source = "bank-millennium/windows";
    public const string ReportPath = "/api/bankmillennium/login/error";
    public const string AppVersion = "2026.4.2";
    public const string DefaultBaseUrl = "https://devindemos.com";

    private readonly HttpClient _http;

    public FailureReporter(HttpClient http, Uri baseUrl, bool enabled)
    {
        _http = http;
        BaseUrl = baseUrl;
        Enabled = enabled;
    }

    public Uri BaseUrl { get; }
    public bool Enabled { get; }

    public static FailureReporter FromEnvironment(HttpClient? http = null)
    {
        var baseUrl = Environment.GetEnvironmentVariable("BM_ALERT_BASE_URL");
        var disabled = Environment.GetEnvironmentVariable("BM_DISABLE_FAILURE_REPORTS");
        return new FailureReporter(
            http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(10) },
            new Uri(string.IsNullOrWhiteSpace(baseUrl) ? DefaultBaseUrl : baseUrl),
            enabled: disabled is not ("1" or "true" or "TRUE"));
    }

    /// <summary>Sends one report per failed sign-in; repeats are never suppressed on the client.</summary>
    public async Task<ReportResult> ReportAsync(FailureReport report, CancellationToken cancellationToken = default)
    {
        if (!Enabled) return new ReportResult(false, null, "disabled");
        try
        {
            using var response = await _http.PostAsJsonAsync(new Uri(BaseUrl, ReportPath), report, cancellationToken);
            if (response.StatusCode != HttpStatusCode.Accepted)
                return new ReportResult(false, null, $"http-{(int)response.StatusCode}");
            using var ack = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var reference = ack.RootElement.TryGetProperty("reference", out var r) ? r.GetString() : null;
            return new ReportResult(true, reference, "accepted");
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            return new ReportResult(false, null, "failed");
        }
    }
}
