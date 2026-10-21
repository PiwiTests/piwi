using System;
using System.IO;
using System.Linq;
using System.Reflection;
using PiwiTests.Instrumentation.Coverage;
using PiwiTests.Instrumentation.CoverageFixture;
using Xunit;
using static PiwiTests.Instrumentation.Tests.FixtureSource;

namespace PiwiTests.Instrumentation.Tests;

public class CoverageExclusionTests
{
    private static readonly Assembly Fixture = typeof(Labels).Assembly;

    [Fact]
    public void Leaves_out_the_members_the_project_files_coverlet_properties_exclude()
    {
        var module = new InstrumentedModule(Fixture.ManifestModule.ModuleVersionId, 0, SpanTable.Read(Fixture)!);

        // [ExcludeFromCoverage] with its lambda and local function, the ExcludeByAttribute and Exclude members and
        // their nested types: only the kept method's statement is left.
        Assert.Equal([Line("Exclusions.cs", "return name.ToUpperInvariant();")], ExecutableLines(module, "Exclusions.cs"));
        Assert.Empty(ExecutableLines(module, "Generated/Codes.cs"));
        Assert.Contains(Line("Quotes.cs", "var total = prices.Total(quantity);"), ExecutableLines(module, "Quotes.cs"));
    }

    [Fact]
    public void Reads_the_same_exclusions_from_the_assembly_file()
    {
        var loaded = SpanTable.Read(Fixture)!;

        var read = SpanTable.ReadFile(Fixture.Location, out _)!;

        var rows = Enumerable.Range(1, loaded.MethodRows).ToArray();
        Assert.Contains(rows, loaded.IsExcluded);
        Assert.Equal(rows.Select(loaded.IsExcluded), rows.Select(read.IsExcluded));
    }

    [Fact]
    public void Leaves_out_an_assembly_marked_ExcludeFromCodeCoverage()
    {
        var path = System.IO.Path.Combine(AppContext.BaseDirectory, "PiwiTests.Instrumentation.CoverageExcludedFixture.dll");

        var table = SpanTable.ReadFile(path, out var mvid)!;

        var rows = Enumerable.Range(1, table.MethodRows).Where(row => table.Spans(row).Length > 0).ToArray();
        Assert.NotEmpty(rows);
        Assert.All(rows, row => Assert.True(table.IsExcluded(row)));
        Assert.All(new InstrumentedModule(mvid, 0, table).Lines, entries => Assert.Empty(entries));
    }

    [Theory]
    // The answers of Microsoft.Extensions.FileSystemGlobbing's Matcher, which coverlet matches ExcludeByFile with.
    [InlineData("**/Migrations/*.cs", "/src/App/Migrations/20240101_Init.cs", true)]
    [InlineData("**/Migrations/*.cs", "/src/App/migrations/Init.cs", true)]
    [InlineData("**/Migrations/*.cs", "/src/App/Migrations/Old/Init.cs", false)]
    [InlineData("**/Migrations", "/src/App/Migrations/Init.cs", false)]
    [InlineData("**/Migrations/", "/src/App/Migrations/Old/Init.cs", true)]
    [InlineData("**\\Migrations\\*.cs", "/src/App/Migrations/Init.cs", true)]
    [InlineData("**/./Migrations/*.cs", "/src/App/Migrations/Init.cs", true)]
    [InlineData("**/*.Designer.cs", "/src/App/Migrations/Init.Designer.cs", true)]
    [InlineData("/src/App/Services/*.cs", "/src/App/Services/Orders.cs", true)]
    [InlineData("src/App/Services/*.cs", "/home/me/src/App/Services/Orders.cs", false)]
    [InlineData("*.cs", "/src/App/Services/Orders.cs", false)]
    public void Matches_ExcludeByFile_as_coverlet_does(string pattern, string document, bool excluded)
    {
        Assert.Equal(excluded, CoverageExclusions.Parse($"ExcludeByFile={pattern}").ExcludesFile(document));
    }

    [Fact]
    public void Matches_ExcludeByFile_against_the_local_path_of_a_deterministic_build()
    {
        var exclusions = CoverageExclusions.Parse("ExcludeByFile=/home/me/repo/src/Generated/*.cs\nSourceRoot=/_/|/home/me/repo/");

        Assert.True(exclusions.ExcludesFile("/_/src/Generated/Codes.cs"));
        Assert.False(exclusions.ExcludesFile("/_/src/Services/Orders.cs"));
    }

    [Theory]
    [InlineData("[*]*", true)]
    [InlineData("[coverlet.*.tests?]*", true)]
    [InlineData("[*]Coverlet.Core*", true)]
    [InlineData("[]Coverlet", false)]
    [InlineData("Coverlet.Core", false)]
    [InlineData("[*]", false)]
    [InlineData("[*]Coverlet Core", false)]
    public void Accepts_the_filters_coverlet_accepts(string filter, bool valid)
    {
        Assert.Equal(valid, CoverageExclusions.IsValidFilter(filter));
    }

    /// <summary>The executable lines of fixture file <paramref name="name"/> in <paramref name="module"/>.</summary>
    private static int[] ExecutableLines(InstrumentedModule module, string name)
    {
        var document = module.Spans.Documents.ToList().FindIndex(d => d.Replace('\\', '/').EndsWith("/" + Path(name), StringComparison.Ordinal));
        return module.Lines
            .SelectMany(entries => entries.Skip(1))
            .Where(entry => entry.Document == document)
            .SelectMany(entry => entry.Ranges)
            .SelectMany(range => Enumerable.Range(range.Start, range.End - range.Start + 1))
            .Distinct()
            .Order()
            .ToArray();
    }
}
