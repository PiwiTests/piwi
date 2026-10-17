using Microsoft.Extensions.Logging.Abstractions;
using SampleApp.Services;
using Xunit;

namespace SampleApp.Tests;

/// <summary>
/// The checks an order goes through. The end-to-end suite places a good order; these tests reach the refusals no
/// user path in it takes, so the combined coverage shows both kinds of line.
/// </summary>
public class OrderServiceTests
{
    private static readonly Shipping Home = new("Ada", "1 Main Street", "Paris", "France");

    private static OrderService Orders() => new(new ProductCatalog(), NullLogger<OrderService>.Instance);

    [Fact]
    public void Refuses_an_empty_cart()
    {
        var result = Orders().Place("ada@example.com", new OrderRequest([], Home));

        Assert.Null(result.Order);
        Assert.Equal("Your cart is empty.", result.Problem);
    }

    [Fact]
    public void Refuses_a_product_the_shop_does_not_sell()
    {
        var result = Orders().Place("ada@example.com", new OrderRequest(["umbrella"], Home));

        Assert.Equal("The shop does not sell umbrella.", result.Problem);
    }

    [Fact]
    public void Refuses_a_country_it_does_not_ship_to()
    {
        var result = Orders().Place("ada@example.com", new OrderRequest(["trail-shoes"], Home with { Country = "Peru" }));

        Assert.Equal("The shop does not ship to Peru.", result.Problem);
    }

    [Fact]
    public void Places_an_order_and_lists_it_for_its_shopper()
    {
        var orders = Orders();

        var result = orders.Place("ada@example.com", new OrderRequest(["trail-shoes", "water-bottle"], Home));

        Assert.Null(result.Problem);
        Assert.Equal(108m, result.Order!.Total);
        Assert.Equal([result.Order], orders.For("ada@example.com"));
        Assert.Empty(orders.For("bob@example.com"));
    }
}
