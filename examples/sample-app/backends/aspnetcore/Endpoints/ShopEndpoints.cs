using Microsoft.AspNetCore.Http.HttpResults;
using SampleApp.Services;

namespace SampleApp.Endpoints;

/// <summary>The shop's API: its products, and the orders of the shopper the <c>shop_user</c> cookie names.</summary>
public static class ShopEndpoints
{
    private const string ShopperCookie = "shop_user";

    public static void MapShopApi(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api");
        api.MapGet("/products", ListProducts);
        api.MapGet("/products/{slug}", FindProduct);
        api.MapPost("/orders", PlaceOrder);
        api.MapGet("/orders", ListOrders);
    }

    public static Ok<IReadOnlyList<Product>> ListProducts(ProductCatalog catalog) => TypedResults.Ok(catalog.All());

    public static Results<Ok<Product>, NotFound<ErrorBody>> FindProduct(string slug, ProductCatalog catalog) =>
        catalog.Find(slug) is { } product ? TypedResults.Ok(product) : TypedResults.NotFound(new ErrorBody("No such product"));

    public static Results<Created<Order>, BadRequest<ErrorBody>, JsonHttpResult<ErrorBody>> PlaceOrder(
        OrderRequest order, HttpRequest request, OrderService orders)
    {
        if (Shopper(request) is not { } shopper)
            return SignInFirst();

        var placed = orders.Place(shopper, order);
        return placed.Order is { } created
            ? TypedResults.Created((string?)null, created)
            : TypedResults.BadRequest(new ErrorBody(placed.Problem!));
    }

    public static Results<Ok<IReadOnlyList<Order>>, JsonHttpResult<ErrorBody>> ListOrders(HttpRequest request, OrderService orders) =>
        Shopper(request) is { } shopper ? TypedResults.Ok(orders.For(shopper)) : SignInFirst();

    /// <summary>The signed-in shopper: the shop's pages keep the email in a cookie.</summary>
    private static string? Shopper(HttpRequest request) =>
        request.Cookies.TryGetValue(ShopperCookie, out var value) && Uri.UnescapeDataString(value).Trim() is { Length: > 0 } email
            ? email
            : null;

    private static JsonHttpResult<ErrorBody> SignInFirst() =>
        TypedResults.Json(new ErrorBody("Sign in first."), statusCode: StatusCodes.Status401Unauthorized);
}
