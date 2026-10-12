using System;
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
/// portable PDB (embedded, or the <c>.pdb</c> next to the assembly). Paths are relative to the
/// repository root (the nearest directory above the content root holding <c>.git</c>), else to
/// the content root; a deterministic build's <c>/_/</c> source root is read as the repository
/// root. Anything it cannot read resolves to null.
/// </summary>
internal sealed class PiwiSourceFiles : IDisposable
{
    private const string DeterministicSourceRoot = "/_/";

    private readonly string? _baseDirectory;
    private readonly Dictionary<Assembly, MetadataReaderProvider?> _pdbs = [];

    internal PiwiSourceFiles(string? contentRoot)
    {
        _baseDirectory = RepositoryRoot(contentRoot) ?? contentRoot;
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

    private string Relative(string document)
    {
        var path = document.Replace('\\', '/');
        if (path.StartsWith(DeterministicSourceRoot, StringComparison.Ordinal))
            return path[DeterministicSourceRoot.Length..];

        if (_baseDirectory is not null && Path.IsPathRooted(document))
        {
            var relative = Path.GetRelativePath(_baseDirectory, document);
            if (!Path.IsPathRooted(relative) && relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                return relative.Replace('\\', '/');
        }

        return path;
    }

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
