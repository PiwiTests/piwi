using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Threading;

namespace PiwiTests.Instrumentation.Coverage;

/// <summary>
/// Decides which payload an instrumented method records into. The compiler's instrumentation calls
/// <c>Microsoft.CodeAnalysis.Runtime.Instrumentation.CreatePayload</c>, which lands here: in
/// <see cref="PiwiCoverageMode.Test"/> mode the method records into the payload of the request being served
/// (<see cref="Begin"/>), or into its shared payload outside a request; in <see cref="PiwiCoverageMode.Run"/>
/// mode always into its shared payload, which it keeps for every later call.
/// </summary>
/// <remarks>
/// The request being served is an <see cref="AsyncLocal{T}"/> mirrored into a thread-static field on every
/// execution context change, so the per-call read is a thread-static load. Instrumented modules are registered
/// on their first call, by module version id: the recorder finds the loaded assembly and reads its span table
/// once. <see cref="RegisterAvailable"/> registers the others, whose code has not run, for their executable lines.
/// With <c>PIWI_COVERAGE_OUTPUT</c> set, the first call also arranges for the run-level report to be written at
/// process exit (<see cref="PiwiCoverageOutput"/>).
/// </remarks>
public static class PiwiCoverageRecorder
{
    private static readonly PiwiCoverageMode s_mode = PiwiCoverageModes.Parse(Environment.GetEnvironmentVariable(PiwiCoverageModes.Variable));

    private static readonly AsyncLocal<PiwiRequestCoverage?> s_request = new(OnRequestChanged);

    [ThreadStatic]
    private static PiwiRequestCoverage? t_request;

    [ThreadStatic]
    private static InstrumentedModule? t_lastModule;

    private static readonly object s_lock = new();
    private static readonly HashSet<Guid> s_untracked = [];
    private static readonly Dictionary<string, (long Length, DateTime Written)> s_scannedFiles = new(StringComparer.Ordinal);
    private static InstrumentedModule[] s_modules = [];
    private static int s_ran;

    /// <summary>The mode set by <c>PIWI_COVERAGE_MODE</c>: <c>run</c>, or <c>test</c> (the default).</summary>
    public static PiwiCoverageMode Mode => s_mode;

    /// <summary>True once code from a module built with coverage instrumentation has run in this process.</summary>
    public static bool HasInstrumentedModules => Volatile.Read(ref s_ran) != 0;

    /// <summary>The instrumented modules registered so far, by index.</summary>
    internal static IReadOnlyList<InstrumentedModule> Modules => Volatile.Read(ref s_modules);

    /// <summary>
    /// Records the coverage of the current execution context, and of the work it starts, into
    /// <paramref name="request"/> until <see cref="End"/>.
    /// </summary>
    public static void Begin(PiwiRequestCoverage request)
    {
        ArgumentNullException.ThrowIfNull(request);
        s_request.Value = request;
    }

    /// <summary>Stops recording into the request <see cref="Begin"/> set for the current execution context.</summary>
    public static void End() => s_request.Value = null;

    /// <summary>
    /// Adds the coverage <paramref name="request"/> recorded to the shared payloads, so it counts at run level
    /// once the request is no longer kept on its own.
    /// </summary>
    public static void AddToRunLevel(PiwiRequestCoverage request)
    {
        ArgumentNullException.ThrowIfNull(request);
        foreach (var (module, row, payload) in request.Payloads())
            module.AddToShared(row, payload);
    }

    /// <summary>
    /// Registers every instrumented module of this process, whether its code ran or not: the loaded assemblies
    /// carrying a span table, and the assemblies in the application's base directory, read from disk without
    /// loading them. A file read once is read again only when its size or write time changes.
    /// </summary>
    internal static void RegisterAvailable() => RegisterAvailable(AppContext.BaseDirectory);

    /// <inheritdoc cref="RegisterAvailable()"/>
    /// <param name="directory">The directory whose assemblies are read from disk.</param>
    internal static void RegisterAvailable(string? directory)
    {
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (assembly.IsDynamic)
                continue;

            try
            {
                var mvid = assembly.ManifestModule.ModuleVersionId;
                if (!IsKnown(mvid))
                    Add(mvid, SpanTable.Read(assembly));
            }
            catch (Exception e) when (IsUnreadable(e))
            {
                // An assembly whose span table cannot be read has no executable lines.
            }
        }

