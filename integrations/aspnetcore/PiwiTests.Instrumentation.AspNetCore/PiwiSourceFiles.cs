using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;

namespace PiwiTests.Instrumentation.AspNetCore;

/// <summary>
/// Resolves a method or a type to the source file it was compiled from, read from its assembly's
/// portable PDB (embedded, or the <c>.pdb</c> next to the assembly). Paths are relative to, in order:
/// the directory <c>PIWI_SOURCE_ROOT</c> names (where the sources were compiled, for a build made
/// elsewhere); a deterministic build's <c>/_/</c> source root; the repository root above the content
/// root (the nearest directory holding <c>.git</c>), else the content root; the repository root above
/// the source file itself. Anything it cannot read resolves to null.
/// </summary>
internal sealed class PiwiSourceFiles : IDisposable
{
    private const string DeterministicSourceRoot = "/_/";
    private const string SourceRootVariable = "PIWI_SOURCE_ROOT";

    /// <summary>The repository root above each source directory seen, or null when there is none.</summary>
    private static readonly ConcurrentDictionary<string, string?> RepositoryRoots = new(StringComparer.Ordinal);

    private readonly string? _baseDirectory;
    private readonly Dictionary<Assembly, MetadataReaderProvider?> _pdbs = [];

    internal PiwiSourceFiles(string? contentRoot)
    {
        _baseDirectory = BaseDirectory(contentRoot);
    }

    /// <summary>The directory source paths are made relative to: the repository root, else the content root.</summary>
    internal static string? BaseDirectory(string? contentRoot) => RepositoryRoot(contentRoot) ?? contentRoot;

    /// <summary>
    /// <paramref name="document"/>, a source path as the compiler recorded it, relative to the repository with
    /// POSIX separators: under the <c>PIWI_SOURCE_ROOT</c> directory, a deterministic build's <c>/_/</c> source
    /// root, <paramref name="baseDirectory"/>, or the repository root above the source file, in that order. Null
    /// when none of them holds it.
    /// </summary>
    internal static string? RepositoryRelative(string? baseDirectory, string document) =>
        RepositoryRelative(baseDirectory, document, Environment.GetEnvironmentVariable(SourceRootVariable));

    internal static string? RepositoryRelative(string? baseDirectory, string document, string? sourceRoot)
    {
        if (!string.IsNullOrWhiteSpace(sourceRoot) && Under(sourceRoot, document) is { } fromSourceRoot)
            return fromSourceRoot;

        var path = document.Replace('\\', '/');
        if (path.StartsWith(DeterministicSourceRoot, StringComparison.Ordinal))
            return path[DeterministicSourceRoot.Length..];

        if (baseDirectory is not null && Under(baseDirectory, document) is { } fromBase)
            return fromBase;

        return RepositoryRootOf(document) is { } repository ? Under(repository, document) : null;
    }

    /// <summary><paramref name="document"/> relative to <paramref name="directory"/>, or null when it is not under it.</summary>
    private static string? Under(string directory, string document)
    {
        if (!Path.IsPathRooted(document))
            return null;

        var relative = Path.GetRelativePath(directory, document);
        if (Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            return null;

        return relative.Replace('\\', '/');
    }

    /// <summary>The repository root above a source file on this machine, cached per directory.</summary>
    private static string? RepositoryRootOf(string document)
    {
        if (!Path.IsPathRooted(document) || Path.GetDirectoryName(document) is not { Length: > 0 } directory)
            return null;

        return RepositoryRoots.GetOrAdd(directory, static d => Directory.Exists(d) ? RepositoryRoot(d) : null);
    }

    /// <summary>The source file of <paramref name="method"/>, following an async or iterator method into its state machine.</summary>
    internal string? MethodFile(MethodBase method)
    {
        var document = Document(method);
        if (document is null && method.GetCustomAttribute<StateMachineAttribute>()?.StateMachineType is { } machine)
        {
            var moveNext = machine.GetMethod("MoveNext", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (moveNext is not null)
                document = Document(moveNext);
        }

        return document is null ? null : Relative(document);
    }

    /// <summary>The source file of the first method declared by <paramref name="type"/> that has one.</summary>
    internal string? TypeFile(Type type)
    {
        const BindingFlags declared = BindingFlags.DeclaredOnly | BindingFlags.Instance | BindingFlags.Static |
            BindingFlags.Public | BindingFlags.NonPublic;
        foreach (var method in type.GetMethods(declared))
        {
            if (MethodFile(method) is { } file)
                return file;
        }

        foreach (var constructor in type.GetConstructors(declared))
        {
            if (MethodFile(constructor) is { } file)
                return file;
        }

        return null;
    }

    private string? Document(MethodBase method)
    {
        try
        {
            if (Reader(method.Module.Assembly) is not { } reader)
                return null;

            var handle = (MethodDefinitionHandle)MetadataTokens.EntityHandle(method.MetadataToken);
            var info = reader.GetMethodDebugInformation(handle);
            var document = info.Document;
            if (document.IsNil)
            {
                foreach (var point in info.GetSequencePoints())
                {
                    if (point.IsHidden)
                        continue;
                    document = point.Document;
                    break;
                }
            }

            return document.IsNil ? null : reader.GetString(reader.GetDocument(document).Name);
        }
        catch (Exception e) when (e is BadImageFormatException or InvalidCastException or InvalidOperationException
                                      or ArgumentException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private MetadataReader? Reader(Assembly assembly)
    {
        if (!_pdbs.TryGetValue(assembly, out var provider))
        {
            _pdbs[assembly] = provider = null;
            if (!assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
            {
                using var image = new PEReader(File.OpenRead(assembly.Location));
                if (image.TryOpenAssociatedPortablePdb(
                        assembly.Location,
                        path => File.Exists(path) ? File.OpenRead(path) : null,
                        out var opened,
                        out _))
                {
                    _pdbs[assembly] = provider = opened;
                }
            }
        }

        return provider?.GetMetadataReader();
    }

    private string Relative(string document) => RepositoryRelative(_baseDirectory, document) ?? document.Replace('\\', '/');

    private static string? RepositoryRoot(string? contentRoot)
    {
        if (string.IsNullOrEmpty(contentRoot))
            return null;

        try
        {
            for (var directory = new DirectoryInfo(contentRoot); directory is not null; directory = directory.Parent)
            {
                var git = Path.Combine(directory.FullName, ".git");
                if (Directory.Exists(git) || File.Exists(git))
                    return directory.FullName;
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
        }

        return null;
    }

    public void Dispose()
    {
        foreach (var provider in _pdbs.Values)
            provider?.Dispose();
        _pdbs.Clear();
    }
}
