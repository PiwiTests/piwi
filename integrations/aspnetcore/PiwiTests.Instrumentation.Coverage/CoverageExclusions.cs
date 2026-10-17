using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Text.RegularExpressions;

namespace PiwiTests.Instrumentation.Coverage;

/// <summary>
/// The members a coverage build leaves out of its coverage, the way coverlet 6 excludes them: by attribute, by source
/// file and by <c>[Assembly]Type</c> filter. The build embeds the settings it found as the
/// <c>PiwiTests.Instrumentation.Coverage.Exclusions</c> resource (see the package's <c>build/</c> props): one
/// <c>Key=value</c> line per setting, the values comma-separated as coverlet reads them. The keys are
/// <c>ExcludeByAttribute</c>, <c>ExcludeByFile</c>, <c>Exclude</c>, <c>Include</c>, and <c>SourceRoot</c>
/// (<c>mapped|local</c>, a deterministic build's source root and the directory it stands for).
/// </summary>
/// <remarks>
/// Mirrors coverlet's <c>Instrumenter</c> and <c>InstrumentationHelper</c> (<c>src/coverlet.core</c>, MIT):
/// <list type="bullet">
/// <item>an attribute matches by its type's name or full name, with or without the <c>Attribute</c> suffix, in any
/// namespace; <c>ExcludeFromCodeCoverageAttribute</c> and <c>ExcludeFromCoverageAttribute</c> always do;</item>
/// <item>such an attribute on the assembly excludes all of it; on a type, it and its nested types; on a method,
/// constructor or property, the method or the property's accessors. coverlet reads no attribute on an event; the
/// compiler itself leaves out an event marked with <c>System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage</c>;</item>
/// <item>a filter's assembly part matches the assembly file name, its type part a type's full name (<c>/</c> before a
/// nested type's name), <c>*</c> any characters and <c>?</c> the character before it optionally; an exclude filter
/// excludes a type when it matches the type or a type it is nested in, an include filter includes a type it matches
/// itself; a filter whose type part is <c>*</c>, or an include filter ending in <c>*</c>, matches the assembly name
/// ignoring case;</item>
/// <item>a method is in the file of its first span, matched against the <c>ExcludeByFile</c> globs as
/// <c>Microsoft.Extensions.FileSystemGlobbing</c> matches them: without the path's root, ignoring case, <c>**</c> any
/// directories, a pattern ending in <c>/</c> every file under it.</item>
/// </list>
/// A method row holds the statements of the lambdas, local functions and state machine the method declares, so they
/// are excluded with it.
/// </remarks>
internal sealed class CoverageExclusions
{
    internal const string ResourceName = "PiwiTests.Instrumentation.Coverage.Exclusions";

    private static readonly string[] DefaultAttributes = ["ExcludeFromCoverageAttribute", "ExcludeFromCodeCoverageAttribute"];

    private readonly HashSet<string> _attributes;
    private readonly Filter[] _exclude;
    private readonly Filter[] _include;
    private readonly Regex?[][] _files;
    private readonly (string Mapped, string Local)[] _sourceRoots;

    private CoverageExclusions(HashSet<string> attributes, Filter[] exclude, Filter[] include, Regex?[][] files, (string, string)[] sourceRoots)
    {
        _attributes = attributes;
        _exclude = exclude;
        _include = include;
        _files = files;
        _sourceRoots = sourceRoots;
    }

    /// <summary>The exclusions of the resource text <paramref name="text"/>, coverlet's defaults alone when null.</summary>
    internal static CoverageExclusions Parse(string? text)
    {
        var attributes = new HashSet<string>(DefaultAttributes, StringComparer.Ordinal);
        List<Filter> exclude = [], include = [];
        List<Regex?[]> files = [];
        List<(string, string)> sourceRoots = [];
        foreach (var line in (text ?? "").Split('\n'))
        {
            var separator = line.IndexOf('=');
            if (separator <= 0)
                continue;

            var value = line[(separator + 1)..].TrimEnd('\r');
            switch (line[..separator].Trim())
            {
                case "ExcludeByAttribute":
                    foreach (var name in Values(value))
                    {
                        attributes.Add(name);
                        if (!name.EndsWith("Attribute", StringComparison.Ordinal))
                            attributes.Add(name + "Attribute");
                    }
                    break;
                case "ExcludeByFile":
                    files.AddRange(Values(value).Select(Glob));
                    break;
                case "Exclude":
                    exclude.AddRange(Filters(value));
                    break;
                case "Include":
                    include.AddRange(Filters(value));
                    break;
                case "SourceRoot" when value.IndexOf('|') is > 0 and var bar:
                    sourceRoots.Add((value[..bar], value[(bar + 1)..]));
                    break;
            }
        }

        return new CoverageExclusions(attributes, [.. exclude], [.. include], [.. files], [.. sourceRoots]);
    }

