using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using PiwiTests.Instrumentation.Coverage;

namespace PiwiTests.Instrumentation.AspNetCore;

/// <summary>The body served at <c>/__piwi/environment</c>.</summary>
internal sealed record PiwiServerEnvironment(
    string? Runtime,
    string? Os,
    string? Arch,
    string? TimeZone,
    int? UtcOffsetMinutes,
    string? Locale,
    string? Globalization,
    string? EnvironmentName,
    string? AppVersion,
    string? Hostname,
    string? Instance,
    DateTimeOffset? StartedAt,
    long Now);

/// <summary>
/// The runtime facts of the server process the middleware serves at <c>/__piwi/environment</c>: the runtime, the
/// operating system, the time zone, the cultures and when the process started. The Piwi reporter reads it as
/// a test first reaches the server and again as the run's last test ends, so a failure that depends on the server's clock, zone or culture can be told from one in the code. It
/// carries only these fields: never other environment variables, file paths or connection strings.
/// </summary>
internal static class PiwiEnvironmentEndpoint
{
    internal const string Path = "/__piwi/environment";

    private const string InvariantVariable = "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT";

    internal static bool IsRequest(HttpRequest request) =>
        (HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method)) &&
        request.Path.Equals(Path, StringComparison.OrdinalIgnoreCase);

    internal static async Task WriteAsync(HttpContext context)
    {
        var environment = Build(context.RequestServices.GetService<IHostEnvironment>()?.EnvironmentName);

        context.Response.StatusCode = StatusCodes.Status200OK;
        context.Response.ContentType = "application/json";
        context.Response.Headers.CacheControl = "no-store";
        await context.Response.Body.WriteAsync(Serialize(environment));
    }

    /// <summary>Reads the facts of the current process.</summary>
    internal static PiwiServerEnvironment Build(string? environmentName)
    {
        var local = TimeZoneInfo.Local;
        return new PiwiServerEnvironment(
            Runtime: Read(() => RuntimeInformation.FrameworkDescription),
            Os: Read(() => RuntimeInformation.OSDescription),
            Arch: Read(() => RuntimeInformation.ProcessArchitecture.ToString()),
            TimeZone: Read(() => TimeZoneName(local)),
            UtcOffsetMinutes: (int)local.GetUtcOffset(DateTime.UtcNow).TotalMinutes,
            Locale: Read(() => Locale(CultureInfo.CurrentCulture, CultureInfo.CurrentUICulture)),
            Globalization: Read(() => GlobalizationMode(Environment.GetEnvironmentVariable)),
            EnvironmentName: string.IsNullOrEmpty(environmentName) ? null : environmentName,
            AppVersion: Read(() => Assembly.GetEntryAssembly()
                ?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion),
            Hostname: Read(() => Environment.MachineName),
            Instance: PiwiCoverageRecorder.InstanceId,
            StartedAt: ProcessStart(),
            Now: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    /// <summary>The zone's id, followed by its IANA id in parentheses when the id is a Windows one: <c>Romance Standard Time (Europe/Paris)</c>.</summary>
    internal static string TimeZoneName(TimeZoneInfo zone)
    {
        if (zone.HasIanaId)
            return zone.Id;
        return TimeZoneInfo.TryConvertWindowsIdToIanaId(zone.Id, out var iana) ? $"{zone.Id} ({iana})" : zone.Id;
    }

    /// <summary>The culture's name, then the UI culture's when it differs: <c>fr-FR / en-US</c>; <c>invariant</c> for the invariant culture.</summary>
    internal static string Locale(CultureInfo culture, CultureInfo uiCulture)
    {
        static string Name(CultureInfo c) => c.Name.Length == 0 ? "invariant" : c.Name;
        var name = Name(culture);
        var uiName = Name(uiCulture);
        return name == uiName ? name : $"{name} / {uiName}";
    }

    /// <summary><c>invariant</c> in globalization-invariant mode, else <c>nls</c> or <c>icu</c>: the library cultures come from.</summary>
    internal static string GlobalizationMode(Func<string, string?> readVariable)
    {
        if (AppContext.TryGetSwitch("System.Globalization.Invariant", out var invariant))
        {
            if (invariant)
                return "invariant";
        }
        else if (readVariable(InvariantVariable) is { } value &&
            (value == "1" || value.Equals("true", StringComparison.OrdinalIgnoreCase)))
        {
            return "invariant";
        }

        var nls = OperatingSystem.IsWindows() &&
            AppContext.TryGetSwitch("System.Globalization.UseNls", out var useNls) && useNls;
        return nls ? "nls" : "icu";
    }

    /// <summary>When the process started, in UTC; null when the platform does not say.</summary>
    private static DateTimeOffset? ProcessStart()
    {
        try
        {
            using var process = Process.GetCurrentProcess();
            return new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero);
        }
        catch (Exception e) when (e is InvalidOperationException or NotSupportedException or System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }

    /// <summary>Reads one fact, null when it is empty or cannot be read.</summary>
    private static string? Read(Func<string?> reader)
    {
        try
        {
            var value = reader();
            return string.IsNullOrEmpty(value) ? null : value;
        }
        catch (Exception e) when (e is InvalidOperationException or NotSupportedException or PlatformNotSupportedException)
        {
            return null;
        }
    }

    /// <summary>Serializes the facts to the camelCase JSON the reporter reads, a fact not read written as null.</summary>
    internal static byte[] Serialize(PiwiServerEnvironment environment)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteNumber("v", 1);
            WriteString(writer, "runtime", environment.Runtime);
            WriteString(writer, "os", environment.Os);
            WriteString(writer, "arch", environment.Arch);
            WriteString(writer, "timeZone", environment.TimeZone);
            if (environment.UtcOffsetMinutes is { } offset)
                writer.WriteNumber("utcOffsetMinutes", offset);
            else
                writer.WriteNull("utcOffsetMinutes");
            WriteString(writer, "locale", environment.Locale);
            WriteString(writer, "globalization", environment.Globalization);
            WriteString(writer, "environmentName", environment.EnvironmentName);
            WriteString(writer, "appVersion", environment.AppVersion);
            WriteString(writer, "hostname", environment.Hostname);
            WriteString(writer, "instance", environment.Instance);
            WriteString(writer, "startedAt", environment.StartedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
            writer.WriteNumber("now", environment.Now);
            writer.WriteEndObject();
        }

        return stream.ToArray();
    }

    private static void WriteString(Utf8JsonWriter writer, string name, string? value)
    {
        if (value is null)
            writer.WriteNull(name);
        else
            writer.WriteString(name, value);
    }
}
