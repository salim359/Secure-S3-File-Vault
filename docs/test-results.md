# Test results

Recorded 2026-10-23 in `us-east-1`. The stack `s3-file-vault` and bucket `s3-file-vault-399352912234` were removed the same day. The KMS key remains pending deletion until 2026-10-30.

## Bucket controls

| Check | Result |
|---|---|
| Block Public Access | All four settings true |
| Versioning | Enabled |
| Default encryption, final | SSE-KMS (`aws:kms`) with alias `alias/s3-file-vault` and a bucket key |
| Bucket policy | `DenyInsecureTransport` and `DenyObjectAccessOutsideVpcEndpoint`. The admin principal is exempt from the endpoint deny. |
| Lifecycle | `temporary/` only. Current objects expire after 7 days. Noncurrent versions expire after 1 day. Incomplete multipart uploads abort after 1 day. Expired delete markers under that prefix are removed. |
| CloudTrail | Trail `s3-file-vault-data-events` logging. Data events for `arn:aws:s3:::s3-file-vault-399352912234/` only. Management events off. `LatestDeliveryError` was null. |

The first encryption check, before KMS was enabled, reported SSE-S3 (`AES256`). After the change, `temporary/kms-check.txt` was stored through API Gateway with SSE `aws:kms`, version `5kMHyd6y_MBtDFdxEfpqiHZnVciRJEvr`, body `stored through API Gateway`. `GET /status` reported encryption `aws:kms`, the API role, and VPC endpoint `vpce-07aba1bcb4860157e`. A call to `/status` with no token returned `401`.

## Least privilege

IAM policy simulation for role `s3-file-vault-access`, while that role was limited to `vault/`:

| Call | Target | Decision |
|---|---|---|
| `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:GetObjectVersion` | `vault/file.txt` | allowed |
| `s3:ListBucket`, `s3:ListBucketVersions` | bucket, prefix `vault/` | allowed |
| `s3:GetObject`, `s3:PutObject` | `other/file.txt` | implicit deny |
| `s3:ListBucket` | bucket, no prefix | implicit deny |
| `s3:DeleteObjectVersion`, `s3:PutObjectAcl` | `vault/file.txt` | implicit deny |
| `s3:DeleteBucket`, `s3:PutBucketPolicy`, `s3:PutBucketAcl` | bucket | implicit deny |

The Next.js app confirmed the live boundary. The vault role session `s3-file-vault-access/file-vault-next` received `AccessDenied` for `s3:ListBucketVersions` on `temporary/`. The machine's IAM user could list and upload that prefix.

After sign-in was added, `s3-file-vault-api` had one permission: `sts:AssumeRole` on `s3-file-vault-access`. The function assumed that role with a session policy for `vault/<sub>/`.

## Sign-in and per-person folders

Cognito user pool `us-east-1_AcsPT36B8`. Each account was signed in from the app and through the API.

| Account | Folder | Object written |
|---|---|---|
| `vault-a@example.com` | `vault/742834a8-4011-70e6-e1f9-6c2258860630/` | `notes.txt`, body `hello from A`, version `3yQYBd5bInI04WUFxx88mc9H5L0CqmnG` |
| `vault-b@example.com` | `vault/c468a468-70d1-70bb-a366-f2540802faa1/` | `spoof.txt` |

A's list contained only `notes.txt`. B's list contained only `spoof.txt`. B's read of A's key returned `400` with `That file is outside your folder.` B's upload sent A's user id and prefix in the body; the stored key was still `vault/c468a468-70d1-70bb-a366-f2540802faa1/spoof.txt`.

## Versioning

Key: `temporary/versioning-test.txt`, written before SSE-KMS was the bucket default.

| Step | Version ID | Body |
|---|---|---|
| Upload | `wl6HBKMyEyHW.ifyFIe7x1H7dns4MkQe` | `version 1 — original contents` |
| Overwrite | `sj415jVrExhZoHHewK1CNvEfz0UEQisz` | `version 2 — replaced contents` |
| `GetObject` with no version ID | `sj415jVrExhZoHHewK1CNvEfz0UEQisz` | `version 2 — replaced contents` |
| `GetObject` with the first version ID | `wl6HBKMyEyHW.ifyFIe7x1H7dns4MkQe` | `version 1 — original contents` |
| Store again from the Next.js app | `XZDoO_vXDlHd8MPJhvOjCkH_DxI_X4wF` | `version 3 — written from the Next.js app` |

Opening the first version ID in the app displayed `version 1 — original contents`. Those uploads reported SSE-S3 and an expiration date of 31 Oct 2026 from rule `ExpireTemporaryTestObjects`.

Versioning keeps earlier bytes for the same key in this bucket. A backup is a separate copy with its own location and retention.

- A version is selected by version ID on the live key. A backup lives in another bucket, account, or region.
- The `temporary/` lifecycle rule can delete this history. A backup is not removed by the source object's lifecycle rule.
- A delete without a version ID adds a delete marker. `s3:DeleteObjectVersion`, which this role does not have, or a lifecycle rule, can erase the history. A backup is outside that delete path.
- Versioning is not a point-in-time copy of the bucket and does not survive deletion of the bucket. A backup can be cross-region, cross-account, and locked.

## Removal

On 2026-10-23 the stack reached `DELETE_COMPLETE`. The VPC, endpoints, Lambda functions, API, Cognito pool, IAM roles, trail, and both buckets were gone. The KMS key `faac55d9-6dd5-43da-a3d2-674d3d26200f` was left `PendingDeletion` until 2026-10-30 because a customer-managed key cannot be removed the same day.
