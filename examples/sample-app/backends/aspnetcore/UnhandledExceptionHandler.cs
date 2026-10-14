using Microsoft.AspNetCore.Diagnostics;

namespace SampleApp;

/// <summary>
/// Answers an unhandled exception with a 500 problem details response, and logs it first: an error logged before the
/// response starts rides on its X-Piwi-Logs header.
/// </summary>
public sealed class UnhandledExceptionHandler(IProblemDetailsService problems, ILogger<UnhandledExceptionHandler> logger)
    : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken cancellationToken)
    {
        logger.LogError(exception, "Unhandled exception on {Method} {Path}", context.Request.Method, context.Request.Path);
        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        return await problems.TryWriteAsync(new ProblemDetailsContext { HttpContext = context, Exception = exception });
    }
}
