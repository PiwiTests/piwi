using System;
using System.Collections.Generic;
using System.Text.Json;

namespace PiwiTests.Instrumentation.Coverage;

/// <summary>What a coverage report names: files, the functions that ran in them, or also the lines.</summary>
public enum PiwiCoverageGranularity
{
    /// <summary>The files whose code ran: <c>path</c> and <c>runtime</c> only.</summary>
    Files,

    /// <summary>The files, and the line range of each function that ran (<c>functions</c>).</summary>
    Functions,

    /// <summary>The files, the functions, and the line ranges that ran (<c>lines</c>).</summary>
    Lines,
}

/// <summary>
/// Turns recorded payloads into the coverage model: one entry per repository-relative file,
/// <c>{ "path", "runtime": "server", "functions"?: [[start, end]], "lines"?: [[start, end]], "executable"?: [[start, end]], "allFunctions"?: [[start, end]], "checksums"?: [string] }</c>,
/// with 1-based inclusive line ranges, sorted and merged. <c>allFunctions</c>, beside <c>executable</c>, is the
/// line range of every method, run or not. <c>checksums</c>, at the functions and lines
/// granularities, lists the checksums of the source the compiler read for the file (<c>sha256:&lt;hex&gt;</c>), one
/// per distinct version compiled into the instrumented modules, so a reader can check its line numbers against its
/// own copy of the file. A function is the line range of a method whose entry
/// marker is set; lines are those of its statements whose markers are set (see <see cref="InstrumentedModule.Lines"/>
/// for how a statement maps to lines).
/// </summary>
public sealed class PiwiCoverageReport
{
    private const string Runtime = "server";

    private readonly PiwiCoverageGranularity _granularity;
    private readonly Func<string, string?> _repositoryPath;
    private readonly Dictionary<(int Module, int Document), FileCoverage?> _documents = [];
    private readonly Dictionary<string, FileCoverage> _files = new(StringComparer.Ordinal);

    /// <param name="granularity">What the report names.</param>
    /// <param name="repositoryPath">
    /// Maps a source document path, as the compiler recorded it, to its path relative to the repository root
    /// (POSIX separators), or to null to leave the document out. Documents under an <c>obj/</c> directory are
    /// left out whatever it returns.
    /// </param>
    public PiwiCoverageReport(PiwiCoverageGranularity granularity, Func<string, string?> repositoryPath)
    {
        ArgumentNullException.ThrowIfNull(repositoryPath);
        _granularity = granularity;
        _repositoryPath = repositoryPath;
    }

    /// <summary>Adds the coverage <paramref name="request"/> recorded.</summary>
    public void AddRequest(PiwiRequestCoverage request)
    {
        ArgumentNullException.ThrowIfNull(request);
        foreach (var (module, row, payload) in request.Payloads())
            AddPayload(module, row, payload);
    }

    /// <summary>
    /// Adds the run-level coverage: the shared payloads, which hold the code that ran outside any request (startup,
    /// background work, lambdas created at startup), every call in <see cref="PiwiCoverageMode.Run"/> mode, and
    /// the requests added with <see cref="PiwiCoverageRecorder.AddToRunLevel"/>.
    /// </summary>
    public void AddRunLevel()
    {
        foreach (var module in PiwiCoverageRecorder.Modules)
        {
            for (var row = 1; row <= module.MethodRows; row++)
            {
                if (module.SharedPayloadOrNull(row) is { } payload)
                    AddPayload(module, row, payload);
            }
        }
    }

    /// <summary>
    /// At <see cref="PiwiCoverageGranularity.Lines"/>, adds the executable lines of every instrumented module
    /// (<c>executable</c>): the lines of every statement, whether it ran or not, in the modules whose code ran and
    /// in those whose code did not (the loaded assemblies built with coverage instrumentation, and those in the
    /// application's base directory), and the line range of every method (<c>allFunctions</c>). Does nothing at
    /// other granularities.
    /// </summary>
    public void AddExecutableLines()
    {
        if (_granularity != PiwiCoverageGranularity.Lines)
            return;

        PiwiCoverageRecorder.RegisterAvailable();

        foreach (var module in PiwiCoverageRecorder.Modules)
        {
            var lines = module.Lines;
            for (var row = 1; row < lines.Length; row++)
            {
                var entries = lines[row];
                if (entries.Length > 0 && entries[0].Ranges.Length > 0 && File(module, entries[0].Document) is { } method)
                    method.AllFunctions.Add(entries[0].Ranges[0]);
                for (var i = 1; i < entries.Length; i++)
                {
                    if (File(module, entries[i].Document) is { } file)
                        file.Executable.AddRange(entries[i].Ranges);
                }
            }
        }
    }

