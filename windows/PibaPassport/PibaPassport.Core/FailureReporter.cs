using System.Net;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PibaPassport.Core;

/// <summary>Payload accepted by POST /api/piba/passport/error (same shape as the web and iOS clients).</summary>
public sealed record FailureReport
{
    [JsonPropertyName("source")] public string Source { get; init; } = FailureReporter.Source;
    [JsonPropertyName("service")] public string Service { get; init; } = FailureReporter.Service;
    [JsonPropertyName("platform")] public string Platform { get; init; } = "windows";
    [JsonPropertyName("appName")] public string AppName { get; init; } = "gov.il passport";
    [JsonPropertyName("screen")] public string Screen { get; init; } = "Payment";
    [JsonPropertyName("action")] public string Action { get; init; } = "payAndConfirm";
    [JsonPropertyName("errorType")] public string ErrorType { get; init; } = "";
    [JsonPropertyName("errorMessage")] public string ErrorMessage { get; init; } = "";
    [JsonPropertyName("errorCode")] public string ErrorCode { get; init; } = "";
    [JsonPropertyName("stackTrace")] public string StackTrace { get; init; } = "";
    [JsonPropertyName("serviceCode")] public string ServiceCode { get; init; } = "";
    [JsonPropertyName("documentType")] public string DocumentType { get; init; } = "passport";
    [JsonPropertyName("requestReason")] public string RequestReason { get; init; } = "";
    [JsonPropertyName("ageBand")] public string AgeBand { get; init; } = "";
    [JsonPropertyName("feeRate")] public string FeeRate { get; init; } = "";
    [JsonPropertyName("feeSchedule")] public string FeeSchedule { get; init; } = FeeRules.FeeScheduleVersion;
    [JsonPropertyName("branch")] public string Branch { get; init; } = "";
    [JsonPropertyName("appointment")] public string Appointment { get; init; } = "";
    [JsonPropertyName("device")] public string Device { get; init; } = Environment.MachineName;
    [JsonPropertyName("osVersion")] public string OsVersion { get; init; } = RuntimeInformation.OSDescription;
    [JsonPropertyName("appVersion")] public string AppVersion { get; init; } = FailureReporter.AppVersion;
    [JsonPropertyName("release")] public string Release { get; init; } = $"piba-passport-windows@{FailureReporter.AppVersion}";
    [JsonPropertyName("devinUserId")] public string DevinUserId { get; init; } = "";
    [JsonPropertyName("devinEmail")] public string DevinEmail { get; init; } = "";
    [JsonPropertyName("devinOrgId")] public string DevinOrgId { get; init; } = "";

    public static FailureReport From(FeeScheduleException error, PassportRequest request, string branchId, string appointment, DevinIdentity identity) => new()
    {
        ErrorType = FeeScheduleException.ErrorType,
        ErrorMessage = error.Message,
        ErrorCode = FeeScheduleException.ErrorCode,
        StackTrace = error.StackTrace ?? "",
        ServiceCode = error.ServiceCode,
        RequestReason = request.Reason.Wire(),
        AgeBand = request.AgeBand.Wire(),
        FeeRate = error.FeeRate.Wire(),
        Branch = branchId,
        Appointment = appointment,
        DevinUserId = identity.UserId,
        DevinEmail = identity.Email,
        DevinOrgId = identity.OrgId,
    };
}

public sealed record DevinIdentity(string UserId, string Email, string OrgId)
{
    public static DevinIdentity FromEnvironment() => new(
        Environment.GetEnvironmentVariable("PIBA_DEVIN_USER_ID") ?? "",
        Environment.GetEnvironmentVariable("PIBA_DEVIN_EMAIL") ?? "",
        Environment.GetEnvironmentVariable("PIBA_DEVIN_ORG_ID") ?? "");
}

public sealed record ReportResult(bool Sent, string? Reference, string Status);

/// <summary>
/// Posts platform failures to the event-driven-devin bridge. Every accepted report raises a real
/// Slack alert and Devin session, so local runs set PIBA_DISABLE_FAILURE_REPORTS=1.
/// </summary>
public sealed class FailureReporter
{
    public const string Service = "customer-piba-passport";
    public const string Source = "piba-passport/windows";
    public const string ReportPath = "/api/piba/passport/error";
    public const string AppVersion = "2026.1.4";
    public const string DefaultBaseUrl = "https://devindemos.com";

    private readonly HttpClient _http;
    private readonly HashSet<string> _sent = new();

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
        var baseUrl = Environment.GetEnvironmentVariable("PIBA_ALERT_BASE_URL");
        var disabled = Environment.GetEnvironmentVariable("PIBA_DISABLE_FAILURE_REPORTS");
        return new FailureReporter(
            http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(10) },
            new Uri(string.IsNullOrWhiteSpace(baseUrl) ? DefaultBaseUrl : baseUrl),
            enabled: disabled is not ("1" or "true" or "TRUE"));
    }

    /// <summary>Sends the report once per screen/action/code/service signature.</summary>
    public async Task<ReportResult> ReportAsync(FailureReport report, CancellationToken cancellationToken = default)
    {
        if (!Enabled) return new ReportResult(false, null, "disabled");
        var signature = $"{report.Screen}/{report.Action}/{report.ErrorCode}/{report.ServiceCode}";
        if (!_sent.Add(signature)) return new ReportResult(false, null, "duplicate");
        try
        {
            using var response = await _http.PostAsJsonAsync(new Uri(BaseUrl, ReportPath), report, cancellationToken);
            if (response.StatusCode != HttpStatusCode.Accepted)
            {
                _sent.Remove(signature);
                return new ReportResult(false, null, $"http-{(int)response.StatusCode}");
            }
            using var ack = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var reference = ack.RootElement.TryGetProperty("reference", out var r) ? r.GetString() : null;
            return new ReportResult(true, reference, "accepted");
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            _sent.Remove(signature);
            return new ReportResult(false, null, "failed");
        }
    }
}
