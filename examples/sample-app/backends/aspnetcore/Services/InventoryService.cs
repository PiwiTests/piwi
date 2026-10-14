namespace SampleApp.Services;

public sealed record Item(string Name, int Stock);

public sealed record StockReport(int Items, bool Cached);

/// <summary>The stock of the demo items, and its report.</summary>
public sealed class InventoryService(PriceFeed prices, ILogger<InventoryService> logger)
{
    private const int LowStock = 5;

    private static readonly Item[] Stock = [new("Alpha", 2), new("Beta", 14), new("Gamma", 9)];

    public IReadOnlyList<Item> Items() => Stock;

    /// <summary>
    /// Counts the items, warning about each one running low, and falls back to the cached prices when the price feed
    /// fails: one Warning and one Error with its exception, both on the response's X-Piwi-Logs header.
    /// </summary>
    public StockReport Report()
    {
        foreach (var item in Stock)
        {
            if (item.Stock < LowStock)
                logger.LogWarning("demo: low stock for item {Item}", item.Name);
        }

        var cached = false;
        try
        {
            prices.Refresh();
        }
        catch (TimeoutException exception)
        {
            logger.LogError(exception, "demo: price sync failed, using cached prices");
            cached = true;
        }

        return new StockReport(Stock.Length, cached);
    }

    /// <summary>Synchronizes the stock with the inventory backend, which always fails.</summary>
    public void Sync() => throw new InvalidOperationException("demo: inventory backend exploded");
}
