using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Components.Endpoints;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace PiwiTests.Instrumentation.AspNetCore;

/// <summary>A declared route: its method, path pattern and the source file of its handler.</summary>
internal sealed record ManifestRoute(string Method, string Pattern, string? Handler);

/// <summary>A declared page: its path pattern and the file that renders it.</summary>
internal sealed record ManifestPage(string Pattern, string? Name);

/// <summary>The body served at <c>/__piwi/manifest</c>.</summary>
internal sealed record RouteManifest(IReadOnlyList<ManifestRoute> Routes, IReadOnlyList<ManifestPage> Pages);

/// <summary>
/// The declared-surface manifest the middleware serves at <c>/__piwi/manifest</c>, built from the
/// app's endpoint table: minimal APIs, controllers (attribute and conventional routing, areas),
/// Razor Pages, Blazor pages, SignalR hubs and health checks. The Piwi reporter fetches it once at
/// run start and uploads it, and a declared route or page no test reaches becomes a "declared,
/// never hit" gap.
/// </summary>
/// <remarks>
/// Each endpoint is declared at its canonical URL, the one link generation produces: conventional
/// route values are substituted (through their outbound parameter transformers), trailing optional
/// and default-valued segments are dropped, and literals are lower-cased when
/// <see cref="RouteOptions.LowercaseUrls"/> is set. Parameters keep the template syntax, e.g.
/// <c>/api/orders/{id:int}</c>, which the dashboard folds to <c>:id</c> (<c>:uuid</c> for a
/// <c>guid</c> constraint). An endpoint that accepts any method is declared as <c>GET</c>, the
/// method a navigation uses, and <c>HEAD</c> is left out next to <c>GET</c>.
/// </remarks>
internal static class PiwiRouteManifest
{
    internal const string Path = "/__piwi/manifest";

    private const string NegotiateSuffix = "/negotiate";

    /// <summary>The most routes, and the most pages, the dashboard accepts in one upload.</summary>
    internal const int MaxEntries = 5000;

    /// <summary>Path segments the framework serves its own files and connections under.</summary>
    private static readonly HashSet<string> FrameworkSegments = new(StringComparer.OrdinalIgnoreCase)
    {
        "_framework", "_blazor", "_content",
    };

