using System.Net;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AxaCarQuote.Core;

/// <summary>Payload accepted by POST /api/axa/car-quote/error (same shape as the web and iOS clients).</summary>
public sealed record FailureReport
{
    [JsonPropertyName("source")] public string Source { get; init; } = FailureReporter.Source;
    [JsonPropertyName("service")] public string Service { get; init; } = FailureReporter.Service;
    [JsonPropertyName("platform")] public string Platform { get; init; } = "windows";
    [JsonPropertyName("appName")] public string AppName { get; init; } = "AXA Car Insurance";
    [JsonPropertyName("screen")] public string Screen { get; init; } = "Your quote";
    [JsonPropertyName("action")] public string Action { get; init; } = "getQuote";
    [JsonPropertyName("errorType")] public string ErrorType { get; init; } = "";
    [JsonPropertyName("errorMessage")] public string ErrorMessage { get; init; } = "";
    [JsonPropertyName("errorCode")] public string ErrorCode { get; init; } = "";
    [JsonPropertyName("stackTrace")] public string StackTrace { get; init; } = "";
    [JsonPropertyName("errorKind")] public string ErrorKind { get; init; } = "";
    [JsonPropertyName("registrationMasked")] public string RegistrationMasked { get; init; } = "";
    [JsonPropertyName("fuelType")] public string FuelType { get; init; } = "";
    [JsonPropertyName("coverType")] public string CoverType { get; init; } = "";
    [JsonPropertyName("channel")] public string Channel { get; init; } = "windows";
    [JsonPropertyName("ratingVersion")] public string RatingVersion { get; init; } = QuoteRating.RatingVersion;
    [JsonPropertyName("device")] public string Device { get; init; } = Environment.MachineName;
    [JsonPropertyName("osVersion")] public string OsVersion { get; init; } = RuntimeInformation.OSDescription;
    [JsonPropertyName("appVersion")] public string AppVersion { get; init; } = FailureReporter.AppVersion;
    [JsonPropertyName("release")] public string Release { get; init; } = $"axa-car-windows@{FailureReporter.AppVersion}";
    [JsonPropertyName("devinUserId")] public string DevinUserId { get; init; } = "";
    [JsonPropertyName("devinEmail")] public string DevinEmail { get; init; } = "";
    [JsonPropertyName("devinOrgId")] public string DevinOrgId { get; init; } = "";

    public static FailureReport From(QuoteRatingException error, DevinIdentity identity) => new()
    {
        ErrorType = QuoteRatingException.ErrorType,
        ErrorKind = QuoteRatingException.ErrorKind,
        ErrorMessage = error.Message,
        ErrorCode = QuoteRatingException.ErrorCode,
        StackTrace = error.StackTrace ?? "",
        RegistrationMasked = error.RegistrationMasked,
        FuelType = error.FuelType,
        CoverType = error.CoverType,
        DevinUserId = identity.UserId,
        DevinEmail = identity.Email,
        DevinOrgId = identity.OrgId,
    };
}

public sealed record DevinIdentity(string UserId, string Email, string OrgId)
{
    public static DevinIdentity FromEnvironment() => new(
        Environment.GetEnvironmentVariable("AXA_DEVIN_USER_ID") ?? "",
        Environment.GetEnvironmentVariable("AXA_DEVIN_EMAIL") ?? "",
        Environment.GetEnvironmentVariable("AXA_DEVIN_ORG_ID") ?? "");
}

public sealed record ReportResult(bool Sent, string? Reference, string Status);

/// <summary>
/// Posts platform failures to the event-driven-devin bridge. Every accepted report raises a real
/// Slack alert and Devin session, so local runs set AXA_DISABLE_FAILURE_REPORTS=1.
/// </summary>
public sealed class FailureReporter
{
    public const string Service = "customer-axa-uk";
    public const string Source = "axa-car/windows";
    public const string ReportPath = "/api/axa/car-quote/error";
    public const string AppVersion = "2026.11.0";
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
        var baseUrl = Environment.GetEnvironmentVariable("AXA_ALERT_BASE_URL");
        var disabled = Environment.GetEnvironmentVariable("AXA_DISABLE_FAILURE_REPORTS");
        return new FailureReporter(
            http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(10) },
            new Uri(string.IsNullOrWhiteSpace(baseUrl) ? DefaultBaseUrl : baseUrl),
            enabled: disabled is not ("1" or "true" or "TRUE"));
    }

    /// <summary>Sends one report per failed quote; repeats are never suppressed on the client.</summary>
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
