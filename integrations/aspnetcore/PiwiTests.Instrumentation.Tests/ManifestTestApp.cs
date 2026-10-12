using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationModels;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using PiwiTests.Instrumentation.AspNetCore;
using Xunit;

namespace PiwiTests.Instrumentation.Tests;

/// <summary>
/// An in-memory app on the Generic Host with endpoint routing, for reading the route manifest the
/// middleware serves at <c>/__piwi/manifest</c>. The caller registers the services and maps the
/// endpoints; the controllers and the hub below are the ones this assembly declares.
/// </summary>
internal sealed class ManifestTestApp : IAsyncDisposable
{
    private readonly IHost _host;

    private ManifestTestApp(IHost host)
    {
        _host = host;
        Client = host.GetTestClient();
    }

    public HttpClient Client { get; }

    public static async Task<ManifestTestApp> StartAsync(
        Action<IEndpointRouteBuilder> endpoints,
        Action<IServiceCollection>? services = null,
        string environment = "Development",
        Action<IApplicationBuilder>? outer = null)
    {
        var host = await new HostBuilder()
            .ConfigureWebHost(web => web
                .UseTestServer()
                .UseEnvironment(environment)
                .ConfigureServices(s =>
                {
                    s.AddRouting();
                    s.AddPiwiTestLogs();
                    services?.Invoke(s);
                })
                .Configure(app =>
                {
                    outer?.Invoke(app);
                    app.UsePiwiTestLogs();
                    app.UseRouting();
                    app.UseEndpoints(endpoints);
                }))
            .StartAsync();
        return new ManifestTestApp(host);
    }

    /// <summary>Registers this assembly's controllers, with the slugify transformer on attribute routes and as a route constraint.</summary>
    public static void AddTestControllers(IServiceCollection services)
    {
        services.Configure<RouteOptions>(o => o.ConstraintMap["slugify"] = typeof(SlugifyTransformer));
        services
            .AddControllers(o => o.Conventions.Add(new RouteTokenTransformerConvention(new SlugifyTransformer())))
            .AddApplicationPart(typeof(ManifestTestApp).Assembly);
    }

    /// <summary>Requests <paramref name="path"/> and reads the manifest body the reporter parses.</summary>
    public async Task<WireManifest> GetManifestAsync(string path = "/__piwi/manifest")
    {
        var response = await Client.GetAsync(path);
        response.EnsureSuccessStatusCode();
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return WireManifest.Read(json.RootElement);
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await _host.StopAsync();
        _host.Dispose();
    }
}

/// <summary>The manifest as the reporter reads it: camelCase keys, matched case-sensitively.</summary>
internal sealed record WireManifest(List<WireRoute> Routes, List<WirePage> Pages)
{
    public static WireManifest Read(JsonElement root) => new(
        [.. root.GetProperty("routes").EnumerateArray().Select(r => new WireRoute(
            r.GetProperty("method").GetString()!,
            r.GetProperty("pattern").GetString()!,
            r.TryGetProperty("handler", out var handler) ? handler.GetString() : null))],
        [.. root.GetProperty("pages").EnumerateArray().Select(p => new WirePage(
            p.GetProperty("pattern").GetString()!,
            p.TryGetProperty("name", out var name) ? name.GetString() : null))]);

    /// <summary>Every route as <c>METHOD /pattern</c>, in manifest order.</summary>
    public List<string> RouteKeys => [.. Routes.Select(r => $"{r.Method} {r.Pattern}")];

    public WireRoute Route(string method, string pattern) =>
        Assert.Single(Routes, r => r.Method == method && r.Pattern == pattern);
}

internal sealed record WireRoute(string Method, string Pattern, string? Handler);

internal sealed record WirePage(string Pattern, string? Name);

/// <summary>Turns <c>BlogPosts</c> into <c>blog-posts</c>, the usual outbound transformer for readable URLs.</summary>
public sealed class SlugifyTransformer : IOutboundParameterTransformer
{
    public string? TransformOutbound(object? value) =>
        value is null ? null : Regex.Replace(value.ToString()!, "([a-z])([A-Z])", "$1-$2").ToLowerInvariant();
}

public sealed class HomeController : ControllerBase
{
    public IActionResult Index() => Content("home");

    public IActionResult Privacy() => Content("privacy");

    [HttpPost]
    public IActionResult Contact() => Content("contact");
}

public sealed class BlogPostsController : ControllerBase
{
    public IActionResult ShowAll() => Content("posts");
}

[Area("Admin")]
public sealed class DashboardController : ControllerBase
{
    public IActionResult Index() => Content("dashboard");

    public IActionResult Users() => Content("users");
}

[ApiController]
[Route("api/[controller]")]
public sealed class OrderItemsController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok();

    [HttpGet("{id:int}")]
    public IActionResult Get(int id) => Ok(id);

    [HttpPost]
    [HttpPut("{id:int}")]
    public IActionResult Save() => Ok();

    [HttpGet("[action]")]
    public async Task<IActionResult> RecentlyShipped()
    {
        await Task.Yield();
        return Ok();
    }

    [Route("export")]
    public IActionResult Export() => Ok();
}

public sealed class ChatHub : Hub
{
    public Task Send(string message) => Clients.All.SendAsync("message", message);
}

/// <summary>Stands in for a routable Blazor component, since this project compiles no <c>.razor</c> file.</summary>
public sealed class CounterComponent : Microsoft.AspNetCore.Components.ComponentBase
{
    protected override void BuildRenderTree(Microsoft.AspNetCore.Components.Rendering.RenderTreeBuilder builder) => builder.AddContent(0, "count");
}

public sealed class EchoConnectionHandler : Microsoft.AspNetCore.Connections.ConnectionHandler
{
    public override Task OnConnectedAsync(Microsoft.AspNetCore.Connections.ConnectionContext connection) =>
        Task.CompletedTask;
}
