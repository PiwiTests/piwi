using System.Linq;
using Microsoft.AspNetCore.Http;

namespace PiwiTests.Instrumentation.CoverageFixture;

public static class Squares
{
    public static IResult Handle(int count)
    {
        var squares = Enumerable.Range(1, count)
            .Select(i =>
            {
                var square = i * i;
                return square;
            })
            .ToArray();
        return Results.Ok(squares);
    }
}
