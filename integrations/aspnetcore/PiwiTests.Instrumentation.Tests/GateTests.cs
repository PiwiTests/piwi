using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using PiwiTests.Instrumentation.AspNetCore;
using Xunit;

namespace PiwiTests.Instrumentation.Tests;

public class GateTests
{
    [Theory]
    [InlineData("Development", true)]
    [InlineData("Test", true)]
    [InlineData("test", true)]
    [InlineData("Production", false)]
    [InlineData("Podman", false)]
    public void Defaults_to_Development_and_Test(string environment, bool expected)
    {
        Assert.Equal(expected, IsActive(environment));
    }

    [Fact]
    public void A_predicate_argument_wins_over_every_other_setting()
    {
        var options = new PiwiTestLogsOptions { IsActive = _ => false };
        options.Environments.Add("Podman");

        Assert.True(IsActive("Podman", isActive: e => e.IsEnvironment("Podman"), environments: ["Other"],
            options: options, variables: new() { ["PIWI_TEST_LOGS_ENVIRONMENTS"] = "Other" }));
        Assert.False(IsActive("Development", isActive: e => e.IsEnvironment("Podman")));
    }

    [Fact]
    public void Environment_name_arguments_win_over_options_and_the_variable()
    {
        var options = new PiwiTestLogsOptions { IsActive = _ => false };

        Assert.True(IsActive("integration", environments: ["Podman", "Integration"], options: options,
            variables: new() { ["PIWI_TEST_LOGS_ENVIRONMENTS"] = "Other" }));
        Assert.False(IsActive("Development", environments: ["Podman", "Integration"]));
    }

    [Fact]
    public void No_environment_name_arguments_fall_through_to_the_next_setting()
    {
        Assert.True(IsActive("Development", environments: []));
        Assert.True(IsActive("Development", environments: [" ", ""]));
    }

    [Fact]
    public void The_options_predicate_wins_over_the_options_environments()
    {
        var options = new PiwiTestLogsOptions { IsActive = e => e.IsEnvironment("Podman") };
        options.Environments.Add("Integration");

        Assert.True(IsActive("Podman", options: options));
        Assert.False(IsActive("Integration", options: options));
    }

    [Fact]
    public void The_options_environments_win_over_the_variable_and_replace_the_default()
    {
        var options = new PiwiTestLogsOptions();
        options.Environments.Add("Integration");
        var variables = new Dictionary<string, string?> { ["PIWI_TEST_LOGS_ENVIRONMENTS"] = "Podman" };

        Assert.True(IsActive("Integration", options: options, variables: variables));
        Assert.False(IsActive("Podman", options: options, variables: variables));
        Assert.False(IsActive("Development", options: options));
    }

    [Fact]
    public void The_environments_variable_replaces_the_default()
    {
        var variables = new Dictionary<string, string?> { ["PIWI_TEST_LOGS_ENVIRONMENTS"] = " Podman , Integration," };

        Assert.True(IsActive("Podman", variables: variables));
        Assert.True(IsActive("Integration", variables: variables));
        Assert.False(IsActive("Development", variables: variables));
        Assert.True(IsActive("Development", variables: new() { ["PIWI_TEST_LOGS_ENVIRONMENTS"] = " , " }));
    }

    [Theory]
    [InlineData("true", false)]
    [InlineData("TRUE", false)]
    [InlineData("false", true)]
    public void The_disabled_variable_overrides_everything(string value, bool expected)
    {
        var variables = new Dictionary<string, string?> { ["PIWI_TEST_LOGS_DISABLED"] = value };
        var environment = expected ? "Production" : "Development";

        Assert.Equal(expected, IsActive(environment, isActive: _ => !expected, variables: variables));
    }

    [Fact]
    public void An_unrecognized_disabled_value_is_ignored()
    {
        var variables = new Dictionary<string, string?> { ["PIWI_TEST_LOGS_DISABLED"] = "1" };

        Assert.True(IsActive("Development", variables: variables));
        Assert.False(IsActive("Production", variables: variables));
    }

    [Theory]
    [InlineData("Development", true)]
    [InlineData("Staging", false)]
    public async Task The_parameterless_overload_keeps_the_default(string environment, bool expected)
    {
        await using var app = await TestApp.StartAsync(environment, (a, _) => a.UsePiwiTestLogs());

        Assert.Equal(expected, await app.GetLogsAsync("/json") is not null);
    }

    [Theory]
    [InlineData("Integration", true)]
    [InlineData("Development", false)]
    public async Task A_classic_Configure_passes_a_predicate(string environment, bool expected)
    {
        await using var app = await TestApp.StartAsync(environment,
            (a, env) => a.UsePiwiTestLogs(env, e => e.IsEnvironment("Podman") || e.IsEnvironment("Integration")));

        Assert.Equal(expected, await app.GetLogsAsync("/json") is not null);
    }

    [Theory]
    [InlineData("Podman", true)]
    [InlineData("Staging", false)]
    public async Task A_classic_Configure_passes_environment_names(string environment, bool expected)
    {
        await using var app = await TestApp.StartAsync(environment,
            (a, env) => a.UsePiwiTestLogs(env, "Development", "Podman", "Integration"));

        Assert.Equal(expected, await app.GetLogsAsync("/json") is not null);
    }

    [Fact]
    public async Task ConfigureServices_sets_the_environments_through_options()
    {
        // TestApp already calls AddPiwiTestLogs(); registering again must not duplicate entries.
        await using var app = await TestApp.StartAsync("Integration", (a, _) => a.UsePiwiTestLogs(),
            services: s => s.AddPiwiTestLogs(o => o.IsActive = e => e.IsEnvironment("Integration")));

        Assert.Single((await app.GetLogsAsync("/json"))!);
    }

    private static bool IsActive(
        string environment,
        Func<IHostEnvironment, bool>? isActive = null,
        string[]? environments = null,
        PiwiTestLogsOptions? options = null,
        Dictionary<string, string?>? variables = null) =>
        PiwiTestLogsGate.IsActive(new FakeEnvironment(environment), isActive, environments, options,
            name => variables?.GetValueOrDefault(name));

    private sealed class FakeEnvironment(string name) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "/";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
