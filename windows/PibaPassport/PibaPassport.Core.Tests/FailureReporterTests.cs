using System.Net;
using System.Text;
using System.Text.Json;
using PibaPassport.Core;

namespace PibaPassport.Core.Tests;

public class FailureReporterTests
{
    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<(Uri Uri, string Body)> Requests { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add((request.RequestUri!, await request.Content!.ReadAsStringAsync(cancellationToken)));
            return new HttpResponseMessage(HttpStatusCode.Accepted)
            {
                Content = new StringContent("{\"received\":true,\"reference\":\"ref-123\"}", Encoding.UTF8, "application/json"),
            };
        }
    }

    private static FailureReport RenewalReport()
    {
        var request = new PassportRequest(DocumentType.Passport, RequestReason.Renewal, AgeBand.Adult);
        var error = Assert.Throws<FeeScheduleException>(() => FeeRules.BuildPaymentOrder(request, new DateTime(2026, 11, 12)));
        return FailureReport.From(error, request, "tlv", "2026-11-12T09:40", new DevinIdentity("", "", ""));
    }

    [Fact]
    public async Task PostsTheSharedClientIdentityOnce()
    {
        var handler = new RecordingHandler();
        var reporter = new FailureReporter(new HttpClient(handler), new Uri("http://localhost:3100"), enabled: true);

        var first = await reporter.ReportAsync(RenewalReport());
        var second = await reporter.ReportAsync(RenewalReport());

        Assert.True(first.Sent);
        Assert.Equal("ref-123", first.Reference);
        Assert.Equal("duplicate", second.Status);
        var (uri, body) = Assert.Single(handler.Requests);
        Assert.Equal("http://localhost:3100/api/piba/passport/error", uri.ToString());
        using var json = JsonDocument.Parse(body);
        Assert.Equal("piba-passport/windows", json.RootElement.GetProperty("source").GetString());
        Assert.Equal("customer-piba-passport", json.RootElement.GetProperty("service").GetString());
        Assert.Equal("PIBA-FEE-4221", json.RootElement.GetProperty("errorCode").GetString());
        Assert.Equal("PASSPORT_BIOMETRIC_RENEWAL", json.RootElement.GetProperty("serviceCode").GetString());
        Assert.Equal("renewal", json.RootElement.GetProperty("requestReason").GetString());
        Assert.Equal("online-winter", json.RootElement.GetProperty("feeRate").GetString());
    }

    [Fact]
    public async Task SendsNothingWhenReportsAreDisabled()
    {
        var handler = new RecordingHandler();
        var reporter = new FailureReporter(new HttpClient(handler), new Uri(FailureReporter.DefaultBaseUrl), enabled: false);

        var result = await reporter.ReportAsync(RenewalReport());

        Assert.Equal("disabled", result.Status);
        Assert.Empty(handler.Requests);
    }
}
