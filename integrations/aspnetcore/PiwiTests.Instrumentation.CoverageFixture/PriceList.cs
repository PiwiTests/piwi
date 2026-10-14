namespace PiwiTests.Instrumentation.CoverageFixture;

public sealed class PriceList(decimal unitPrice)
{
    private readonly decimal _discount = 0.1m;

    public decimal Total(int quantity)
    {
        var gross = unitPrice * quantity;
        return gross - gross * _discount;
    }

    public decimal Refund(int quantity)
    {
        return -Total(quantity);
    }
}
