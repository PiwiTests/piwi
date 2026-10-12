using System;
using System.Linq;
using System.Net;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Components.Endpoints;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;
using PiwiTests.Instrumentation.AspNetCore;
using Xunit;

namespace PiwiTests.Instrumentation.Tests;

public class ManifestTests
{
    private const string ThisFile = "PiwiTests.Instrumentation.Tests/ManifestTests.cs";
    private const string ControllersFile = "PiwiTests.Instrumentation.Tests/ManifestTestApp.cs";

    [Fact]
    public async Task Declares_minimal_api_routes_at_their_template_with_the_handler_file()
    {
        await using var app = await ManifestTestApp.StartAsync(e =>
        {
            e.MapGet("/api/items", () => "list");
            e.MapPost("/api/items", () => "created");
            e.MapGet("/api/items/{id:int}", (int id) => id);
            e.MapGet("/api/items/{id:guid}/notes", (Guid id) => id);
            e.MapMethods("/api/items/{id}", ["PUT", "PATCH"], (string id) => id);
            var orders = e.MapGroup("/api/v2").MapGroup("/orders");
            orders.MapGet("/", () => "orders");
            orders.MapDelete("/{orderId:long}", (long orderId) => orderId);
        });

        var manifest = await app.GetManifestAsync();

        Assert.Equal(
            [
                "DELETE /api/v2/orders/{orderId:long}",
                "GET /api/items",
                "GET /api/items/{id:guid}/notes",
                "GET /api/items/{id:int}",
                "GET /api/v2/orders",
                "PATCH /api/items/{id}",
                "POST /api/items",
                "PUT /api/items/{id}",
            ],
            manifest.RouteKeys);
        Assert.All(manifest.Routes, r => Assert.EndsWith(ThisFile, r.Handler));
        Assert.Empty(manifest.Pages);
    }

    [Fact]
    public async Task Marks_trailing_optional_and_default_parameters_optional_and_keeps_catch_alls()
    {
        await using var app = await ManifestTestApp.StartAsync(e =>
        {
            e.MapGet("/archive/{page?}", (int? page) => page);
            e.MapGet("/feed/{format=rss}", (string format) => format);
            e.MapGet("/files/{**path}", (string path) => path);
            e.MapGet("/download/{*path}", (string path) => path);
            e.MapGet("/assets/{name}.{ext}", (string name, string ext) => name);
            e.MapGet("/docs/{name}.{format?}", (string name, string? format) => name);
            e.MapGet("/ssn/{value:regex(^\\d{{3}}-\\d{{2}}$)}", (string value) => value);
        });

        var manifest = await app.GetManifestAsync();

        Assert.Equal(
            [
                "GET /archive/{page?}",
                "GET /assets/{name}.{ext}",
                "GET /docs/{name}.{format?}",
                "GET /download/{*path}",
                "GET /feed/{format?}",
                "GET /files/{**path}",
                "GET /ssn/{value:regex}",
            ],
            manifest.RouteKeys);
    }

    [Fact]
    public async Task Declares_an_any_method_endpoint_as_get_and_leaves_head_out_next_to_get()
    {
        await using var app = await ManifestTestApp.StartAsync(e =>
        {
            e.Map("/any", () => "any");
            e.MapMethods("/ping", ["GET", "HEAD"], () => "pong");
            e.MapMethods("/probe", ["HEAD"], () => "probe");
        });

        var manifest = await app.GetManifestAsync();

        Assert.Equal(["GET /any", "GET /ping", "HEAD /probe"], manifest.RouteKeys);
    }

    [Fact]
    public async Task Leaves_out_fallbacks_lone_catch_alls_and_endpoints_excluded_from_the_description()
    {
        await using var app = await ManifestTestApp.StartAsync(e =>
        {
            e.MapGet("/kept", () => "kept");
            e.MapGet("/internal", () => "internal").ExcludeFromDescription();
            e.MapGet("/{**slug}", (string slug) => slug);
            e.MapFallback(() => "spa");
            e.MapFallback("/app/{**rest}", () => "app");
            e.MapGet("/_framework/opaque-redirect", () => "framework");
        });

        var manifest = await app.GetManifestAsync();

        Assert.Equal(["GET /kept"], manifest.RouteKeys);
    }

    [Fact]
    public async Task Declares_a_hub_by_its_negotiate_endpoint_and_a_health_check_as_get()
    {
        await using var app = await ManifestTestApp.StartAsync(
            e =>
            {
                e.MapHub<ChatHub>("/hubs/chat");
                e.MapHealthChecks("/health");
            },
            services: s =>
            {
                s.AddSignalR();
                s.AddHealthChecks();
            });

        var manifest = await app.GetManifestAsync();

        Assert.Equal(["GET /health", "POST /hubs/chat/negotiate"], manifest.RouteKeys);
        Assert.Null(manifest.Route("GET", "/health").Handler);
        Assert.EndsWith(ControllersFile, manifest.Route("POST", "/hubs/chat/negotiate").Handler);
    }

