using Microsoft.AspNetCore.Http;

namespace PiwiTests.Instrumentation.CoverageFixture;

public static class Quotes
{
    public static IResult Quote(int quantity)
    {
        var prices = new PriceList(2.5m);
        var total = prices.Total(quantity);
        return Results.Ok(new { quantity, total });
    }
}
