using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;

namespace PiwiTests.Instrumentation.Coverage;

/// <summary>
/// The coverage of one HTTP request: one payload per instrumented method it called, created on the method's first
/// call. A host starts recording into it with <see cref="PiwiCoverageRecorder.Begin"/>; work the request starts
/// (<c>Task.Run</c>, fire-and-forget tasks) inherits it and records into it too, until the request's coverage goes to
/// run level (<see cref="PiwiCoverageRecorder.AddToRunLevel"/>): from then on, that work records into the shared
/// payloads.
/// </summary>
public sealed class PiwiRequestCoverage
{
    // The approximate size of an array beyond its elements: object header, method table pointer and length.
    private const int ArrayOverhead = 24;

    private readonly object _lock = new();

    // By module index, then by method definition row.
    private bool[]?[]?[] _modules = new bool[]?[]?[PiwiCoverageRecorder.Modules.Count];
    private long _bytes;
    private int _closed;

    /// <summary>True once the request's coverage went to run level: nothing records into it any more.</summary>
    internal bool IsClosed => Volatile.Read(ref _closed) != 0;

    /// <summary>True once an instrumented method ran while this request was being served.</summary>
    public bool HasPayloads => Volatile.Read(ref _bytes) > 0;

    /// <summary>The approximate memory the request's payloads take, in bytes.</summary>
    public long ApproximateBytes => Volatile.Read(ref _bytes);

    /// <summary>Stops recording into this request: later calls record into the shared payloads.</summary>
    internal void Close() => Volatile.Write(ref _closed, 1);

    /// <summary>The payload of the method at <paramref name="row"/> of <paramref name="module"/> for this request.</summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    internal bool[] Payload(InstrumentedModule module, int row, int length)
    {
        var modules = Volatile.Read(ref _modules);
        var rows = module.Index < modules.Length ? modules[module.Index] : null;
        rows ??= Rows(module);
        if ((uint)row >= (uint)rows.Length)
            return new bool[length];

        return rows[row] ?? CreatePayload(rows, row, length);
    }

    /// <summary>Every payload the request recorded, with its module and method row.</summary>
    internal IEnumerable<(InstrumentedModule Module, int Row, bool[] Payload)> Payloads()
    {
        var modules = Volatile.Read(ref _modules);
        var known = PiwiCoverageRecorder.Modules;
        for (var index = 0; index < modules.Length && index < known.Count; index++)
        {
            if (Volatile.Read(ref modules[index]) is not { } rows)
                continue;

            for (var row = 1; row < rows.Length; row++)
            {
                if (Volatile.Read(ref rows[row]) is { } payload)
                    yield return (known[index], row, payload);
            }
        }
    }

    private bool[] CreatePayload(bool[]?[] rows, int row, int length)
    {
        var payload = new bool[length];
        var existing = Interlocked.CompareExchange(ref rows[row], payload, null);
        if (existing is not null)
            return existing;

        Interlocked.Add(ref _bytes, length + ArrayOverhead);
        return payload;
    }

    private bool[]?[] Rows(InstrumentedModule module)
    {
        lock (_lock)
        {
            var modules = _modules;
            if (module.Index >= modules.Length)
            {
                var grown = new bool[]?[]?[Math.Max(module.Index + 1, PiwiCoverageRecorder.Modules.Count)];
                Array.Copy(modules, grown, modules.Length);
                Volatile.Write(ref _modules, modules = grown);
            }

            if (modules[module.Index] is { } rows)
                return rows;

            rows = new bool[]?[module.MethodRows + 1];
            Interlocked.Add(ref _bytes, (long)rows.Length * IntPtr.Size + ArrayOverhead);
            Volatile.Write(ref modules[module.Index], rows);
            return rows;
        }
    }
}
