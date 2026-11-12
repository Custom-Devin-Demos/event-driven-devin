using AxaCarQuote.Core;

namespace AxaCarQuote.Core.Tests;

public class QuoteRatingTests
{
    private static readonly Driver James = new("James", "Carter", "14/03/1986", "M20 2LS", "FULL_UK", 7);

    [Theory]
    [InlineData("MA21 PTR", CoverType.Comprehensive)]
    [InlineData("yd19dsl", CoverType.Tpft)]
    public void PetrolAndDieselCarsGetAQuote(string registration, CoverType cover)
    {
        var quote = QuoteRating.Calculate(registration, James, cover);
        Assert.True(quote.Annual > 0);
        Assert.Equal(quote.Annual + QuoteRating.PlusUplift, quote.Plus);
        Assert.Equal(cover, quote.Cover);
    }

    [Theory]
    [InlineData("")]
    [InlineData("ABC")]
    [InlineData("ZZ99 ZZZ")]
    public void BadRegistrationsAreValidationErrors(string registration)
    {
        Assert.Throws<QuoteValidationException>(() => QuoteRating.Calculate(registration, James, CoverType.Comprehensive));
    }

    [Fact]
    public void BadDriverDetailsAreValidationErrors()
    {
        Assert.Throws<QuoteValidationException>(() => QuoteRating.Calculate("MA21 PTR", James with { Postcode = "nope" }, CoverType.Comprehensive));
        Assert.Throws<QuoteValidationException>(() => QuoteRating.Calculate("MA21 PTR", James with { DateOfBirth = "1986-03-14" }, CoverType.Comprehensive));
        foreach (var dob in new[] { "31/02/1986", "14/13/1986", "00/03/1986", "14/03/2999" })
            Assert.Throws<QuoteValidationException>(() => QuoteRating.Calculate("LK24 EVX", James with { DateOfBirth = dob }, CoverType.Comprehensive));
    }

    [Fact]
    public void SeededElectricCarHasNoRatingFactor()
    {
        var error = Assert.Throws<QuoteRatingException>(() => QuoteRating.Calculate("LK24 EVX", James, CoverType.Comprehensive));
        Assert.Equal("No rating factor for fuel type ELECTRICITY (vehicle LK24 ***, cover COMPREHENSIVE)", error.Message);
        Assert.Equal("AXA-QTE-4221", QuoteRatingException.ErrorCode);
    }
}
