using PibaPassport.Core;

namespace PibaPassport.Core.Tests;

public class FeeRulesTests
{
    private static readonly DateTime Winter = new(2026, 11, 12);
    private static readonly DateTime Summer = new(2026, 7, 1);

    [Fact]
    public void OnlineWinterRateRunsFromNovemberToFebruary()
    {
        Assert.Equal(FeeRate.OnlineWinter, FeeRules.OnlineRateFor(new DateTime(2026, 11, 1)));
        Assert.Equal(FeeRate.OnlineWinter, FeeRules.OnlineRateFor(new DateTime(2027, 2, 28)));
        Assert.Equal(FeeRate.OnlineSummer, FeeRules.OnlineRateFor(new DateTime(2026, 3, 1)));
    }

    [Fact]
    public void PublishedFeeForAnAdultRenewalIs185InWinterAnd290InSummer()
    {
        Assert.Equal(185, FeeRules.PublicFee(RequestReason.Renewal, AgeBand.Adult, Winter));
        Assert.Equal(290, FeeRules.PublicFee(RequestReason.Renewal, AgeBand.Adult, Summer));
    }

    [Fact]
    public void FirstPassportIsPricedFromThe2026Schedule()
    {
        var order = FeeRules.BuildPaymentOrder(new PassportRequest(DocumentType.Passport, RequestReason.First, AgeBand.Adult), Winter);
        Assert.Equal("PASSPORT_FIRST", order.ServiceCode);
        Assert.Equal(185, order.Amount);
        Assert.Equal(FeeRate.OnlineWinter, order.FeeRate);
    }

    [Fact]
    public void LostPassportIsPricedFromThe2026Schedule()
    {
        var order = FeeRules.BuildPaymentOrder(new PassportRequest(DocumentType.Passport, RequestReason.Lost, AgeBand.Minor), Summer);
        Assert.Equal("PASSPORT_LOST", order.ServiceCode);
        Assert.Equal(310, order.Amount);
    }

    [Fact]
    public void PlantedDefectRenewalHasNoFeeScheduleEntry()
    {
        var error = Assert.Throws<FeeScheduleException>(() =>
            FeeRules.BuildPaymentOrder(new PassportRequest(DocumentType.Passport, RequestReason.Renewal, AgeBand.Adult), Winter));
        Assert.Equal("PASSPORT_BIOMETRIC_RENEWAL", error.ServiceCode);
        Assert.Equal("No fee schedule entry for service PASSPORT_BIOMETRIC_RENEWAL (fee schedule 2026-01-01, adult, online-winter)", error.Message);
    }
}
