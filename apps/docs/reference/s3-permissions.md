---
title: S3 permissions
description: "Every permission Piwi needs on an S3 bucket, those of the multipart uploads of large files, and a KMS-encrypted bucket's."
lang: en-US
---

# S3 permissions

What the key or the role Piwi stores its files with ([S3-compatible storage](/operate/storage#s3-compatible-storage))
may do on its bucket. An S3-compatible service names the same actions in its own policy format.

## The policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::your-bucket-name"
    }
  ]
}
```

| Action | What it lets Piwi do |
|---|---|
| `s3:PutObject` | Store a file, whole or as a multipart upload |
| `s3:GetObject` | Read a stored file |
| `s3:DeleteObject` | Delete a file, as retention and cleanup do |
| `s3:AbortMultipartUpload` | Delete the parts of a multipart upload that failed |
| `s3:ListBucket` | Delete a run's whole prefix. Without it, S3 answers a missing file with `403` instead of `404` |

## Multipart uploads

A file over 8 MiB, such as a trace, a video or a report, is sent in parts of 8 MiB, two at a time. When a part fails,
Piwi aborts the upload, and its parts are deleted. When the abort is refused, as it is without
`s3:AbortMultipartUpload`, the parts stay in the bucket: billed, and counted in no storage figure Piwi shows.

A server that stops in the middle of an upload leaves its parts behind too. A lifecycle rule that aborts incomplete
multipart uploads after a day removes them:

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-uploads",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

## A bucket encrypted with your own KMS key

A multipart upload to a bucket encrypted with a key of your own in AWS KMS needs `kms:Decrypt` on that key, as well as
`kms:GenerateDataKey`. Without it, every file over 8 MiB fails to be stored.

## Related

- [Storage & retention](/operate/storage): the backends, and how long runs are kept.