    /// <summary>Writes the report's files as a JSON array, sorted by path.</summary>
    public void WriteFiles(Utf8JsonWriter writer)
    {
        ArgumentNullException.ThrowIfNull(writer);
        var paths = new List<string>(_files.Keys);
        paths.Sort(StringComparer.Ordinal);

        writer.WriteStartArray();
        foreach (var path in paths)
        {
            var file = _files[path];
            if (!file.Executed && file.Executable.Count == 0 && file.AllFunctions.Count == 0)
                continue;

            writer.WriteStartObject();
            writer.WriteString("path", path);
            writer.WriteString("runtime", Runtime);
            if (_granularity != PiwiCoverageGranularity.Files)
                WriteRanges(writer, "functions", SortedFunctions(file.Functions));
            if (_granularity == PiwiCoverageGranularity.Lines)
            {
                WriteRanges(writer, "lines", Merge(file.Lines));
                if (file.Executable.Count > 0)
                    WriteRanges(writer, "executable", Merge(file.Executable));
                if (file.AllFunctions.Count > 0)
                    WriteRanges(writer, "allFunctions", SortedFunctions(file.AllFunctions));
            }

            if (_granularity != PiwiCoverageGranularity.Files && file.Checksums.Count > 0)
            {
                var checksums = new List<string>(file.Checksums);
                checksums.Sort(StringComparer.Ordinal);
                writer.WriteStartArray("checksums");
                foreach (var checksum in checksums)
                    writer.WriteStringValue(checksum);
                writer.WriteEndArray();
            }

            writer.WriteEndObject();
        }

        writer.WriteEndArray();
    }

    private void AddPayload(InstrumentedModule module, int row, bool[] payload)
    {
        var lines = module.Lines;
        if (row <= 0 || row >= lines.Length)
            return;

        var entries = lines[row];
        var count = Math.Min(entries.Length, payload.Length);
        if (count > 0 && payload[0] && File(module, entries[0].Document) is { } function)
        {
            function.Executed = true;
            function.Functions.Add(entries[0].Ranges[0]);
        }

        for (var i = 1; i < count; i++)
        {
            if (!payload[i] || File(module, entries[i].Document) is not { } file)
                continue;

            file.Executed = true;
            file.Lines.AddRange(entries[i].Ranges);
        }
    }

    private FileCoverage? File(InstrumentedModule module, int document)
    {
        var key = (module.Index, document);
        if (_documents.TryGetValue(key, out var file))
            return file;

        var path = RepositoryPath(module.Spans.Documents[document]);
        if (path is not null && !_files.TryGetValue(path, out file))
            _files[path] = file = new FileCoverage();
        if (file is not null && module.Spans.Checksums[document] is { } checksum)
            file.Checksums.Add(checksum);

        _documents[key] = file;
        return file;
    }

    private string? RepositoryPath(string document)
    {
        var path = _repositoryPath(document)?.Replace('\\', '/');
        if (string.IsNullOrEmpty(path) || path.StartsWith("obj/", StringComparison.Ordinal) ||
            path.Contains("/obj/", StringComparison.Ordinal))
            return null;

        return path;
    }

    private static List<LineRange> SortedFunctions(HashSet<LineRange> functions)
    {
        var sorted = new List<LineRange>(functions);
        sorted.Sort((a, b) => a.Start != b.Start ? a.Start.CompareTo(b.Start) : a.End.CompareTo(b.End));
        return sorted;
    }

    /// <summary>Sorts <paramref name="ranges"/> and merges the ones that overlap or touch.</summary>
    internal static List<LineRange> Merge(List<LineRange> ranges)
    {
        ranges.Sort((a, b) => a.Start.CompareTo(b.Start));
        var merged = new List<LineRange>(ranges.Count);
        foreach (var range in ranges)
        {
            if (merged.Count > 0 && range.Start <= merged[^1].End + 1)
            {
                if (range.End > merged[^1].End)
                    merged[^1] = merged[^1] with { End = range.End };
            }
            else
            {
                merged.Add(range);
            }
        }

        return merged;
    }

    private static void WriteRanges(Utf8JsonWriter writer, string name, List<LineRange> ranges)
    {
        writer.WriteStartArray(name);
        foreach (var range in ranges)
        {
            writer.WriteStartArray();
            writer.WriteNumberValue(range.Start);
            writer.WriteNumberValue(range.End);
            writer.WriteEndArray();
        }

        writer.WriteEndArray();
    }

    private sealed class FileCoverage
    {
        public bool Executed;
        public readonly HashSet<LineRange> Functions = [];
        public readonly List<LineRange> Lines = [];
        public readonly List<LineRange> Executable = [];
        public readonly HashSet<LineRange> AllFunctions = [];
        public readonly HashSet<string> Checksums = new(StringComparer.Ordinal);
    }
}
