using Microsoft.AspNetCore.Http;

namespace PiwiTests.Instrumentation.CoverageFixture;

public static class Checks
{
    public static IResult Handle(int value)
    {
        if (value < 0)
        {
            return Results.BadRequest("negative");
        }

        return Results.Ok(value);
    }

    public static IResult Empty()
    {
        return Results.NoContent();
    }
}
