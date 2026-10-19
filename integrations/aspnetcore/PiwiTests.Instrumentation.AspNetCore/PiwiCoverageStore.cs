using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using PiwiTests.Instrumentation.Coverage;

namespace PiwiTests.Instrumentation.AspNetCore;

/// <summary>
/// The requests whose coverage was named on a response (<c>X-Piwi-Coverage</c>), kept by request sequence until
/// they are collected. A request is kept from the moment it is named; once it ends, it counts against the caps,
/// in number and in approximate bytes, and the oldest ended requests are evicted first.
/// </summary>
internal sealed class PiwiCoverageStore(int maxRequests, long maxBytes)
{
    private readonly object _lock = new();
    private readonly Dictionary<long, Entry> _entries = [];
    private readonly LinkedList<long> _ended = new();
    private long _endedBytes;

    /// <summary>
    /// Keeps <paramref name="coverage"/> under <paramref name="sequence"/>, collected only with
    /// <paramref name="secret"/>, as an ended request when <paramref name="ended"/>. Returns the requests evicted to
    /// stay within the caps.
    /// </summary>
    internal List<PiwiRequestCoverage>? Add(long sequence, string secret, PiwiRequestCoverage coverage, bool ended)
    {
        lock (_lock)
        {
            var entry = new Entry(coverage, Encoding.ASCII.GetBytes(secret));
            _entries[sequence] = entry;
            return ended ? MarkEnded(sequence, entry) : null;
        }
    }

    /// <summary>
    /// Marks the request kept under <paramref name="sequence"/> as ended. False when it is no longer kept: it
    /// was collected while it ran. <paramref name="evicted"/> lists the requests evicted to stay within the caps.
    /// </summary>
    internal bool End(long sequence, out List<PiwiRequestCoverage>? evicted)
    {
        lock (_lock)
        {
            evicted = null;
            if (!_entries.TryGetValue(sequence, out var entry))
                return false;

            if (entry.Node is null)
                evicted = MarkEnded(sequence, entry);
            return true;
        }
    }

    /// <summary>
    /// Removes and returns the request kept under <paramref name="sequence"/>, or null when there is none or
    /// <paramref name="secret"/> is not its own.
    /// </summary>
    internal PiwiRequestCoverage? Take(long sequence, string secret)
    {
        lock (_lock)
        {
            if (!_entries.TryGetValue(sequence, out var entry) ||
                !CryptographicOperations.FixedTimeEquals(entry.Secret, Encoding.ASCII.GetBytes(secret)))
                return null;

            _entries.Remove(sequence);

            if (entry.Node is not null)
            {
                _ended.Remove(entry.Node);
                _endedBytes -= entry.Bytes;
            }

            return entry.Coverage;
        }
    }

    /// <summary>Every request kept.</summary>
    internal List<PiwiRequestCoverage> Snapshot()
    {
        lock (_lock)
        {
            var requests = new List<PiwiRequestCoverage>(_entries.Count);
            foreach (var entry in _entries.Values)
                requests.Add(entry.Coverage);
            return requests;
        }
    }

    private List<PiwiRequestCoverage>? MarkEnded(long sequence, Entry entry)
    {
        entry.Node = _ended.AddLast(sequence);
        entry.Bytes = entry.Coverage.ApproximateBytes;
        _endedBytes += entry.Bytes;

        List<PiwiRequestCoverage>? evicted = null;
        while (_ended.First is { } oldest && (_ended.Count > maxRequests || _endedBytes > maxBytes))
        {
            _ended.RemoveFirst();
            if (_entries.Remove(oldest.Value, out var removed))
            {
                _endedBytes -= removed.Bytes;
                (evicted ??= []).Add(removed.Coverage);
            }
        }

        return evicted;
    }

    private sealed class Entry(PiwiRequestCoverage coverage, byte[] secret)
    {
        public PiwiRequestCoverage Coverage { get; } = coverage;
        public byte[] Secret { get; } = secret;
        public LinkedListNode<long>? Node { get; set; }
        public long Bytes { get; set; }
    }
}
