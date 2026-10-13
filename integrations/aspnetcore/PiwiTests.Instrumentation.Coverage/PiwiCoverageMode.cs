using System;

namespace PiwiTests.Instrumentation.Coverage;

/// <summary>How the recorder attributes coverage, read once from <c>PIWI_COVERAGE_MODE</c>.</summary>
public enum PiwiCoverageMode
{
    /// <summary>
    /// Per-test: each request records into its own payloads, and the code that runs outside a request into the
    /// shared ones. Every call to an instrumented method asks the recorder for its payload. The default.
    /// </summary>
    Test,

    /// <summary>
    /// Run-level only: every method records into one shared payload, which it keeps after its first call, so
    /// nothing is attributed to a request.
    /// </summary>
    Run,
}

internal static class PiwiCoverageModes
{
    internal const string Variable = "PIWI_COVERAGE_MODE";

    /// <summary><see cref="PiwiCoverageMode.Run"/> for <c>run</c> (any case), <see cref="PiwiCoverageMode.Test"/> otherwise.</summary>
    internal static PiwiCoverageMode Parse(string? value) =>
        string.Equals(value?.Trim(), "run", StringComparison.OrdinalIgnoreCase) ? PiwiCoverageMode.Run : PiwiCoverageMode.Test;
}
