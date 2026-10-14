namespace SampleApp.Services;

/// <summary>An order as the checkout page sends it: the cart, one product slug per item, and where it goes.</summary>
public sealed record OrderRequest(IReadOnlyList<string>? Items, Shipping? Shipping);

public sealed record Shipping(string? Name, string? Address, string? City, string? Country);

public sealed record Order(int Id, string Shopper, string Name, string City, string Country, int Count, decimal Total, string Summary);

/// <summary>A placed order, or the problem that kept it from being placed.</summary>
public sealed record OrderResult(Order? Order, string? Problem);

/// <summary>Checks, prices and keeps the shop's orders, in memory.</summary>
public sealed class OrderService(ProductCatalog catalog, ILogger<OrderService> logger)
{
    private static readonly string[] Countries = ["France", "Germany", "Spain", "United Kingdom"];

    private readonly List<Order> _orders = [];
    private readonly Lock _lock = new();
    private int _lastId = 1000;

    public OrderResult Place(string shopper, OrderRequest request)
    {
        var products = new List<Product>();
        var problem = Check(request, products);
        if (problem is not null)
        {
            logger.LogWarning("demo: order rejected for {Shopper}: {Problem}", shopper, problem);
            return new OrderResult(null, problem);
        }

        var shipping = request.Shipping!;
        var city = shipping.City!.Trim();
        var total = products.Sum(product => product.Price);
        var summary = $"{products.Count} item(s) on their way to {city}, {shipping.Country}.";
        Order order;
        lock (_lock)
        {
            order = new Order(++_lastId, shopper, shipping.Name!.Trim(), city, shipping.Country!, products.Count, total, summary);
            _orders.Add(order);
        }

        logger.LogInformation("Order {Id} placed for {Shopper}: {Count} item(s), {Total}", order.Id, shopper, order.Count, total);
        return new OrderResult(order, null);
    }

    public IReadOnlyList<Order> For(string shopper)
    {
        lock (_lock)
            return _orders.Where(order => order.Shopper == shopper).Reverse().ToList();
    }

    /// <summary>Why the order cannot be placed, or null; fills <paramref name="products"/> with its items.</summary>
    private string? Check(OrderRequest request, List<Product> products)
    {
        if (request.Items is not { Count: > 0 } items)
            return "Your cart is empty.";

        foreach (var slug in items)
        {
            if (catalog.Find(slug) is not { } product)
                return $"The shop does not sell {slug}.";
            products.Add(product);
        }

        var shipping = request.Shipping;
        if (string.IsNullOrWhiteSpace(shipping?.Name) || string.IsNullOrWhiteSpace(shipping.Address) || string.IsNullOrWhiteSpace(shipping.City))
            return "Enter your name, address and city.";
        if (!Countries.Contains(shipping.Country))
            return $"The shop does not ship to {shipping.Country}.";

        return null;
    }
}