    /// <summary>
    /// The method rows of <paramref name="table"/> excluded from coverage, indexed by row, or null when none is.
    /// </summary>
    /// <param name="metadata">The metadata of the assembly the span table belongs to.</param>
    /// <param name="module">The assembly's file name without its extension.</param>
    /// <param name="table">The assembly's span table.</param>
    internal bool[]? ExcludedRows(MetadataReader metadata, string module, SpanTable table)
    {
        var excluded = new bool[table.MethodRows + 1];
        if ((metadata.IsAssembly && HasExcludeAttribute(metadata, metadata.GetAssemblyDefinition().GetCustomAttributes())) || !ModuleIncluded(module))
        {
            Array.Fill(excluded, true);
            return excluded;
        }

        var types = new Dictionary<TypeDefinitionHandle, bool>();
        var accessors = new HashSet<MethodDefinitionHandle>();
        foreach (var handle in metadata.TypeDefinitions)
        {
            foreach (var propertyHandle in metadata.GetTypeDefinition(handle).GetProperties())
            {
                var property = metadata.GetPropertyDefinition(propertyHandle);
                if (!HasExcludeAttribute(metadata, property.GetCustomAttributes()))
                    continue;

                var methods = property.GetAccessors();
                accessors.Add(methods.Getter);
                accessors.Add(methods.Setter);
            }
        }

        var any = false;
        for (var row = 1; row <= table.MethodRows && row <= metadata.MethodDefinitions.Count; row++)
        {
            var spans = table.Spans(row);
            if (spans.Length == 0)
                continue;

            var handle = MetadataTokens.MethodDefinitionHandle(row);
            var method = metadata.GetMethodDefinition(handle);
            var type = method.GetDeclaringType();
            if (!types.TryGetValue(type, out var typeExcluded))
                types[type] = typeExcluded = TypeExcluded(metadata, module, type) || !TypeIncluded(metadata, module, type);

            excluded[row] = typeExcluded || accessors.Contains(handle) ||
                HasExcludeAttribute(metadata, method.GetCustomAttributes()) || ExcludesFile(table.Documents[spans[0].Document]);
            any |= excluded[row];
        }

        return any ? excluded : null;
    }

    private bool ModuleIncluded(string module)
    {
        if (_exclude.Any(f => f.Type == "*" && f.ModuleIgnoringCase.IsMatch(module)))
            return false;

        var modules = _include.Where(f => f.Text.EndsWith('*')).ToArray();
        return modules.Length == 0 || modules.Any(f => f.ModuleIgnoringCase.IsMatch(module));
    }

    private bool TypeExcluded(MetadataReader metadata, string module, TypeDefinitionHandle handle)
    {
        for (var current = handle; !current.IsNil; current = metadata.GetTypeDefinition(current).GetDeclaringType())
        {
            if (HasExcludeAttribute(metadata, metadata.GetTypeDefinition(current).GetCustomAttributes()))
                return true;

            var name = FullName(metadata, current);
            if (_exclude.Any(f => f.Matches(module, name)))
                return true;
        }

        return false;
    }

    private bool TypeIncluded(MetadataReader metadata, string module, TypeDefinitionHandle handle)
    {
        if (_include.Length == 0)
            return true;

        var name = FullName(metadata, handle);
        return _include.Any(f => f.Matches(module, name));
    }

    /// <summary>True when the <c>ExcludeByFile</c> globs match <paramref name="document"/>, a path the compiler recorded.</summary>
    internal bool ExcludesFile(string document)
    {
        if (_files.Length == 0)
            return false;

        foreach (var (mapped, local) in _sourceRoots)
        {
            if (document.StartsWith(mapped, StringComparison.Ordinal))
            {
                document = local + document[mapped.Length..];
                break;
            }
        }

        var segments = Segments(document);
        return _files.Any(glob => GlobMatches(glob, 0, segments, 0));
    }

    private bool HasExcludeAttribute(MetadataReader metadata, CustomAttributeHandleCollection attributes)
    {
        foreach (var handle in attributes)
        {
            var (name, fullName) = AttributeType(metadata, metadata.GetCustomAttribute(handle).Constructor);
            if (name is not null && (_attributes.Contains(name) || _attributes.Contains(fullName!)))
                return true;
        }

        return false;
    }

    /// <summary>The name and full name of the attribute type <paramref name="constructor"/> belongs to.</summary>
    private static (string? Name, string? FullName) AttributeType(MetadataReader metadata, EntityHandle constructor)
    {
        var type = constructor.Kind switch
        {
            HandleKind.MemberReference => metadata.GetMemberReference((MemberReferenceHandle)constructor).Parent,
            HandleKind.MethodDefinition => metadata.GetMethodDefinition((MethodDefinitionHandle)constructor).GetDeclaringType(),
            _ => default(EntityHandle),
        };
        switch (type.Kind)
        {
            case HandleKind.TypeDefinition:
                var definition = (TypeDefinitionHandle)type;
                return (metadata.GetString(metadata.GetTypeDefinition(definition).Name), FullName(metadata, definition));
            case HandleKind.TypeReference:
                var reference = metadata.GetTypeReference((TypeReferenceHandle)type);
                return (metadata.GetString(reference.Name), FullName(metadata, (TypeReferenceHandle)type));
            default:
                return (null, null);
        }
    }

