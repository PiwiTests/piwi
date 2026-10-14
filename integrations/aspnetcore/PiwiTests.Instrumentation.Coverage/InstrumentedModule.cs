using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;

namespace PiwiTests.Instrumentation.Coverage;

/// <summary>A range of source lines: 1-based, inclusive.</summary>
internal readonly record struct LineRange(int Start, int End);

/// <summary>The lines a payload entry stands for, in one span table document.</summary>
internal readonly record struct SpanLines(int Document, LineRange[] Ranges);

/// <summary>
/// A module built with coverage instrumentation, known by its module version id: its span table, and the
/// shared payloads that hold its run-level coverage.
/// </summary>
internal sealed class InstrumentedModule
{
    private readonly bool[]?[] _shared;
    private SpanLines[][]? _lines;

    internal InstrumentedModule(Guid mvid, int index, SpanTable spans)
    {
        Mvid = mvid;
        Index = index;
        Spans = spans;
        _shared = new bool[]?[spans.MethodRows + 1];
    }

    internal Guid Mvid { get; }

    /// <summary>The module's position in the recorder's module list.</summary>
    internal int Index { get; }

    internal SpanTable Spans { get; }

    /// <summary>The number of method definition rows, the size of a per-method payload table.</summary>
    internal int MethodRows => Spans.MethodRows;

    /// <summary>The shared payload of the method at <paramref name="row"/>, created on first use.</summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    internal bool[] SharedPayload(int row, int length)
    {
        if ((uint)row >= (uint)_shared.Length)
            return new bool[length];

        return _shared[row] ?? CreateSharedPayload(row, length);
    }

    /// <summary>The shared payload of the method at <paramref name="row"/>, or null when it has none.</summary>
    internal bool[]? SharedPayloadOrNull(int row) => (uint)row < (uint)_shared.Length ? Volatile.Read(ref _shared[row]) : null;

    /// <summary>Sets in the shared payload of the method at <paramref name="row"/> every entry <paramref name="payload"/> has set.</summary>
    internal void AddToShared(int row, bool[] payload)
    {
        var shared = SharedPayload(row, payload.Length);
        var length = Math.Min(shared.Length, payload.Length);
        for (var i = 0; i < length; i++)
        {
            if (payload[i])
                shared[i] = true;
        }
    }

    /// <summary>
    /// The lines each payload entry stands for, by method row then entry. Entry 0 is the method's own span, the
    /// function. Entries 1 to n are its statements, each standing for the lines of its span, except:
    /// <list type="bullet">
    /// <item>a statement span that encloses another method's span in the same document (a primary constructor
    /// spans the whole type) stands for its first line only;</item>
    /// <item>a statement span that encloses other spans of its own method (the statements of a lambda it
    /// declares) stands for its first line and the lines those spans do not cover.</item>
    /// </list>
    /// </summary>
    internal SpanLines[][] Lines => LazyInitializer.EnsureInitialized(ref _lines, () => BuildLines(Spans));

    private bool[] CreateSharedPayload(int row, int length) =>
        Interlocked.CompareExchange(ref _shared[row], new bool[length], null) ?? _shared[row]!;

    private static SpanLines[][] BuildLines(SpanTable table)
    {
        // The span 0 of every method, per document, sorted by start position.
        var methodSpans = new List<(SourceSpan Span, int Row)>?[table.Documents.Count];
        for (var row = 1; row <= table.MethodRows; row++)
        {
            var spans = table.Spans(row);
            if (spans.Length > 0)
                (methodSpans[spans[0].Document] ??= []).Add((spans[0], row));
        }

        foreach (var list in methodSpans)
            list?.Sort((a, b) => Compare(a.Span.StartLine, a.Span.StartColumn, b.Span.StartLine, b.Span.StartColumn));

        var lines = new SpanLines[table.MethodRows + 1][];
        lines[0] = [];
        for (var row = 1; row <= table.MethodRows; row++)
        {
            var spans = table.Spans(row);
            var methodLines = new SpanLines[spans.Length];
            for (var i = 0; i < spans.Length; i++)
                methodLines[i] = new SpanLines(spans[i].Document, StatementLines(spans, i, row, methodSpans[spans[i].Document]));

            lines[row] = methodLines;
        }

        return lines;
    }

    private static LineRange[] StatementLines(SourceSpan[] spans, int index, int row, List<(SourceSpan Span, int Row)>? methodSpans)
    {
        var span = spans[index];
        var first = span.StartLine + 1;
        var last = span.EndLine + 1;
        if (index == 0 || first == last)
            return [new LineRange(first, last)];

        if (EnclosesAnotherMethod(span, row, methodSpans))
            return [new LineRange(first, first)];

        // Lines of the statement covered by its own method's other spans, nested in it.
        var covered = new bool[last - first + 1];
        var nested = false;
        for (var j = 0; j < spans.Length; j++)
        {
            var other = spans[j];
            if (j == index || other.Document != span.Document || !Encloses(span, other))
                continue;

            nested = true;
            for (var line = other.StartLine + 1; line <= other.EndLine + 1; line++)
                covered[line - first] = true;
        }

        if (!nested)
            return [new LineRange(first, last)];

        covered[0] = false;
        var ranges = new List<LineRange>();
        for (var line = first; line <= last; line++)
        {
            if (covered[line - first])
                continue;
            if (ranges.Count > 0 && ranges[^1].End == line - 1)
                ranges[^1] = ranges[^1] with { End = line };
            else
                ranges.Add(new LineRange(line, line));
        }

        return [.. ranges];
    }

    private static bool EnclosesAnotherMethod(SourceSpan span, int row, List<(SourceSpan Span, int Row)>? methodSpans)
    {
        if (methodSpans is null)
            return false;

        // The first method span starting at or after the statement's start.
        int low = 0, high = methodSpans.Count;
        while (low < high)
        {
            var middle = (low + high) / 2;
            var start = methodSpans[middle].Span;
            if (Compare(start.StartLine, start.StartColumn, span.StartLine, span.StartColumn) < 0)
                low = middle + 1;
            else
                high = middle;
        }

        for (var i = low; i < methodSpans.Count; i++)
        {
            var (method, methodRow) = methodSpans[i];
            if (Compare(method.StartLine, method.StartColumn, span.EndLine, span.EndColumn) > 0)
                break;
            if (methodRow != row && Encloses(span, method))
                return true;
        }

        return false;
    }

    private static bool Encloses(SourceSpan outer, SourceSpan inner) =>
        Compare(outer.StartLine, outer.StartColumn, inner.StartLine, inner.StartColumn) <= 0 &&
        Compare(inner.EndLine, inner.EndColumn, outer.EndLine, outer.EndColumn) <= 0;

    private static int Compare(int line, int column, int otherLine, int otherColumn) =>
        line != otherLine ? line.CompareTo(otherLine) : column.CompareTo(otherColumn);
}
