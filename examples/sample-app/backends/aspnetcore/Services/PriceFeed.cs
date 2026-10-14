namespace SampleApp.Services;

/// <summary>The supplier's price feed. In the sample it never answers.</summary>
public sealed class PriceFeed
{
    public void Refresh() => throw new TimeoutException("demo: the price feed did not answer in time");
}
