using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Text;

namespace PiwiTests.Instrumentation.Coverage;

/// <summary>A span of source: its document index in the span table, and 0-based start and end line and column.</summary>
internal readonly record struct SourceSpan(int Document, int StartLine, int StartColumn, int EndLine, int EndColumn);

/// <summary>
/// The span table the C# and Visual Basic compilers embed as the <c>&lt;DynamicAnalysisData&gt;</c> manifest
/// resource when they build with <c>-instrument:TestCoverage</c>: the source documents, and for each method
/// definition row the spans its payload entries stand for. Span 0 is the whole method, spans 1 to n its
/// statements, in payload order.
/// </summary>
/// <remarks>
/// The layout follows Roslyn's <c>DynamicAnalysisDataReader</c>
/// (<c>src/Compilers/Test/Core/Metadata/DynamicAnalysisDataReader.cs</c>, MIT, .NET Foundation): a <c>DAMD</c>
/// header and version, the document and method tables, then the heaps. Versions 0.1 and 0.2 are read; any other
/// version is refused.
/// </remarks>
internal sealed class SpanTable
{
    internal const string ResourceName = "<DynamicAnalysisData>";

    private const int GuidSize = 16;

    private readonly SourceSpan[][] _methods;

    private SpanTable(string[] documents, SourceSpan[][] methods)
    {
        Documents = documents;
        _methods = methods;
    }

    /// <summary>The source document paths, as the compiler recorded them.</summary>
    internal IReadOnlyList<string> Documents { get; }

    /// <summary>The number of method definition rows; rows run from 1 to this number.</summary>
    internal int MethodRows => _methods.Length - 1;

    /// <summary>The spans of the method at definition row <paramref name="row"/>, empty for a method with none.</summary>
    internal SourceSpan[] Spans(int row) => row > 0 && row < _methods.Length ? _methods[row] : [];

    /// <summary>
    /// Reads the span table of <paramref name="assembly"/>, or null when it has none (it was not built with
    /// coverage instrumentation).
    /// </summary>
    /// <exception cref="NotSupportedException">The span table has a format version other than 0.1 or 0.2.</exception>
    /// <exception cref="BadImageFormatException">The span table is malformed.</exception>
    internal static SpanTable? Read(Assembly assembly)
    {
        using var stream = assembly.GetManifestResourceStream(ResourceName);
        if (stream is null)
            return null;

        var data = new byte[stream.Length];
        stream.ReadExactly(data);
        return Parse(data);
    }

    /// <summary>Parses the content of a <c>&lt;DynamicAnalysisData&gt;</c> resource.</summary>
    internal static unsafe SpanTable Parse(byte[] data)
    {
        fixed (byte* start = data)
        {
            var reader = new BlobReader(start, data.Length);
            if (reader.ReadByte() != 'D' || reader.ReadByte() != 'A' || reader.ReadByte() != 'M' || reader.ReadByte() != 'D')
                throw new BadImageFormatException("Not a dynamic analysis data blob.");

            var major = reader.ReadByte();
            var minor = reader.ReadByte();
            if (major != 0 || minor < 1 || minor > 2)
                throw new NotSupportedException($"Unsupported dynamic analysis data version {major}.{minor}.");

            var documentCount = reader.ReadInt32();
            var methodCount = reader.ReadInt32();
            var stringHeapSize = minor == 1 ? reader.ReadInt32() : 0;
            var userStringHeapSize = minor == 1 ? reader.ReadInt32() : 0;
            var guidHeapSize = reader.ReadInt32();
            var blobHeapSize = reader.ReadInt32();
            if (documentCount < 0 || methodCount < 0 || stringHeapSize < 0 || userStringHeapSize < 0 ||
                guidHeapSize < 0 || blobHeapSize < 0)
                throw new BadImageFormatException("Negative table or heap size.");

            var smallBlobReferences = blobHeapSize <= ushort.MaxValue;
            var smallGuidReferences = guidHeapSize / GuidSize <= ushort.MaxValue;

            var documentNames = new int[documentCount];
            for (var i = 0; i < documentCount; i++)
            {
                documentNames[i] = ReadReference(ref reader, smallBlobReferences);
                ReadReference(ref reader, smallGuidReferences);
                ReadReference(ref reader, smallBlobReferences);
            }

            var methodBlobs = new int[methodCount];
            for (var i = 0; i < methodCount; i++)
                methodBlobs[i] = ReadReference(ref reader, smallBlobReferences);

            var blobHeapOffset = reader.Offset + stringHeapSize + userStringHeapSize + guidHeapSize;
            if (reader.Length != blobHeapOffset + blobHeapSize)
                throw new BadImageFormatException("The heap sizes do not match the blob length.");

            var blobHeap = new BlobHeap(start + blobHeapOffset, blobHeapSize);

            var documents = new string[documentCount];
            for (var i = 0; i < documentCount; i++)
                documents[i] = blobHeap.DocumentName(documentNames[i]);

            var methods = new SourceSpan[methodCount + 1][];
            methods[0] = [];
            for (var i = 0; i < methodCount; i++)
                methods[i + 1] = methodBlobs[i] == 0 ? [] : blobHeap.Spans(methodBlobs[i], documentCount);

            return new SpanTable(documents, methods);
        }
    }

