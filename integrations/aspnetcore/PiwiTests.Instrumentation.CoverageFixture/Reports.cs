using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace PiwiTests.Instrumentation.CoverageFixture;

public static class Reports
{
    public static async Task<IResult> HandleAsync()
    {
        await Task.Yield();
        var total = await Task.Run(() => Totals.Compute(10));
        await Task.Delay(1);
        return Results.Ok(new { total });
    }
}
