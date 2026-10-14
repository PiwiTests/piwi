namespace SampleApp.Services;

public sealed record Product(string Slug, string Name, decimal Price, string Description);

/// <summary>The products the shop sells.</summary>
public sealed class ProductCatalog
{
    private static readonly Product[] Products =
    [
        new("trail-shoes", "Trail shoes", 89m, "Light shoes with a grippy sole for muddy paths."),
        new("rain-jacket", "Rain jacket", 129m, "A packable jacket that keeps the rain out."),
        new("water-bottle", "Water bottle", 19m, "Half a litre, keeps water cool for hours."),
    ];

    public IReadOnlyList<Product> All() => Products;

    public Product? Find(string slug) => Array.Find(Products, product => product.Slug == slug);
}
