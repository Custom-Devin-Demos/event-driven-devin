using System.Net;
using System.Text;
using System.Text.Json;
using BankMillennium.Core;

namespace BankMillennium.Core.Tests;

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

    private static FailureReport PolicyReport() =>
        FailureReport.From(new SignInPolicyException("MILLENNIUM_PRESTIGE", "4821****", "windows"), new DevinIdentity("", "", ""));

    [Fact]
    public async Task PostsTheBridgeContractForEveryFailure()
    {
        var handler = new RecordingHandler();
        var reporter = new FailureReporter(new HttpClient(handler), new Uri("http://localhost:3100"), enabled: true);

        var first = await reporter.ReportAsync(PolicyReport());
        var second = await reporter.ReportAsync(PolicyReport());

        Assert.True(first.Sent);
        Assert.Equal("ref-123", first.Reference);
        Assert.True(second.Sent);
        Assert.Equal(2, handler.Requests.Count);
        var (uri, body) = handler.Requests[0];
        Assert.Equal("http://localhost:3100/api/bankmillennium/login/error", uri.ToString());
        using var json = JsonDocument.Parse(body);
        var root = json.RootElement;
        Assert.Equal("bank-millennium/windows", root.GetProperty("source").GetString());
        Assert.Equal("customer-bank-millennium", root.GetProperty("service").GetString());
        Assert.Equal("MIL-AUTH-4031", root.GetProperty("errorCode").GetString());
        Assert.Equal("MILLENNIUM_PRESTIGE", root.GetProperty("segment").GetString());
        Assert.Equal("4821****", root.GetProperty("millekodMasked").GetString());
        Assert.Equal("2026-10", root.GetProperty("policyVersion").GetString());
        Assert.Equal("bank-millennium-windows@2026.4.2", root.GetProperty("release").GetString());
    }

    [Fact]
    public async Task DisabledReporterSendsNothing()
    {
        var handler = new RecordingHandler();
        var reporter = new FailureReporter(new HttpClient(handler), new Uri("http://localhost:3100"), enabled: false);

        var result = await reporter.ReportAsync(PolicyReport());

        Assert.Equal("disabled", result.Status);
        Assert.Empty(handler.Requests);
    }
}