        if (string.IsNullOrEmpty(directory))
            return;

        string[] files;
        try
        {
            files = Directory.GetFiles(directory, "*.dll", SearchOption.TopDirectoryOnly);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return;
        }

        Array.Sort(files, StringComparer.Ordinal);
        foreach (var file in files)
        {
            try
            {
                var info = new FileInfo(file);
                var stamp = (info.Length, info.LastWriteTimeUtc);
                lock (s_lock)
                {
                    if (s_scannedFiles.TryGetValue(file, out var scanned) && scanned == stamp)
                        continue;
                    s_scannedFiles[file] = stamp;
                }

                var spans = SpanTable.ReadFile(file, out var mvid);
                if (mvid != Guid.Empty && !IsKnown(mvid))
                    Add(mvid, spans);
            }
            catch (Exception e) when (IsUnreadable(e) || e is UnauthorizedAccessException)
            {
                // Not an assembly, or one whose span table cannot be read: no executable lines.
            }
        }
    }

    internal static bool[] Payload(Guid mvid, int row, ref bool[] slot, int length) =>
        Payload(mvid, row, ref slot, length, s_mode);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    internal static bool[] Payload(Guid mvid, int row, ref bool[] slot, int length, PiwiCoverageMode mode)
    {
        var module = Module(mvid);

        // A module without a readable span table keeps a payload nobody reads, and never calls back.
        if (module is null)
            return slot = new bool[length];

        if (mode == PiwiCoverageMode.Run)
            return slot = module.SharedPayload(row, length);

        var request = t_request;
        return request is null ? module.SharedPayload(row, length) : request.Payload(module, row, length);
    }

    private static void OnRequestChanged(AsyncLocalValueChangedArgs<PiwiRequestCoverage?> args) => t_request = args.CurrentValue;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static InstrumentedModule? Module(Guid mvid)
    {
        var last = t_lastModule;
        if (last is not null && last.Mvid == mvid)
            return last;

        var module = Find(mvid) ?? Register(mvid);
        if (module is not null && Volatile.Read(ref s_ran) == 0)
        {
            Volatile.Write(ref s_ran, 1);
            PiwiCoverageOutput.Arm();
        }

        return t_lastModule = module;
    }

    private static InstrumentedModule? Find(Guid mvid)
    {
        foreach (var module in Volatile.Read(ref s_modules))
        {
            if (module.Mvid == mvid)
                return module;
        }

        return null;
    }

    private static InstrumentedModule? Register(Guid mvid)
    {
        lock (s_lock)
        {
            if (Find(mvid) is { } known)
                return known;
            if (s_untracked.Contains(mvid))
                return null;

            return Add(mvid, ReadSpanTable(mvid));
        }
    }

    private static bool IsKnown(Guid mvid)
    {
        lock (s_lock)
            return Find(mvid) is not null || s_untracked.Contains(mvid);
    }

    /// <summary>Registers the module <paramref name="mvid"/> with its span table, or as untracked without one.</summary>
    private static InstrumentedModule? Add(Guid mvid, SpanTable? spans)
    {
        lock (s_lock)
        {
            if (Find(mvid) is { } known)
                return known;
            if (spans is null)
            {
                s_untracked.Add(mvid);
                return null;
            }

            var modules = s_modules;
            var module = new InstrumentedModule(mvid, modules.Length, spans);
            Volatile.Write(ref s_modules, [.. modules, module]);
            return module;
        }
    }

    private static bool IsUnreadable(Exception e) =>
        e is BadImageFormatException or NotSupportedException or InvalidOperationException or IOException or ArgumentException;

    private static SpanTable? ReadSpanTable(Guid mvid)
    {
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (assembly.IsDynamic)
                continue;

            try
            {
                if (assembly.ManifestModule.ModuleVersionId != mvid)
                    continue;

                return SpanTable.Read(assembly);
            }
            catch (Exception e) when (IsUnreadable(e))
            {
                return null;
            }
        }

        return null;
    }
}
