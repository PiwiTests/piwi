using System;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using PiwiTests.Instrumentation.AspNetCore;
using PiwiTests.Instrumentation.Coverage;
using Xunit;

namespace PiwiTests.Instrumentation.Tests;

public class EnvironmentTests
{
    private static readonly string[] Keys =
    [
        "v", "runtime", "os", "arch", "timeZone", "utcOffsetMinutes", "locale", "globalization",
        "environmentName", "appVersion", "hostname", "instance", "startedAt", "now",
    ];

    [Fact]
    public async Task Serves_the_runtime_facts_and_only_those_in_an_active_environment()
    {
        await using var app = await ManifestTestApp.StartAsync(e => e.MapGet("/api/items", () => "list"));

        var response = await app.Client.GetAsync("/__piwi/environment");

        response.EnsureSuccessStatusCode();
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = json.RootElement;
        Assert.Equal(
            Keys.OrderBy(k => k, StringComparer.Ordinal),
            root.EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal));
        Assert.Equal(1, root.GetProperty("v").GetInt32());
        Assert.Equal("Development", root.GetProperty("environmentName").GetString());
        Assert.Equal(PiwiCoverageRecorder.InstanceId, root.GetProperty("instance").GetString());
        Assert.False(string.IsNullOrEmpty(root.GetProperty("runtime").GetString()));
        var startedAt = DateTimeOffset.Parse(root.GetProperty("startedAt").GetString()!, CultureInfo.InvariantCulture);
        Assert.True(startedAt.ToUnixTimeMilliseconds() <= root.GetProperty("now").GetInt64());
    }

    [Fact]
    public async Task Is_not_served_outside_the_active_environments()
    {
        await using var app = await ManifestTestApp.StartAsync(e => e.MapGet("/api/items", () => "list"), environment: "Production");

        var response = await app.Client.GetAsync("/__piwi/environment");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public void Names_the_invariant_culture_and_a_differing_ui_culture()
    {
        Assert.Equal("fr-FR", PiwiEnvironmentEndpoint.Locale(new CultureInfo("fr-FR"), new CultureInfo("fr-FR")));
        Assert.Equal("fr-FR / en-US", PiwiEnvironmentEndpoint.Locale(new CultureInfo("fr-FR"), new CultureInfo("en-US")));
        Assert.Equal("invariant", PiwiEnvironmentEndpoint.Locale(CultureInfo.InvariantCulture, CultureInfo.InvariantCulture));
    }

    [Fact]
    public void Reads_invariant_mode_from_the_environment_variable()
    {
        if (AppContext.TryGetSwitch("System.Globalization.Invariant", out _))
            return;

        Assert.Equal("invariant", PiwiEnvironmentEndpoint.GlobalizationMode(_ => "1"));
        Assert.Equal("invariant", PiwiEnvironmentEndpoint.GlobalizationMode(_ => "true"));
        Assert.Contains(PiwiEnvironmentEndpoint.GlobalizationMode(_ => null), new[] { "icu", "nls" });
    }

    [Fact]
    public void Writes_null_for_a_fact_not_read_and_startedAt_as_an_iso_date()
    {
        var environment = new PiwiServerEnvironment(
            ".NET 10.0.0", "Linux", "X64", "Europe/Paris", 60, "fr-FR", "icu", "Test", null, "web-1", "abc",
            new DateTimeOffset(2026, 3, 29, 9, 58, 30, TimeSpan.Zero), 1774778400000);

        var body = System.Text.Encoding.UTF8.GetString(PiwiEnvironmentEndpoint.Serialize(environment));

        Assert.Equal(
            """{"v":1,"runtime":".NET 10.0.0","os":"Linux","arch":"X64","timeZone":"Europe/Paris","utcOffsetMinutes":60,"locale":"fr-FR","globalization":"icu","environmentName":"Test","appVersion":null,"hostname":"web-1","instance":"abc","startedAt":"2026-03-29T09:58:30.000Z","now":1774778400000}""",
            body);
    }
}