    private static int ReadReference(ref BlobReader reader, bool small) => small ? reader.ReadUInt16() : reader.ReadInt32();

    /// <summary>The blob heap of a span table, read while the blob it points into is pinned.</summary>
    private readonly unsafe struct BlobHeap(byte* start, int length)
    {
        private readonly byte* _start = start;
        private readonly int _length = length;

        /// <summary>A document name: a separator byte, then the parts it joins, each a blob of UTF-8.</summary>
        internal string DocumentName(int offset)
        {
            var reader = Blob(offset);
            var separator = reader.ReadByte();
            if (separator > 0x7f)
                throw new BadImageFormatException("Invalid document name separator.");

            var name = new StringBuilder();
            var first = true;
            while (reader.RemainingBytes > 0)
            {
                if (separator != 0 && !first)
                    name.Append((char)separator);

                var part = Blob(reader.ReadCompressedInteger());
                name.Append(part.ReadUTF8(part.Length));
                first = false;
            }

            return name.ToString();
        }

        /// <summary>
        /// A method's spans: a document row id, then one record per span, the line and column deltas of its end,
        /// then its start (absolute for the first span, relative to the previous start afterwards). A record with
        /// both end deltas zero switches to another document.
        /// </summary>
        internal SourceSpan[] Spans(int offset, int documentCount)
        {
            var reader = Blob(offset);
            var document = DocumentRowId(ref reader, documentCount);
            var previousStartLine = -1;
            var previousStartColumn = 0;
            var spans = new List<SourceSpan>();

            while (reader.RemainingBytes > 0)
            {
                var deltaLines = reader.ReadCompressedInteger();
                var deltaColumns = deltaLines == 0 ? reader.ReadCompressedInteger() : reader.ReadCompressedSignedInteger();
                if (deltaLines == 0 && deltaColumns == 0)
                {
                    document = DocumentRowId(ref reader, documentCount);
                    continue;
                }

                int startLine, startColumn;
                if (previousStartLine < 0)
                {
                    startLine = reader.ReadCompressedInteger();
                    startColumn = reader.ReadCompressedInteger();
                }
                else
                {
                    startLine = previousStartLine + reader.ReadCompressedSignedInteger();
                    startColumn = previousStartColumn + reader.ReadCompressedSignedInteger();
                }

                var endLine = startLine + deltaLines;
                var endColumn = startColumn + deltaColumns;
                if (startLine < 0 || startColumn < 0 || endLine < startLine || endColumn < 0)
                    throw new BadImageFormatException("Span out of range.");

                previousStartLine = startLine;
                previousStartColumn = startColumn;
                spans.Add(new SourceSpan(document - 1, startLine, startColumn, endLine, endColumn));
            }

            return [.. spans];
        }

        private static int DocumentRowId(ref BlobReader reader, int documentCount)
        {
            var row = reader.ReadCompressedInteger();
            if (row < 1 || row > documentCount)
                throw new BadImageFormatException("Invalid document row id.");
            return row;
        }

        private BlobReader Blob(int offset)
        {
            if (offset < 0 || offset >= _length)
                throw new BadImageFormatException("Blob offset out of range.");

            var header = new BlobReader(_start + offset, _length - offset);
            var size = header.ReadCompressedInteger();
            if (size > header.RemainingBytes)
                throw new BadImageFormatException("Blob size out of range.");

            return new BlobReader(_start + offset + header.Offset, size);
        }
    }
}
