using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace PiwiTests.Instrumentation.CoverageFixture;

/// <summary>
/// The endpoints of the coverage fixture: method group handlers in their own files, and one inline handler
/// created here, when the application starts.
/// </summary>
public static class FixtureEndpoints
{
    public static void Map(IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/quote", Quotes.Quote);
        endpoints.MapGet("/squares", Squares.Handle);
        endpoints.MapGet("/report", Reports.HandleAsync);
        endpoints.MapGet("/check", Checks.Handle);
        endpoints.MapGet("/empty", Checks.Empty);
        endpoints.MapGet("/inline", (string name) =>
        {
            var greeting = Greetings.Text(name);
            var length = greeting.Length;
            return Results.Ok(new { greeting, length });
        });
    }
}
