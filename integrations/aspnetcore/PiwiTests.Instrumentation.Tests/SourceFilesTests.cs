using System;
using System.IO;
using PiwiTests.Instrumentation.AspNetCore;
using Xunit;

namespace PiwiTests.Instrumentation.Tests;

public sealed class SourceFilesTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "piwi-sources-" + Guid.NewGuid().ToString("N"));

    public SourceFilesTests()
    {
        Directory.CreateDirectory(Path.Combine(_root, "repo", ".git"));
        Directory.CreateDirectory(Path.Combine(_root, "repo", "src", "Web"));
        Directory.CreateDirectory(Path.Combine(_root, "app"));
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private string Repo(params string[] parts) => Path.Combine([_root, "repo", .. parts]);

    [Fact]
    public void A_path_under_the_base_directory_is_relative_to_it()
    {
        var document = Repo("src", "Web", "Program.cs");

        Assert.Equal("src/Web/Program.cs", PiwiSourceFiles.RepositoryRelative(Repo(), document, sourceRoot: null));
    }

    [Fact]
    public void A_path_outside_the_base_directory_is_relative_to_the_repository_above_it()
    {
        var document = Repo("src", "Web", "Program.cs");

        Assert.Equal("src/Web/Program.cs", PiwiSourceFiles.RepositoryRelative(Path.Combine(_root, "app"), document, sourceRoot: null));
    }

    [Fact]
    public void The_source_root_wins_for_sources_compiled_elsewhere()
    {
        var document = Path.Combine(_root, "build", "src", "Web", "Program.cs");

        Assert.Equal("src/Web/Program.cs",
            PiwiSourceFiles.RepositoryRelative(Path.Combine(_root, "app"), document, sourceRoot: Path.Combine(_root, "build")));
    }

    [Fact]
    public void A_deterministic_build_root_is_the_repository_root()
    {
        Assert.Equal("src/Web/Program.cs", PiwiSourceFiles.RepositoryRelative(null, "/_/src/Web/Program.cs", sourceRoot: null));
    }

    [Fact]
    public void A_path_in_no_repository_and_outside_every_root_is_left_out()
    {
        var document = Path.Combine(_root, "elsewhere", "Program.cs");
        Directory.CreateDirectory(Path.GetDirectoryName(document)!);

        Assert.Null(PiwiSourceFiles.RepositoryRelative(Path.Combine(_root, "app"), document, sourceRoot: null));
    }
}