    internal static bool IsRequest(HttpRequest request) =>
        (HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method)) &&
        request.Path.Equals(Path, StringComparison.OrdinalIgnoreCase);

    internal static async Task WriteAsync(HttpContext context)
    {
        var services = context.RequestServices;
        RouteManifest manifest;
        using (var sources = new PiwiSourceFiles(services.GetService<IHostEnvironment>()?.ContentRootPath))
        {
            manifest = Build(
                services.GetService<EndpointDataSource>()?.Endpoints ?? [],
                services.GetService<IOptions<RouteOptions>>()?.Value.LowercaseUrls ?? false,
                services.GetService<ParameterPolicyFactory>(),
                sources,
                context.Request.PathBase);
        }

        context.Response.StatusCode = StatusCodes.Status200OK;
        context.Response.ContentType = "application/json";
        await context.Response.Body.WriteAsync(Serialize(manifest));
    }

    /// <summary>Builds the manifest from <paramref name="endpoints"/>, routes and pages sorted for stable output.</summary>
    internal static RouteManifest Build(
        IReadOnlyList<Endpoint> endpoints,
        bool lowercaseUrls,
        ParameterPolicyFactory? policies,
        PiwiSourceFiles? sources,
        PathString pathBase = default)
    {
        var routes = new Dictionary<string, ManifestRoute>(StringComparer.Ordinal);
        var pages = new Dictionary<string, ManifestPage>(StringComparer.Ordinal);

        // A connection endpoint (a SignalR hub, a connection handler) sits next to its negotiate
        // endpoint, and clients reach it over a WebSocket, which the reporter does not record.
        var connections = endpoints.OfType<RouteEndpoint>()
            .Where(e => e.Metadata.GetMetadata<NegotiateMetadata>() is not null)
            .Select(e => CanonicalPath(e.RoutePattern, lowercaseUrls: false, policies: null))
            .Where(p => p.EndsWith(NegotiateSuffix, StringComparison.OrdinalIgnoreCase))
            .Select(p => p.Length > NegotiateSuffix.Length ? p[..^NegotiateSuffix.Length] : "/")
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        bool IsConnection(RouteEndpoint e) =>
            e.Metadata.GetMetadata<NegotiateMetadata>() is null &&
            connections.Contains(CanonicalPath(e.RoutePattern, lowercaseUrls: false, policies: null));

        foreach (var endpoint in Canonical(endpoints.OfType<RouteEndpoint>().Where(e => IsDeclared(e) && !IsConnection(e))))
        {
            var path = CanonicalPath(endpoint.RoutePattern, lowercaseUrls, policies);
            if (pathBase.HasValue)
                path = path == "/" ? pathBase.Value! : pathBase.Value + path;

            if (IsPage(endpoint, sources, out var name))
            {
                pages.TryAdd(path, new ManifestPage(path, name));
                continue;
            }

            var handler = sources is null ? null : HandlerFile(endpoint, sources);
            foreach (var method in DeclaredMethods(endpoint))
            {
                var key = $"{method} {path}";
                if (!routes.TryGetValue(key, out var existing))
                    routes[key] = new ManifestRoute(method, path, handler);
                else if (existing.Handler is null && handler is not null)
                    routes[key] = existing with { Handler = handler };
            }
        }

        return new RouteManifest(
            routes.OrderBy(r => r.Key, StringComparer.Ordinal).Select(r => r.Value).Take(MaxEntries).ToList(),
            pages.Values.OrderBy(p => p.Pattern, StringComparer.Ordinal).Take(MaxEntries).ToList());
    }

    /// <summary>
    /// False for endpoints that are not part of the app's own surface: link-generation-only
    /// endpoints, fallbacks (every <c>MapFallback*</c> registers at the last order) and routes that
    /// are a lone catch-all, static files, endpoints excluded from the API description (the OpenAPI
    /// document itself), and the framework's own paths.
    /// </summary>
    private static bool IsDeclared(RouteEndpoint endpoint)
    {
        var metadata = endpoint.Metadata;
        if (metadata.GetMetadata<ISuppressMatchingMetadata>()?.SuppressMatching == true)
            return false;
        if (endpoint.Order == int.MaxValue)
            return false;
        if (metadata.GetMetadata<IExcludeFromDescriptionMetadata>()?.ExcludeFromDescription == true)
            return false;
#if NET9_0_OR_GREATER
        if (metadata.GetMetadata<Microsoft.AspNetCore.StaticAssets.StaticAssetDescriptor>() is not null)
            return false;
#endif

        var segments = endpoint.RoutePattern.PathSegments;
        if (segments.Count > 0 && segments[0].IsSimple)
        {
            var first = segments[0].Parts[0];
            if (first is RoutePatternLiteralPart literal && FrameworkSegments.Contains(literal.Content))
                return false;
            if (segments.Count == 1 && first is RoutePatternParameterPart { IsCatchAll: true })
                return false;
        }

        return true;
    }

    /// <summary>
    /// Keeps one URL per MVC action or Razor Page. An index page also matches at its file name
    /// (<c>/Orders/Index</c>, with link generation suppressed) and a conventionally routed action
    /// matches every conventional route that fits it, so within one action (or one page) the
    /// endpoints that generate links are kept, or else those of the first conventional route by order.
    /// </summary>
    private static IEnumerable<RouteEndpoint> Canonical(IEnumerable<RouteEndpoint> endpoints)
    {
        var byAction = new Dictionary<string, List<RouteEndpoint>>(StringComparer.Ordinal);
        foreach (var endpoint in endpoints)
        {
            if (endpoint.Metadata.GetMetadata<ActionDescriptor>() is not { } action)
            {
                yield return endpoint;
                continue;
            }

            // Razor Pages builds one descriptor per route of a page, so a page groups by its file.
            var key = action is PageActionDescriptor page ? $"page:{page.RelativePath}" : action.Id;
            if (!byAction.TryGetValue(key, out var group))
                byAction[key] = group = [];
            group.Add(endpoint);
        }

        foreach (var group in byAction.Values)
        {
            var linked = group
                .Where(e => e.Metadata.GetMetadata<ISuppressLinkGenerationMetadata>()?.SuppressLinkGeneration != true)
                .ToList();
            if (linked.Count > 0)
            {
                foreach (var endpoint in linked)
                    yield return endpoint;
                continue;
            }

            var first = group.Min(e => e.Order);
            foreach (var endpoint in group.Where(e => e.Order == first))
                yield return endpoint;
        }
    }

    /// <summary>
    /// The URL an endpoint is declared at: required route values substituted and parameters
    /// rendered as <c>{name:constraint}</c>. Trailing optional and default-valued parameters stay,
    /// marked optional (<c>/archive/{page?}</c>), unless a conventional route value before them
    /// equals its default: link generation then leaves them all out (<c>/</c> for <c>Home/Index</c>).
    /// </summary>
    internal static string CanonicalPath(RoutePattern pattern, bool lowercaseUrls, ParameterPolicyFactory? policies)
    {
        string Literal(string text) => lowercaseUrls ? text.ToLowerInvariant() : text;

        // Each segment's text, whether it is a route value a URL may leave out, and its text as an
        // optional parameter when it is one a URL may leave out.
        var segments = new List<(string Text, bool DefaultValue, string? Optional)>();
        foreach (var segment in pattern.PathSegments)
        {
            if (segment.IsSimple && segment.Parts[0] is RoutePatternParameterPart parameter)
            {
                if (RequiredValue(pattern, parameter) is { } value)
                {
                    var isDefault = pattern.Defaults.TryGetValue(parameter.Name, out var fallback) &&
                        string.Equals(Convert.ToString(fallback), value, StringComparison.OrdinalIgnoreCase);
                    segments.Add((Literal(Transform(pattern, parameter, value, policies)), isDefault, null));
                }
                else
                {
                    var optional = !parameter.IsCatchAll &&
                        (parameter.IsOptional || pattern.Defaults.ContainsKey(parameter.Name));
                    segments.Add((
                        Placeholder(pattern, parameter, optional: false),
                        false,
                        optional ? Placeholder(pattern, parameter, optional: true) : null));
                }

                continue;
            }

            var text = new StringBuilder();
            foreach (var part in segment.Parts)
            {
                text.Append(part switch
                {
                    RoutePatternLiteralPart literal => Literal(literal.Content),
                    RoutePatternSeparatorPart separator => Literal(separator.Content),
                    RoutePatternParameterPart p when RequiredValue(pattern, p) is { } value =>
                        Literal(Transform(pattern, p, value, policies)),
                    RoutePatternParameterPart p => Placeholder(pattern, p, p.IsOptional),
                    _ => "",
                });
            }

            segments.Add((text.ToString(), false, null));
        }

        var omittable = segments.Count;
        while (omittable > 0 && (segments[omittable - 1].DefaultValue || segments[omittable - 1].Optional is not null))
            omittable--;

        var path = segments.Select((s, i) => i >= omittable ? s.Optional ?? s.Text : s.Text);
        if (segments.Skip(omittable).Any(s => s.DefaultValue))
            path = path.Take(omittable);

        return "/" + string.Join("/", path);
    }

    /// <summary>The value a conventional route requires for <paramref name="parameter"/>, e.g. <c>controller=Home</c>.</summary>
    private static string? RequiredValue(RoutePattern pattern, RoutePatternParameterPart parameter) =>
        pattern.RequiredValues.TryGetValue(parameter.Name, out var value) &&
        value is not null &&
        !ReferenceEquals(value, RoutePattern.RequiredValueAny) &&
        Convert.ToString(value) is { Length: > 0 } text
            ? text
            : null;

    /// <summary>Applies the parameter's outbound transformer (e.g. a slugify convention) to a required value.</summary>
    private static string Transform(
        RoutePattern pattern, RoutePatternParameterPart parameter, string value, ParameterPolicyFactory? policies)
    {
        if (!pattern.ParameterPolicies.TryGetValue(parameter.Name, out var references))
            return value;

        foreach (var reference in references)
        {
            try
            {
                var policy = reference.ParameterPolicy ?? policies?.Create(parameter, reference);
                if (policy is IOutboundParameterTransformer transformer)
                    value = transformer.TransformOutbound(value) ?? value;
            }
            catch (InvalidOperationException)
            {
                // A constraint name the app never registered: it cannot be a transformer.
            }
        }

        return value;
    }

    /// <summary>
    /// A parameter in template syntax, constraint names kept and their arguments dropped:
    /// <c>{id:int}</c>, <c>{**path}</c>, or <c>{page?}</c> when a URL may leave it out.
    /// </summary>
    private static string Placeholder(RoutePattern pattern, RoutePatternParameterPart parameter, bool optional)
    {
        var text = new StringBuilder("{");
        if (parameter.IsCatchAll)
            text.Append(parameter.EncodeSlashes ? "*" : "**");
        text.Append(parameter.Name);
        if (pattern.ParameterPolicies.TryGetValue(parameter.Name, out var references))
        {
            foreach (var reference in references)
            {
                if (string.IsNullOrEmpty(reference.Content))
                    continue;
                var open = reference.Content.IndexOf('(');
                text.Append(':').Append(open < 0 ? reference.Content : reference.Content[..open]);
            }
        }

        return text.Append(optional ? "?}" : "}").ToString();
    }

    /// <summary>
    /// The methods a route is declared under. An endpoint that accepts any method is declared as
    /// <c>GET</c>, except a SignalR negotiate endpoint, which clients <c>POST</c> to.
    /// </summary>
    private static IEnumerable<string> DeclaredMethods(Endpoint endpoint)
    {
        var methods = endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods;
        if (methods is null || methods.Count == 0)
            return [endpoint.Metadata.GetMetadata<NegotiateMetadata>() is null ? HttpMethods.Get : HttpMethods.Post];

        var upper = methods.Select(m => m.ToUpperInvariant()).Distinct().ToList();
        if (upper.Contains(HttpMethods.Get))
            upper.Remove(HttpMethods.Head);
        return upper;
    }

    /// <summary>True for a Razor Page or a routable Blazor component, named by the file that renders it.</summary>
    private static bool IsPage(Endpoint endpoint, PiwiSourceFiles? sources, out string? name)
    {
        if (endpoint.Metadata.GetMetadata<PageActionDescriptor>() is { } page)
        {
            name = page.RelativePath.TrimStart('/');
            return true;
        }

        if (endpoint.Metadata.GetMetadata<ComponentTypeMetadata>() is { } component)
        {
            name = sources?.TypeFile(component.Type) ?? component.Type.FullName;
            return true;
        }

        name = null;
        return false;
    }

    /// <summary>The source file of the controller action, minimal API delegate or SignalR hub behind a route.</summary>
    private static string? HandlerFile(Endpoint endpoint, PiwiSourceFiles sources)
    {
        var method = endpoint.Metadata.GetMetadata<ControllerActionDescriptor>()?.MethodInfo
            ?? endpoint.Metadata.GetMetadata<MethodInfo>();
        if (method is not null)
            return sources.MethodFile(method);

        return endpoint.Metadata.GetMetadata<HubMetadata>() is { } hub ? sources.TypeFile(hub.HubType) : null;
    }

    /// <summary>Serializes the manifest to the <c>{ "routes": [...], "pages": [...] }</c> JSON the reporter reads.</summary>
    internal static byte[] Serialize(RouteManifest manifest)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteStartArray("routes");
            foreach (var route in manifest.Routes)
            {
                writer.WriteStartObject();
                writer.WriteString("method", route.Method);
                writer.WriteString("pattern", route.Pattern);
                if (route.Handler is not null)
                    writer.WriteString("handler", route.Handler);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteStartArray("pages");
            foreach (var page in manifest.Pages)
            {
                writer.WriteStartObject();
                writer.WriteString("pattern", page.Pattern);
                if (page.Name is not null)
                    writer.WriteString("name", page.Name);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        return stream.ToArray();
    }
}
