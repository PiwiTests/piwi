using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using PiwiTests.Instrumentation.Coverage;
using PiwiTests.Instrumentation.CoverageFixture;
using Xunit;
using static PiwiTests.Instrumentation.Tests.FixtureSource;

namespace PiwiTests.Instrumentation.Tests;

public class CoverageRecorderTests
{
    private static readonly Assembly Fixture = typeof(Quotes).Assembly;
    private static readonly Guid FixtureMvid = Fixture.ManifestModule.ModuleVersionId;

    [Fact]
    public void Reads_the_documents_and_method_spans_the_compiler_embeds()
    {
        var table = SpanTable.Read(Fixture)!;

        Assert.Contains(table.Documents, d => d.Replace('\\', '/').EndsWith("/" + Path("Quotes.cs"), StringComparison.Ordinal));
        var spans = table.Spans(Row(typeof(Quotes).GetMethod(nameof(Quotes.Quote))!));
        Assert.All(spans, s => Assert.EndsWith("Quotes.cs", table.Documents[s.Document]));
        Assert.Equal(Function("Quotes.cs", "public static IResult Quote("), new[] { spans[0].StartLine + 1, spans[0].EndLine + 1 });
        Assert.Equal(
            [
                Line("Quotes.cs", "var prices = new PriceList(2.5m);"),
                Line("Quotes.cs", "var total = prices.Total(quantity);"),
                Line("Quotes.cs", "return Results.Ok(new { quantity, total });"),
            ],
            spans.Skip(1).Select(s => s.StartLine + 1).Order());
    }

    [Fact]
    public void Reads_no_span_table_from_an_assembly_built_without_instrumentation()
    {
        Assert.Null(SpanTable.Read(typeof(CoverageRecorderTests).Assembly));
    }

    [Theory]
    [InlineData(0, 3)]
    [InlineData(1, 0)]
    [InlineData(0, 0)]
    public void Refuses_span_table_versions_other_than_0_1_and_0_2(byte major, byte minor)
    {
        var data = Encoding.ASCII.GetBytes("DAMD").Concat(new[] { major, minor }).Concat(new byte[16]).ToArray();

        Assert.Throws<NotSupportedException>(() => SpanTable.Parse(data));
    }

    [Fact]
    public void Refuses_a_resource_that_is_not_a_span_table()
    {
        Assert.Throws<BadImageFormatException>(() => SpanTable.Parse(Encoding.ASCII.GetBytes("DAMX\0\u0002")));
    }

    [Fact]
    public void Maps_a_primary_constructor_statement_spanning_the_type_to_its_first_line()
    {
        var module = new InstrumentedModule(FixtureMvid, 0, SpanTable.Read(Fixture)!);

        var constructor = module.Lines[Row(typeof(PriceList).GetConstructors().Single())];

        Assert.Equal(Function("PriceList.cs", "public sealed class PriceList("), new[] { constructor[0].Ranges[0].Start, constructor[0].Ranges[0].End });
        Assert.Equal(
            [
                Line("PriceList.cs", "public sealed class PriceList("),
                Line("PriceList.cs", "private readonly decimal _discount = 0.1m;"),
            ],
            constructor.Skip(1).SelectMany(s => s.Ranges).SelectMany(r => Enumerable.Range(r.Start, r.End - r.Start + 1)).Order());
    }

    [Fact]
    public void Maps_a_statement_declaring_a_lambda_to_the_lines_outside_the_lambdas_statements()
    {
        var module = new InstrumentedModule(FixtureMvid, 0, SpanTable.Read(Fixture)!);
        var first = Line("Squares.cs", "var squares = Enumerable.Range(1, count)");
        var last = Line("Squares.cs", ".ToArray();");
        var lambda = new[] { Line("Squares.cs", "var square = i * i;"), Line("Squares.cs", "return square;") };

        var statements = module.Lines[Row(typeof(Squares).GetMethod(nameof(Squares.Handle))!)].Skip(1).ToArray();

        var declaring = Assert.Single(statements, s => s.Ranges[0].Start == first);
        Assert.Equal(
            Enumerable.Range(first, last - first + 1).Except(lambda),
            declaring.Ranges.SelectMany(r => Enumerable.Range(r.Start, r.End - r.Start + 1)));
        Assert.All(lambda, line => Assert.Contains(statements, s => s.Ranges is [{ Start: var start, End: var end }] && start == line && end == line));
    }

