using System;
using System.Collections.Generic;
using Microsoft.Extensions.Hosting;

namespace PiwiTests.Instrumentation.AspNetCore;

/// <summary>
/// The environments the Piwi test log middleware is active in, and the commit the server reports, set once with
/// <c>services.AddPiwiTestLogs(o => ...)</c>. An argument passed to <c>UsePiwiTestLogs</c> takes
/// precedence over the environments; <c>PIWI_TEST_LOGS_DISABLED</c> overrides everything.
/// </summary>
public sealed class PiwiTestLogsOptions
{
    /// <summary>
    /// Environment names the middleware is active in, matched case-insensitively. Empty (the
    /// default) falls back to the comma-separated <c>PIWI_TEST_LOGS_ENVIRONMENTS</c> environment
    /// variable, then to Development and Test.
    /// </summary>
    public IList<string> Environments { get; } = new List<string>();

    /// <summary>
    /// Decides whether the middleware is active in an environment. Takes precedence over
    /// <see cref="Environments"/> when set.
    /// </summary>
    public Func<IHostEnvironment, bool>? IsActive { get; set; }

    /// <summary>
    /// The commit the application was built from, served as <c>appCommit</c> at <c>/__piwi/environment</c> so the
    /// dashboard knows which version of the application a run tested. Unset (the default) falls back to the
    /// <c>PIWI_APP_COMMIT</c> environment variable, then to the source revision the .NET SDK writes into the entry
    /// assembly's informational version. Kept only when it is 7 to 40 hexadecimal characters.
    /// </summary>
    public string? AppCommit { get; set; }

    /// <summary>How the middleware serves server coverage; the defaults come from the coverage recorder.</summary>
    internal PiwiCoverageSettings Coverage { get; set; } = new();
}
