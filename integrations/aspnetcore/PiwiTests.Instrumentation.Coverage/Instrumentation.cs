using System;
using PiwiTests.Instrumentation.Coverage;

namespace Microsoft.CodeAnalysis.Runtime;

/// <summary>
/// The type the C# and Visual Basic compilers call from code built with <c>-instrument:TestCoverage</c> (the
/// <c>Instrument</c> MSBuild property). An instrumented method whose payload slot is empty calls
/// <c>CreatePayload</c> for the <c>bool[]</c> its entry and statement markers write into; the compiler finds this
/// type by name among the compilation's references.
/// </summary>
public static class Instrumentation
{
    /// <summary>The payload of a method whose spans are all in one document.</summary>
    /// <param name="mvid">The module version id of the method's module.</param>
    /// <param name="methodToken">The method's definition row.</param>
    /// <param name="fileIndex">The document index of the method's spans.</param>
    /// <param name="payload">The method's payload slot, filled when the payload is kept for every later call.</param>
    /// <param name="payloadLength">The number of spans: the method entry, then each statement.</param>
    public static bool[] CreatePayload(Guid mvid, int methodToken, int fileIndex, ref bool[] payload, int payloadLength) =>
        PiwiCoverageRecorder.Payload(mvid, methodToken, ref payload, payloadLength);

    /// <summary>The payload of a method whose spans are in several documents.</summary>
    /// <param name="mvid">The module version id of the method's module.</param>
    /// <param name="methodToken">The method's definition row.</param>
    /// <param name="fileIndices">The document indices of the method's spans.</param>
    /// <param name="payload">The method's payload slot, filled when the payload is kept for every later call.</param>
    /// <param name="payloadLength">The number of spans: the method entry, then each statement.</param>
    public static bool[] CreatePayload(Guid mvid, int methodToken, int[] fileIndices, ref bool[] payload, int payloadLength) =>
        PiwiCoverageRecorder.Payload(mvid, methodToken, ref payload, payloadLength);
}