    [Fact]
    public void Run_mode_keeps_the_shared_payload_in_the_method_slot()
    {
        var row = Row(typeof(Checks).GetMethod(nameof(Checks.Handle))!);
        var length = SpanTable.Read(Fixture)!.Spans(row).Length;
        bool[] slot = null!;

        var payload = PiwiCoverageRecorder.Payload(FixtureMvid, row, ref slot, length, PiwiCoverageMode.Run);

        Assert.Same(payload, slot);
        Assert.Same(payload, FixtureModule().SharedPayloadOrNull(row));
        Assert.True(PiwiCoverageRecorder.HasInstrumentedModules);
    }

    [Fact]
    public void Test_mode_returns_the_payload_of_the_request_being_served_and_leaves_the_slot_empty()
    {
        var row = Row(typeof(Checks).GetMethod(nameof(Checks.Handle))!);
        var length = SpanTable.Read(Fixture)!.Spans(row).Length;
        var request = new PiwiRequestCoverage();
        bool[] slot = null!;

        PiwiCoverageRecorder.Begin(request);
        bool[] inside, again;
        try
        {
            inside = PiwiCoverageRecorder.Payload(FixtureMvid, row, ref slot, length, PiwiCoverageMode.Test);
            again = PiwiCoverageRecorder.Payload(FixtureMvid, row, ref slot, length, PiwiCoverageMode.Test);
        }
        finally
        {
            PiwiCoverageRecorder.End();
        }

        var outside = PiwiCoverageRecorder.Payload(FixtureMvid, row, ref slot, length, PiwiCoverageMode.Test);

        Assert.Null(slot);
        Assert.Same(inside, again);
        Assert.NotSame(inside, outside);
        Assert.Same(outside, FixtureModule().SharedPayloadOrNull(row));
        Assert.True(request.HasPayloads);
        Assert.Contains(request.Payloads(), p => p.Row == row && ReferenceEquals(p.Payload, inside));
    }

    [Fact]
    public async Task Records_the_work_a_request_starts_with_Task_Run_into_the_request()
    {
        var request = new PiwiRequestCoverage();

        PiwiCoverageRecorder.Begin(request);
        try
        {
            await Task.Run(() => Totals.Compute(3));
        }
        finally
        {
            PiwiCoverageRecorder.End();
        }

        var compute = Row(typeof(Totals).GetMethod(nameof(Totals.Compute))!);
        var payload = Assert.Single(request.Payloads(), p => p.Row == compute).Payload;
        Assert.All(payload, Assert.True);
    }

    [Fact]
    public void Adds_a_request_to_the_run_level_coverage()
    {
        var request = new PiwiRequestCoverage();
        PiwiCoverageRecorder.Begin(request);
        try
        {
            new PriceList(1m).Refund(2);
        }
        finally
        {
            PiwiCoverageRecorder.End();
        }

        var refund = Row(typeof(PriceList).GetMethod(nameof(PriceList.Refund))!);
        Assert.Null(FixtureModule().SharedPayloadOrNull(refund));

        PiwiCoverageRecorder.AddToRunLevel(request);

        Assert.All(FixtureModule().SharedPayloadOrNull(refund)!, Assert.True);
    }

    [Fact]
    public void Reads_the_mode_from_its_variable()
    {
        Assert.Equal(PiwiCoverageMode.Run, PiwiCoverageModes.Parse(" Run "));
        Assert.Equal(PiwiCoverageMode.Test, PiwiCoverageModes.Parse("test"));
        Assert.Equal(PiwiCoverageMode.Test, PiwiCoverageModes.Parse(null));
        Assert.Equal(PiwiCoverageMode.Test, PiwiCoverageModes.Parse("lines"));
    }

    private static int Row(MethodBase method) => method.MetadataToken & 0x00FFFFFF;

    private static InstrumentedModule FixtureModule() => Assert.Single(PiwiCoverageRecorder.Modules, m => m.Mvid == FixtureMvid);
}
