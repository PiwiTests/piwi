using Xunit;

namespace PiwiTests.Instrumentation.CoverageUnitFixture;

public class ShippingTests
{
    [Fact]
    public void Ships_a_large_order_for_free() => Assert.Equal(0, Shipping.Cost(80));
}
