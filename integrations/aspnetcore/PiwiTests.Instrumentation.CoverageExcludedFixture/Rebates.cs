using System.Diagnostics.CodeAnalysis;

[assembly: ExcludeFromCodeCoverage]

namespace PiwiTests.Instrumentation.CoverageExcludedFixture;

public static class Rebates
{
    public static decimal Apply(decimal price)
    {
        return price * 0.9m;
    }
}
