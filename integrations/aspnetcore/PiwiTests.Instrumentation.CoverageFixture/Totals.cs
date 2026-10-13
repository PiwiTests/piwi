namespace PiwiTests.Instrumentation.CoverageFixture;

public static class Totals
{
    public static int Compute(int count)
    {
        var total = 0;
        for (var i = 1; i <= count; i++)
            total += i;
        return total;
    }
}