    [Fact]
    public async Task Leaves_out_the_connection_endpoint_of_a_connection_handler()
    {
        await using var app = await ManifestTestApp.StartAsync(
            e => e.MapConnectionHandler<EchoConnectionHandler>("/echo"),
            services: s => s.AddConnections());

        var manifest = await app.GetManifestAsync();

        Assert.Equal(["POST /echo/negotiate"], manifest.RouteKeys);
    }

    [Fact]
    public async Task Declares_attribute_routed_actions_with_tokens_and_transformers_applied()
    {
        await using var app = await ManifestTestApp.StartAsync(e => e.MapControllers(), ManifestTestApp.AddTestControllers);

        var manifest = await app.GetManifestAsync();

        Assert.Equal(
            [
                "GET /api/order-items",
                "GET /api/order-items/export",
                "GET /api/order-items/recently-shipped",
                "GET /api/order-items/{id:int}",
                "POST /api/order-items",
                "PUT /api/order-items/{id:int}",
            ],
            manifest.RouteKeys);
        Assert.All(manifest.Routes, r => Assert.EndsWith(ControllersFile, r.Handler));
    }

    [Fact]
    public async Task Declares_each_conventional_action_once_at_the_url_link_generation_produces()
    {
        await using var app = await ManifestTestApp.StartAsync(
            e =>
            {
                e.MapAreaControllerRoute("admin", "Admin", "Admin/{controller=Dashboard}/{action=Index}/{id?}");
                e.MapControllerRoute("default", "{controller=Home}/{action=Index}/{id?}");
                e.MapControllerRoute("blog", "blog/{controller:slugify}/{action:slugify}");
            },
            ManifestTestApp.AddTestControllers);

        var manifest = await app.GetManifestAsync();

        Assert.Equal(
            [
                "GET /",
                "GET /Admin",
                "GET /Admin/Dashboard/Users/{id?}",
                "GET /BlogPosts/ShowAll/{id?}",
                "GET /Home/Privacy/{id?}",
                "POST /Home/Contact/{id?}",
            ],
            Conventional(manifest));
        Assert.All(manifest.Routes, r => Assert.EndsWith(ControllersFile, r.Handler));
    }

    [Fact]
    public async Task Keeps_the_area_segment_of_an_area_parameter_route()
    {
        await using var app = await ManifestTestApp.StartAsync(
            e => e.MapControllerRoute("areas", "{area:exists}/{controller=Home}/{action=Index}/{id?}"),
            ManifestTestApp.AddTestControllers);

        var manifest = await app.GetManifestAsync();

        Assert.Equal(["GET /Admin/Dashboard", "GET /Admin/Dashboard/Users/{id?}"], Conventional(manifest));
    }

    [Fact]
    public async Task Applies_the_outbound_transformer_to_conventional_route_values()
    {
        await using var app = await ManifestTestApp.StartAsync(
            e => e.MapControllerRoute("blog", "blog/{controller:slugify}/{action:slugify}"),
            ManifestTestApp.AddTestControllers);

        var manifest = await app.GetManifestAsync();

        Assert.Equal(
            [
                "GET /blog/blog-posts/show-all",
                "GET /blog/home/index",
                "GET /blog/home/privacy",
                "POST /blog/home/contact",
            ],
            Conventional(manifest));
    }

    [Fact]
    public async Task Lower_cases_literals_and_route_values_when_the_app_generates_lowercase_urls()
    {
        await using var app = await ManifestTestApp.StartAsync(
            e =>
            {
                e.MapControllerRoute("default", "{controller=Home}/{action=Index}/{id?}");
                e.MapGet("/Reports/{Year:int}", (int year) => year);
            },
            s =>
            {
                ManifestTestApp.AddTestControllers(s);
                s.Configure<RouteOptions>(o => o.LowercaseUrls = true);
            });

        var manifest = await app.GetManifestAsync();

        Assert.Equal(
            [
                "GET /",
                "GET /blogposts/showall/{id?}",
                "GET /home/privacy/{id?}",
                "GET /reports/{Year:int}",
                "POST /home/contact/{id?}",
            ],
            Conventional(manifest));
    }

    [Fact]
    public async Task Prefixes_the_request_path_base()
    {
        await using var app = await ManifestTestApp.StartAsync(
            e =>
            {
                e.MapGet("/", () => "home");
                e.MapGet("/api/items", () => "list");
            },
            outer: a => a.UsePathBase("/shop"));

        var manifest = await app.GetManifestAsync("/shop/__piwi/manifest");

        Assert.Equal(["GET /shop", "GET /shop/api/items"], manifest.RouteKeys);
    }

