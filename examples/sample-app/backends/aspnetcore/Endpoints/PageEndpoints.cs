using SampleApp.Services;

namespace SampleApp.Endpoints;

/// <summary>
/// The pages: each route serves its file of the shared <c>web/pages</c> folder. Every page is a route of its own, so
/// the route manifest declares them all.
/// </summary>
public static class PageEndpoints
{
    private static readonly (string Route, string File)[] Pages =
    [
        ("/", "index.html"),
        ("/form", "form.html"),
        ("/popup", "popup.html"),
        ("/child", "child.html"),
        ("/slow", "slow.html"),
        ("/backend", "backend.html"),
        ("/shop", "shop/index.html"),
        ("/shop/login", "shop/login.html"),
        ("/shop/cart", "shop/cart.html"),
        ("/shop/checkout", "shop/checkout.html"),
        ("/shop/done", "shop/done.html"),
        ("/shop/orders", "shop/orders.html"),
    ];

    public static void MapPages(this IEndpointRouteBuilder app)
    {
        foreach (var (route, file) in Pages)
            app.MapGet(route, (PageFiles pages) => pages.Serve(file));

        app.MapGet("/shop/products/{slug}", ProductPage);
    }

    /// <summary>The page of a product, or a 404 for a product the catalog does not have.</summary>
    public static IResult ProductPage(string slug, ProductCatalog catalog, PageFiles pages) =>
        catalog.Find(slug) is null ? Results.Text("No such product", statusCode: StatusCodes.Status404NotFound) : pages.Serve("shop/product.html");
}

/// <summary>The shared pages, read from <paramref name="root"/>.</summary>
public sealed class PageFiles(string root)
{
    public IResult Serve(string file) => TypedResults.PhysicalFile(Path.Combine(root, file), "text/html; charset=utf-8");
}
