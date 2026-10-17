using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Xml.Linq;
using PiwiTests.Instrumentation.Coverage;
using Xunit;

namespace PiwiTests.Instrumentation.Tests;

public class CoverageOutputTests
{
    private const string UnitFixture = "integrations/aspnetcore/PiwiTests.Instrumentation.CoverageUnitFixture";

    [Fact]
    public void Names_a_file_per_host_in_a_directory_and_the_file_itself_otherwise()
    {
        var root = Path.Combine(Path.GetTempPath(), $"piwi-coverage-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var expected = Path.Combine(root, "out", "piwi-coverage-Orders.Tests-42.json");
            Assert.Equal(expected, PiwiCoverageOutput.ReportPath(Path.Combine(root, "out") + Path.DirectorySeparatorChar, "Orders.Tests", 42));
            Assert.Equal(expected, PiwiCoverageOutput.ReportPath(Path.Combine(root, "out") + '/', "Orders.Tests", 42));
            Assert.Equal(Path.Combine(root, "piwi-coverage-Orders.Tests-42.json"), PiwiCoverageOutput.ReportPath(root, "Orders.Tests", 42));
            Assert.Equal(Path.Combine(root, "unit.json"), PiwiCoverageOutput.ReportPath(Path.Combine(root, "unit.json"), "Orders.Tests", 42));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Names_the_host_after_the_test_project_a_VSTest_host_runs()
    {
        Assert.Equal("PiwiTests.Instrumentation.Tests", PiwiCoverageOutput.HostName());
    }

    [Fact]
    public void A_test_host_on_a_coverage_build_writes_its_report_at_exit_one_file_per_host()
    {
        var root = Path.Combine(Path.GetTempPath(), $"piwi-coverage-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            // A relative directory: the coverage props resolve it against the directory dotnet test runs in.
            var test = new[] { "test", FixtureSource.RepositoryFile(UnitFixture), "-c", "Release", "-p:PiwiCoverage=true", "--artifacts-path", Path.Combine(root, "artifacts") };
            DotnetTest(root, test);
            DotnetTest(root, [.. test, "--no-build"]);

            var reports = Directory.GetFiles(Path.Combine(root, "coverage"));
            Assert.Equal(2, reports.Length);
            foreach (var report in reports)
            {
                Assert.Matches("^piwi-coverage-PiwiTests\\.Instrumentation\\.CoverageUnitFixture-[0-9]+\\.json$", Path.GetFileName(report));
                using var json = JsonDocument.Parse(File.ReadAllText(report));
                var files = json.RootElement.GetProperty("files").Deserialize<List<WireCoverageFile>>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
                var shipping = Assert.Single(files, f => f.Path.Replace('\\', '/').EndsWith($"/{UnitFixture}/Shipping.cs", StringComparison.Ordinal));
                var source = File.ReadAllLines(FixtureSource.RepositoryFile($"{UnitFixture}/Shipping.cs"));
                var free = Array.FindIndex(source, l => l.Contains("return 0;", StringComparison.Ordinal)) + 1;
                var paid = Array.FindIndex(source, l => l.Contains("return 4.90m;", StringComparison.Ordinal)) + 1;
                Assert.Contains(free, Expand(shipping.Lines!));
                Assert.DoesNotContain(paid, Expand(shipping.Lines!));
                Assert.Contains(paid, Expand(shipping.Executable!));
            }
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Counts_the_methods_and_lines_coverlet_counts_with_the_same_run_settings_exclusions()
    {
        var root = Path.Combine(Path.GetTempPath(), $"piwi-coverage-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            // The configuration dotnet test builds by default; both read the fixture's coverlet.runsettings.
            var project = FixtureSource.RepositoryFile(UnitFixture);
            DotnetTest(root, ["test", project, "-p:PiwiCoverage=true", "--artifacts-path", Path.Combine(root, "piwi")]);
            DotnetTest(root, ["test", project, "--collect", "XPlat Code Coverage", "--results-directory", Path.Combine(root, "coverlet"), "--artifacts-path", Path.Combine(root, "plain")]);

            var directory = Path.GetFullPath(project) + Path.DirectorySeparatorChar;
            using var json = JsonDocument.Parse(File.ReadAllText(Assert.Single(Directory.GetFiles(Path.Combine(root, "coverage")))));
            var piwi = json.RootElement.GetProperty("files").Deserialize<List<WireCoverageFile>>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!
                .Where(f => Path.GetFullPath(f.Path).StartsWith(directory, StringComparison.Ordinal))
                .ToDictionary(f => Path.GetFullPath(f.Path));
            var coverlet = CoberturaMethods(Assert.Single(Directory.GetFiles(Path.Combine(root, "coverlet"), "coverage.cobertura.xml", SearchOption.AllDirectories)));

            Assert.Equal(coverlet.Keys.Order(), piwi.Keys.Order());
            Assert.DoesNotContain(Path.Combine(directory, "Generated", "Codes.cs"), piwi.Keys);
            var exclusions = piwi[Path.Combine(directory, "Exclusions.cs")];
            var kept = Array.FindIndex(File.ReadAllLines(exclusions.Path), l => l.Contains("return name.ToUpperInvariant();", StringComparison.Ordinal)) + 1;
            Assert.Equal([kept], Expand(exclusions.Executable!));
            foreach (var (path, methods) in coverlet)
            {
                // coverlet names a lambda or state machine apart from its method, within the method's lines; its
                // lines add the braces and declarations the compiler's statements leave out.
                var functions = piwi[path].AllFunctions!;
                Assert.All(methods, m => Assert.Contains(functions, f => f[0] <= m.Min() && m.Max() <= f[1]));
                Assert.All(functions, f => Assert.Contains(methods, m => f[0] <= m.Min() && m.Max() <= f[1]));
                Assert.Subset(methods.SelectMany(m => m).ToHashSet(), Expand(piwi[path].Executable!).ToHashSet());
            }
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static IEnumerable<int> Expand(int[][] ranges) => ranges.SelectMany(r => Enumerable.Range(r[0], r[1] - r[0] + 1));

    /// <summary>The line numbers of each method of a coverlet Cobertura report, by the file's full path.</summary>
    private static Dictionary<string, List<int[]>> CoberturaMethods(string report)
    {
        var document = XDocument.Load(report);
        var source = Assert.Single(document.Descendants("source")).Value;
        var methods = new Dictionary<string, List<int[]>>();
        foreach (var type in document.Descendants("class"))
        {
            var path = Path.GetFullPath(Path.Combine(source, type.Attribute("filename")!.Value));
            if (!methods.TryGetValue(path, out var list))
                methods[path] = list = [];
            list.AddRange(type.Descendants("method").Select(m => m.Descendants("line").Select(l => int.Parse(l.Attribute("number")!.Value)).ToArray()));
        }

        return methods;
    }

    /// <summary>
    /// Runs <c>dotnet</c> with <paramref name="arguments"/> in <paramref name="directory"/>, as a run started from a
    /// shell: the build and test-host variables of this test host left out, the VSTest shutdown timeout its default.
    /// </summary>
    private static void DotnetTest(string directory, string[] arguments)
    {
        var start = new ProcessStartInfo(Dotnet())
        {
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments)
            start.ArgumentList.Add(argument);
        foreach (var name in start.Environment.Keys.ToList())
        {
            if (name.StartsWith("MSBUILD", StringComparison.OrdinalIgnoreCase) || name.StartsWith("VSTEST", StringComparison.OrdinalIgnoreCase) ||
                name.StartsWith("PIWI_", StringComparison.OrdinalIgnoreCase))
                start.Environment.Remove(name);
        }

        start.Environment["PIWI_COVERAGE_MODE"] = "run";
        start.Environment["PIWI_COVERAGE_OUTPUT"] = "coverage/";

        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        Assert.True(process.WaitForExit(TimeSpan.FromMinutes(5)), "dotnet test did not finish in 5 minutes");
        Assert.True(process.ExitCode == 0, $"dotnet test exited with {process.ExitCode}:\n{output.Result}\n{error.Result}");
    }

    /// <summary>The <c>dotnet</c> executable running this test host, else the one on the path.</summary>
    private static string Dotnet()
    {
        var host = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH");
        if (!string.IsNullOrEmpty(host) && File.Exists(host))
            return host;

        var process = Environment.ProcessPath;
        return process is not null && Path.GetFileNameWithoutExtension(process) == "dotnet" ? process : "dotnet";
    }
}