    [Fact]
    public async Task Is_not_served_outside_the_active_environments()
    {
        await using var app = await ManifestTestApp.StartAsync(e => e.MapGet("/api/items", () => "list"), environment: "Production");

        var response = await app.Client.GetAsync("/__piwi/manifest");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Writes_the_keys_the_reporter_reads_and_leaves_an_unknown_handler_out()
    {
        await using var app = await ManifestTestApp.StartAsync(
            e => e.MapHealthChecks("/health"),
            services: s => s.AddHealthChecks());

        var body = await app.Client.GetStringAsync("/__piwi/manifest");

        Assert.Equal("""{"routes":[{"method":"GET","pattern":"/health"}],"pages":[]}""", body);
    }

    [Fact]
    public void Declares_razor_pages_once_at_their_canonical_url()
    {
        // Razor Pages builds one descriptor per route of a page: an index page also matches at its
        // file name, with link generation suppressed.
        var endpoints = new Endpoint[]
        {
            Endpoint("Index", 0, Page("/Pages/Index.cshtml"), new LinkGenerationSuppressed()),
            Endpoint("", 0, Page("/Pages/Index.cshtml")),
            Endpoint("Orders/Index", 0, Page("/Pages/Orders/Index.cshtml"), new LinkGenerationSuppressed()),
            Endpoint("Orders", 0, Page("/Pages/Orders/Index.cshtml")),
            Endpoint("Orders/Details/{id:int}", 0, Page("/Pages/Orders/Details.cshtml")),
            Endpoint("Orders/Edit/{slug?}", 0, Page("/Pages/Orders/Edit.cshtml")),
            Endpoint("Admin/Settings", 0, Page("/Areas/Admin/Pages/Settings.cshtml")),
        };

        var manifest = PiwiRouteManifest.Build(endpoints, lowercaseUrls: false, policies: null, sources: null);

        Assert.Empty(manifest.Routes);
        Assert.Equal(
            [
                new ManifestPage("/", "Pages/Index.cshtml"),
                new ManifestPage("/Admin/Settings", "Areas/Admin/Pages/Settings.cshtml"),
                new ManifestPage("/Orders", "Pages/Orders/Index.cshtml"),
                new ManifestPage("/Orders/Details/{id:int}", "Pages/Orders/Details.cshtml"),
                new ManifestPage("/Orders/Edit/{slug?}", "Pages/Orders/Edit.cshtml"),
            ],
            manifest.Pages);
    }

    [Fact]
    public void Declares_routable_components_as_pages_named_by_their_source_file()
    {
        var endpoints = new Endpoint[]
        {
            Endpoint("/counter", 0, new ComponentTypeMetadata(typeof(CounterComponent)), new HttpMethodMetadata(["GET", "POST"])),
            Endpoint("/counter/{start:int}", 0, new ComponentTypeMetadata(typeof(CounterComponent))),
            Endpoint("/{*pageRoute}", 0, new ComponentTypeMetadata(typeof(CounterComponent))),
            Endpoint("/_blazor/negotiate", 0),
        };

        using var sources = new PiwiSourceFiles(AppContext.BaseDirectory);
        var manifest = PiwiRouteManifest.Build(endpoints, lowercaseUrls: false, policies: null, sources);

        Assert.Empty(manifest.Routes);
        Assert.Equal(["/counter", "/counter/{start:int}"], manifest.Pages.Select(p => p.Pattern));
        Assert.All(manifest.Pages, p => Assert.EndsWith(ControllersFile, p.Name));
    }

    [Fact]
    public void Leaves_out_link_generation_only_and_last_order_endpoints()
    {
        var endpoints = new Endpoint[]
        {
            Endpoint("/kept", 0),
            Endpoint("{controller}/{action}", 0, new MatchingSuppressed()),
            Endpoint("/last", int.MaxValue),
        };

        var manifest = PiwiRouteManifest.Build(endpoints, lowercaseUrls: false, policies: null, sources: null);

        Assert.Equal([new ManifestRoute("GET", "/kept", null)], manifest.Routes);
    }

    [Fact]
    public void Caps_routes_at_what_the_dashboard_accepts()
    {
        var endpoints = Enumerable.Range(0, PiwiRouteManifest.MaxEntries + 10)
            .Select(i => (Endpoint)Endpoint($"/r{i:D5}", 0))
            .ToList();

        var manifest = PiwiRouteManifest.Build(endpoints, lowercaseUrls: false, policies: null, sources: null);

        Assert.Equal(PiwiRouteManifest.MaxEntries, manifest.Routes.Count);
    }

    /// <summary>The route keys minus the attribute-routed controller, which every controller mapping also maps.</summary>
    private static string[] Conventional(WireManifest manifest) =>
        [.. manifest.RouteKeys.Where(k => !k.Contains("/api/order-items", StringComparison.Ordinal))];

    private static RouteEndpoint Endpoint(string template, int order, params object[] metadata) =>
        new(_ => Task.CompletedTask, RoutePatternFactory.Parse(template), order, new EndpointMetadataCollection(metadata), template);

    private static PageActionDescriptor Page(string relativePath) => new() { RelativePath = relativePath };

    private sealed class LinkGenerationSuppressed : ISuppressLinkGenerationMetadata
    {
        public bool SuppressLinkGeneration => true;
    }

    private sealed class MatchingSuppressed : ISuppressMatchingMetadata
    {
        public bool SuppressMatching => true;
    }
}
