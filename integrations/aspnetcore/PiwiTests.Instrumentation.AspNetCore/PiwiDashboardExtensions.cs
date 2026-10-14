using System;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace PiwiTests.Instrumentation.AspNetCore;

public static class PiwiDashboardExtensions
{
    /// <summary>
    /// Registers the Piwi test log capture provider on any <see cref="ILoggingBuilder"/>.
    /// This is the hosting-agnostic entry point; the other <c>AddPiwiTestLogs</c> overloads
    /// delegate to it. Works under minimal hosting and the classic Generic Host + <c>Startup</c> model.
    /// Registering it more than once adds a single provider.
    /// </summary>
    public static ILoggingBuilder AddPiwiTestLogs(this ILoggingBuilder logging)
    {
        logging.Services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, PiwiTestLoggerProvider>());
        return logging;
    }

    /// <summary>
    /// Registers the Piwi test log capture provider and configures <see cref="PiwiTestLogsOptions"/>,
    /// e.g. the environments the middleware is active in.
    /// </summary>
    public static ILoggingBuilder AddPiwiTestLogs(this ILoggingBuilder logging, Action<PiwiTestLogsOptions> configure)
    {
        logging.Services.Configure(configure);
        return logging.AddPiwiTestLogs();
    }

    /// <summary>
    /// Registers the Piwi test log capture provider through an <see cref="IServiceCollection"/>,
    /// for hosts that configure logging via services (e.g. <c>Startup.ConfigureServices</c>).
    /// </summary>
    public static IServiceCollection AddPiwiTestLogs(this IServiceCollection services) =>
        services.AddLogging(logging => logging.AddPiwiTestLogs());

    /// <summary>
    /// Registers the Piwi test log capture provider and configures <see cref="PiwiTestLogsOptions"/>
    /// through an <see cref="IServiceCollection"/> (e.g. in <c>Startup.ConfigureServices</c>).
    /// </summary>
    public static IServiceCollection AddPiwiTestLogs(this IServiceCollection services, Action<PiwiTestLogsOptions> configure) =>
        services.AddLogging(logging => logging.AddPiwiTestLogs(configure));

    /// <summary>
    /// Registers the Piwi test log capture provider. Call on the builder before <c>Build()</c>.
    /// </summary>
    public static WebApplicationBuilder AddPiwiTestLogs(this WebApplicationBuilder builder)
    {
        builder.Logging.AddPiwiTestLogs();
        return builder;
    }

    /// <summary>
    /// Registers the Piwi test log capture provider and configures <see cref="PiwiTestLogsOptions"/>.
    /// Call on the builder before <c>Build()</c>.
    /// </summary>
    public static WebApplicationBuilder AddPiwiTestLogs(this WebApplicationBuilder builder, Action<PiwiTestLogsOptions> configure)
    {
        builder.Logging.AddPiwiTestLogs(configure);
        return builder;
    }

    /// <summary>
    /// Adds the Piwi test log header middleware to any <see cref="IApplicationBuilder"/> (works
    /// under the classic Generic Host + <c>Startup</c> model). Active in the environments set by
    /// <see cref="PiwiTestLogsOptions"/> or <c>PIWI_TEST_LOGS_ENVIRONMENTS</c>, Development and Test
    /// by default. The environment is taken from <paramref name="environment"/> when supplied,
    /// otherwise resolved from the app's service provider. Register early in the pipeline so it
    /// wraps all subsequent middleware.
    /// </summary>
    public static IApplicationBuilder UsePiwiTestLogs(this IApplicationBuilder app, IHostEnvironment? environment = null) =>
        app.UsePiwiTestLogsWhenActive(environment, isActive: null, environments: null);

    /// <summary>
    /// Adds the Piwi test log header middleware when <paramref name="isActive"/> returns true for
    /// <paramref name="environment"/>, e.g. <c>e =&gt; e.IsDevelopment() || e.IsEnvironment("Integration")</c>.
    /// Takes precedence over <see cref="PiwiTestLogsOptions"/> and <c>PIWI_TEST_LOGS_ENVIRONMENTS</c>;
    /// <c>PIWI_TEST_LOGS_DISABLED</c> still overrides it. Register early in the pipeline.
    /// </summary>
    public static IApplicationBuilder UsePiwiTestLogs(
        this IApplicationBuilder app,
        IHostEnvironment environment,
        Func<IHostEnvironment, bool> isActive)
    {
        ArgumentNullException.ThrowIfNull(isActive);
        return app.UsePiwiTestLogsWhenActive(environment, isActive, environments: null);
    }

    /// <summary>
    /// Adds the Piwi test log header middleware when <paramref name="environment"/> is one of
    /// <paramref name="environments"/> (case-insensitive), e.g. <c>"Development", "Podman", "Integration"</c>.
    /// Takes precedence over <see cref="PiwiTestLogsOptions"/> and <c>PIWI_TEST_LOGS_ENVIRONMENTS</c>;
    /// <c>PIWI_TEST_LOGS_DISABLED</c> still overrides it. Register early in the pipeline.
    /// </summary>
    public static IApplicationBuilder UsePiwiTestLogs(
        this IApplicationBuilder app,
        IHostEnvironment environment,
        params string[] environments) =>
        app.UsePiwiTestLogsWhenActive(environment, isActive: null, environments);

    /// <summary>
    /// Adds the Piwi test log header middleware. Active in the environments set by
    /// <see cref="PiwiTestLogsOptions"/> or <c>PIWI_TEST_LOGS_ENVIRONMENTS</c>, Development and Test
    /// by default. Register early in the pipeline so it wraps all subsequent middleware.
    /// </summary>
    public static WebApplication UsePiwiTestLogs(this WebApplication app)
    {
        ((IApplicationBuilder)app).UsePiwiTestLogs(app.Environment);
        return app;
    }

    private static IApplicationBuilder UsePiwiTestLogsWhenActive(
        this IApplicationBuilder app,
        IHostEnvironment? environment,
        Func<IHostEnvironment, bool>? isActive,
        string[]? environments)
    {
        environment ??= app.ApplicationServices.GetRequiredService<IHostEnvironment>();
        var options = app.ApplicationServices.GetService<IOptions<PiwiTestLogsOptions>>()?.Value;
        var coverage = options?.Coverage ?? new PiwiCoverageSettings();
        if (PiwiTestLogsGate.IsActive(environment, isActive, environments, options, Environment.GetEnvironmentVariable))
        {
            var serverCoverage = new PiwiServerCoverage(coverage);
            app.Use(next => new PiwiTestLogHeaderMiddleware(next, serverCoverage).InvokeAsync);
        }
        else if (coverage.IsInstrumented())
        {
            app.ApplicationServices.GetService<ILoggerFactory>()?.CreateLogger("PiwiTests.Instrumentation")
                .LogWarning(
                    "This build records code coverage (built with -p:PiwiCoverage=true), but the Piwi middleware is not active in the {Environment} environment, so nothing serves it. Never deploy a coverage build to production.",
                    environment.EnvironmentName);
        }

        return app;
    }
}
