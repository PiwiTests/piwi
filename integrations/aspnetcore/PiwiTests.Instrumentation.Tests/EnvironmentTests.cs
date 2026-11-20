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
        "environmentName", "appVersion", "appCommit", "hostname", "instance", "startedAt", "now",
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
    public async Task Serves_the_app_commit_of_the_options()
    {
        await using var app = await ManifestTestApp.StartAsync(
            e => e.MapGet("/api/items", () => "list"),
            services => services.AddPiwiTestLogs(o => o.AppCommit = "4E6F5164B"));

        using var json = JsonDocument.Parse(await app.Client.GetStringAsync("/__piwi/environment"));

        Assert.Equal("4e6f5164b", json.RootElement.GetProperty("appCommit").GetString());
    }

    [Fact]
    public void Takes_the_app_commit_from_the_option_then_the_variable_then_the_source_revision()
    {
        const string Sha = "4e6f5164b2a1c0d9e8f7a6b5c4d3e2f1a0b9c8d7";
        string? Variable(string name) => name == "PIWI_APP_COMMIT" ? "ABCDEF1" : null;
        string? None(string name) => null;

        Assert.Equal("1234567", PiwiEnvironmentEndpoint.AppCommit("1234567", Variable, "1.0.0+" + Sha));
        Assert.Equal("abcdef1", PiwiEnvironmentEndpoint.AppCommit(null, Variable, "1.0.0+" + Sha));
        Assert.Equal(Sha, PiwiEnvironmentEndpoint.AppCommit(null, None, "1.0.0+" + Sha));
        Assert.Equal(Sha, PiwiEnvironmentEndpoint.AppCommit(null, None, "1.0.0+build.7." + Sha));
        Assert.Equal(Sha, PiwiEnvironmentEndpoint.AppCommit("main", None, "1.0.0+" + Sha));
        Assert.Null(PiwiEnvironmentEndpoint.AppCommit(null, None, "1.0.0"));
        Assert.Null(PiwiEnvironmentEndpoint.AppCommit(null, None, "1.0.0+build.7"));
        Assert.Null(PiwiEnvironmentEndpoint.AppCommit(null, None, "1.0.0+20261118"));
        Assert.Null(PiwiEnvironmentEndpoint.AppCommit(null, None, "1.0.0+build.1234567"));
        Assert.Null(PiwiEnvironmentEndpoint.AppCommit(null, None, null));
        Assert.Null(PiwiEnvironmentEndpoint.AppCommit("abc12", None, "1.0.0+" + new string('a', 41)));
    }

    [Fact]
    public async Task Is_not_served_outside_the_active_environments()
    {
        await using var app = await ManifestTestApp.StartAsync(e => e.MapGet("/api/items", () => "list"), environment: "Staging");

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
            ".NET 10.0.0", "Linux", "X64", "Europe/Paris", 60, "fr-FR", "icu", "Test", null, "4e6f5164b", "web-1", "abc",
            new DateTimeOffset(2026, 3, 29, 9, 58, 30, TimeSpan.Zero), 1774778400000);

        var body = System.Text.Encoding.UTF8.GetString(PiwiEnvironmentEndpoint.Serialize(environment));

        Assert.Equal(
            """{"v":1,"runtime":".NET 10.0.0","os":"Linux","arch":"X64","timeZone":"Europe/Paris","utcOffsetMinutes":60,"locale":"fr-FR","globalization":"icu","environmentName":"Test","appVersion":null,"appCommit":"4e6f5164b","hostname":"web-1","instance":"abc","startedAt":"2026-03-29T09:58:30.000Z","now":1774778400000}""",
            body);
    }
}
