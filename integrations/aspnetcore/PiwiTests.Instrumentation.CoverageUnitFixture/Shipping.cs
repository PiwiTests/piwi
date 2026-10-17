namespace PiwiTests.Instrumentation.CoverageUnitFixture;

public static class Shipping
{
    public static decimal Cost(decimal total)
    {
        if (total >= 50)
        {
            return 0;
        }

        return 4.90m;
    }
}
