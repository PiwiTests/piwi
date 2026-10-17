using System;
using System.CodeDom.Compiler;
using System.Linq;
using System.Threading.Tasks;

namespace PiwiTests.Instrumentation.CoverageFixture;

/// <summary>An attribute coverlet excludes by its name, whatever its namespace.</summary>
[AttributeUsage(AttributeTargets.All)]
public sealed class ExcludeFromCoverageAttribute : Attribute
{
}

/// <summary>
/// Members the coverage build leaves out as coverlet does, with the exclusions of the project file
/// (<c>ExcludeByAttribute</c>, <c>ExcludeByFile</c>, <c>Exclude</c>), beside the one member it keeps.
/// </summary>
public static class Labels
{
    public static string Kept(string name)
    {
        return name.ToUpperInvariant();
    }

    [ExcludeFromCoverage]
    public static string ByName(string name)
    {
        Func<string, string> trim = s => s.Trim();
        return Quote(trim(name));

        static string Quote(string value)
        {
            return $"\"{value}\"";
        }
    }

    [GeneratedCode("fixture", "1.0")]
    public static async Task<string> ByConfiguredAttributeAsync(string name)
    {
        await Task.Yield();
        return new[] { name }.Select(n => n + "!").First();
    }

    [GeneratedCode("fixture", "1.0")]
    public static string Property
    {
        get { return "property"; }
    }

    public static string Accessor
    {
        [GeneratedCode("fixture", "1.0")]
        get { return "accessor"; }
    }
}

[GeneratedCode("fixture", "1.0")]
public static class GeneratedLabels
{
    public static string Outer() { return "outer"; }

    public static class Nested
    {
        public static string Inner() { return "inner"; }
    }
}

public static class LegacyLabels
{
    public static string Outer() { return "outer"; }

    public static class Nested
    {
        public static string Inner() { return "inner"; }
    }
}