    /// <summary>A type's full name as coverlet names it (Mono.Cecil's): <c>Namespace.Outer/Nested</c>.</summary>
    private static string FullName(MetadataReader metadata, TypeDefinitionHandle handle)
    {
        var type = metadata.GetTypeDefinition(handle);
        var declaring = type.GetDeclaringType();
        return declaring.IsNil
            ? Qualified(metadata.GetString(type.Namespace), metadata.GetString(type.Name))
            : $"{FullName(metadata, declaring)}/{metadata.GetString(type.Name)}";
    }

    private static string FullName(MetadataReader metadata, TypeReferenceHandle handle)
    {
        var type = metadata.GetTypeReference(handle);
        return type.ResolutionScope.Kind == HandleKind.TypeReference
            ? $"{FullName(metadata, (TypeReferenceHandle)type.ResolutionScope)}/{metadata.GetString(type.Name)}"
            : Qualified(metadata.GetString(type.Namespace), metadata.GetString(type.Name));
    }

    private static string Qualified(string ns, string name) => ns.Length == 0 ? name : $"{ns}.{name}";

    private static IEnumerable<string> Values(string value) =>
        value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    /// <summary>The valid filters of a comma-separated list, a filter no regular expression can stand for left out.</summary>
    private static IEnumerable<Filter> Filters(string value)
    {
        foreach (var text in Values(value).Where(IsValidFilter))
        {
            Filter filter;
            try
            {
                filter = new Filter(text);
            }
            catch (ArgumentException)
            {
                continue;
            }

            yield return filter;
        }
    }

    /// <summary>coverlet's <c>IsValidFilterExpression</c>: <c>[assembly]type</c>, word characters, dots, <c>*</c> and <c>?</c>.</summary>
    internal static bool IsValidFilter(string filter)
    {
        if (!filter.StartsWith('[') || !filter.Contains(']'))
            return false;
        if (filter.Count(c => c == '[') > 1 || filter.Count(c => c == ']') > 1)
            return false;
        if (filter.IndexOf(']') < filter.IndexOf('[') || filter.IndexOf(']') - filter.IndexOf('[') == 1 || filter.EndsWith(']'))
            return false;

        return !Regex.IsMatch(filter.Replace(".", "").Replace("?", "").Replace("[", "").Replace("]", ""), @"[^\w*]");
    }

    /// <summary>coverlet's <c>WildcardToRegex</c>: <c>*</c> any characters, <c>?</c> the character before it optionally.</summary>
    private static string WildcardToRegex(string pattern) =>
        "^" + Regex.Escape(pattern).Replace("\\*", ".*").Replace("\\?", "?") + "$";

    /// <summary>The segments of a glob pattern, each a regular expression, <c>**</c> as null.</summary>
    private static Regex?[] Glob(string pattern)
    {
        var segments = Segments(pattern.EndsWith('/') || pattern.EndsWith('\\') ? pattern + "**" : pattern);
        return [.. segments.Select(s => s == "**"
            ? null
            : new Regex("^" + Regex.Escape(s).Replace("\\*", ".*") + "$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))];
    }

    /// <summary>The segments of a path without its root, <c>.</c> segments left out.</summary>
    private static string[] Segments(string path)
    {
        if (Path.IsPathRooted(path))
            path = path[(Path.GetPathRoot(path)?.Length ?? 0)..];

        return path.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries).Where(s => s != ".").ToArray();
    }

    private static bool GlobMatches(Regex?[] glob, int g, string[] path, int p)
    {
        if (g == glob.Length)
            return p == path.Length;
        if (glob[g] is null)
        {
            for (var skip = p; skip <= path.Length; skip++)
            {
                if (GlobMatches(glob, g + 1, path, skip))
                    return true;
            }

            return false;
        }

        return p < path.Length && glob[g]!.IsMatch(path[p]) && GlobMatches(glob, g + 1, path, p + 1);
    }

    /// <summary>A coverlet filter, <c>[assembly]type</c>.</summary>
    private sealed class Filter
    {
        private readonly Regex _module;
        private readonly Regex _type;

        internal Filter(string filter)
        {
            Text = filter;
            var close = filter.IndexOf(']');
            Type = filter[(close + 1)..];
            var module = WildcardToRegex(filter[1..close]);
            _module = new Regex(module);
            _type = new Regex(WildcardToRegex(Type));
            ModuleIgnoringCase = new Regex(module, RegexOptions.IgnoreCase);
        }

        internal string Text { get; }

        internal string Type { get; }

        internal Regex ModuleIgnoringCase { get; }

        internal bool Matches(string module, string type) => _type.IsMatch(type) && _module.IsMatch(module);
    }
}
