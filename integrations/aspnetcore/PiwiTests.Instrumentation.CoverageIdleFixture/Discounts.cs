namespace PiwiTests.Instrumentation.CoverageIdleFixture;

public static class Discounts
{
    public static decimal Apply(decimal price, int percent)
    {
        if (percent <= 0)
        {
            return price;
        }

        return price - price * percent / 100;
    }
}
