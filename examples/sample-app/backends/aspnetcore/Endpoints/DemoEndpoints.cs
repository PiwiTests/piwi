using Microsoft.AspNetCore.Http.HttpResults;
using SampleApp.Services;

namespace SampleApp.Endpoints;

/// <summary>
/// The API behind the demo pages. Each handler is a method, not a lambda, so a coverage build records it per test.
/// </summary>
public static class DemoEndpoints
{
    public static void MapDemoApi(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api");
        api.MapGet("/items", ListItems);
        api.MapPost("/submit", Submit);
        api.MapGet("/users/{id:int}", FindUser);
        api.MapGet("/slow", SlowAsync);
        api.MapGet("/report", Report);
        api.MapGet("/failing", Failing);
        api.MapGet("/child", Acknowledge);
        api.MapGet("/before-all-marker", Acknowledge);
    }

    public static Ok<IReadOnlyList<Item>> ListItems(InventoryService inventory) => TypedResults.Ok(inventory.Items());

    public static Results<Ok<OkBody>, BadRequest<ErrorBody>> Submit(ContactMessage message) =>
        string.IsNullOrWhiteSpace(message.Email)
            ? TypedResults.BadRequest(new ErrorBody("email is required"))
            : TypedResults.Ok(new OkBody(true));

    public static Ok<User> FindUser(int id, UserDirectory users) => TypedResults.Ok(users.Find(id));

    public static async Task<Ok<OkBody>> SlowAsync()
    {
        await Task.Delay(800);
        return TypedResults.Ok(new OkBody(true));
    }

    /// <summary>The stock report, which logs a warning and an error on its way.</summary>
    public static Ok<StockReport> Report(InventoryService inventory) => TypedResults.Ok(inventory.Report());

    /// <summary>An unhandled exception: the exception handler answers a 500 and logs the error.</summary>
    public static Ok<OkBody> Failing(InventoryService inventory)
    {
        inventory.Sync();
        return TypedResults.Ok(new OkBody(true));
    }

    public static Ok<OkBody> Acknowledge() => TypedResults.Ok(new OkBody(true));
}

public sealed record ContactMessage(string? Email, string? Message, string? Priority);

public sealed record OkBody(bool Ok);

public sealed record ErrorBody(string Error);
