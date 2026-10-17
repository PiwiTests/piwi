using Microsoft.Extensions.Logging.Abstractions;
using SampleApp.Services;
using Xunit;

namespace SampleApp.Tests;

public class InventoryServiceTests
{
    [Fact]
    public void Reports_the_stock_from_the_cached_prices_when_the_feed_fails()
    {
        var inventory = new InventoryService(new PriceFeed(), NullLogger<InventoryService>.Instance);

        var report = inventory.Report();

        Assert.Equal(3, report.Items);
        Assert.True(report.Cached);
    }
}
