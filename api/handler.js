const {
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { AssumeRoleCommand, STSClient } = require("@aws-sdk/client-sts");

const bucket = process.env.BUCKET_NAME;
const kmsKeyId = process.env.KMS_KEY_ARN;
const region = process.env.AWS_REGION || "us-east-1";
const roleArn = process.env.ROLE_ARN;
const accessRoleArn = process.env.ACCESS_ROLE_ARN;
const vpcEndpointId = process.env.VPC_ENDPOINT_ID;
const MAX_BYTES = 5 * 1024 * 1024;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessions = new Map();

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

function signedInUser(event) {
  const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof userId !== "string" || !USER_ID.test(userId)) {
    throw new InputError("Sign-in token did not include a user id.");
  }
  return userId;
}

function userPrefix(userId) {
  return `vault/${userId}`;
}

function objectKey(userId, name) {
  const trimmed = String(name || "").trim().replace(/^\/+/, "");
  const ownPrefix = `${userPrefix(userId)}/`;
  const relative = trimmed.startsWith(ownPrefix) ? trimmed.slice(ownPrefix.length) : trimmed;
  if (!relative || relative.includes("..") || relative.includes("\\")) {
    throw new InputError("Use a file name without slashes that climb out of your folder.");
  }
  if (relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new InputError("Use a file name such as notes.txt.");
  }
  return `${ownPrefix}${relative}`;
}

function assertObjectKey(userId, value) {
  if (typeof value !== "string") throw new InputError("Missing object key.");
  const key = value.trim();
  const ownPrefix = `${userPrefix(userId)}/`;
  if (!key.startsWith(ownPrefix)) {
    throw new InputError("That file is outside your folder.");
  }
  objectKey(userId, key);
  return key;
}

function sessionPolicy(userId) {
  const prefix = userPrefix(userId);
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ListOwnPrefix",
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:ListBucketVersions", "s3:ListBucketMultipartUploads"],
        Resource: `arn:aws:s3:::${bucket}`,
        Condition: { StringLike: { "s3:prefix": [prefix, `${prefix}/*`] } },
      },
      {
        Sid: "ReadWriteOwnObjects",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        Resource: `arn:aws:s3:::${bucket}/${prefix}/*`,
      },
      {
        Sid: "UseVaultKey",
        Effect: "Allow",
        Action: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
        Resource: kmsKeyId,
      },
    ],
  };
}

async function s3ForUser(userId) {
  const cached = sessions.get(userId);
  if (cached && cached.expiration.getTime() - Date.now() > 60_000) return cached.client;
  const sts = new STSClient({
    region,
    endpoint: process.env.STS_ENDPOINT || undefined,
  });
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: accessRoleArn,
      RoleSessionName: `vault-${userId}`,
      DurationSeconds: 900,
      Policy: JSON.stringify(sessionPolicy(userId)),
    }),
  );
  const credentials = assumed.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken || !credentials.Expiration) {
    throw new Error("Could not open a session for this user.");
  }
  const client = new S3Client({
    region,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  });
  sessions.set(userId, { client, expiration: credentials.Expiration });
  return client;
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(payload),
  };
}

function failure(error) {
  if (error instanceof InputError) {
    return json(400, { error: error.message, code: "InputError" });
  }
  const code = error.name || "Error";
  const status = error.$metadata?.httpStatusCode || (code === "AccessDenied" ? 403 : 500);
  return json(status, { error: error.message || "AWS request failed.", code });
}

async function listPrefix(s3, prefix) {
  const versions = [];
  const markers = [];
  let keyMarker;
  let versionIdMarker;
  let truncated = false;
  for (let page = 0; page < 5; page += 1) {
    const listed = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: `${prefix}/`,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
        MaxKeys: 200,
      }),
    );
    versions.push(...(listed.Versions || []));
    markers.push(...(listed.DeleteMarkers || []));
    if (!listed.IsTruncated) {
      truncated = false;
      break;
    }
    truncated = true;
    keyMarker = listed.NextKeyMarker;
    versionIdMarker = listed.NextVersionIdMarker;
  }
  const rows = new Map();
  for (const version of versions) {
    if (!version.Key || !version.VersionId) continue;
    const row = rows.get(version.Key) || {
      key: version.Key,
      size: 0,
      lastModified: null,
      versionCount: 0,
      latestVersionId: null,
    };
    row.versionCount += 1;
    if (version.IsLatest) {
      row.size = version.Size || 0;
      row.lastModified = version.LastModified ? version.LastModified.toISOString() : null;
      row.latestVersionId = version.VersionId;
    }
    rows.set(version.Key, row);
  }
  for (const marker of markers) {
    if (!marker.Key) continue;
    const row = rows.get(marker.Key) || {
      key: marker.Key,
      size: 0,
      lastModified: null,
      versionCount: 0,
      latestVersionId: null,
    };
    row.versionCount += 1;
    if (marker.IsLatest) {
      row.size = 0;
      row.lastModified = marker.LastModified ? marker.LastModified.toISOString() : null;
      row.latestVersionId = marker.VersionId || null;
    }
    rows.set(marker.Key, row);
  }
  const objects = [...rows.values()].sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));
  return { prefix, objects, truncated };
}

async function listKeyVersions(s3, key) {
  const listed = await s3.send(
    new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, MaxKeys: 100 }),
  );
  const versions = (listed.Versions || [])
    .filter((version) => version.Key === key && version.VersionId)
    .map((version) => ({
      kind: "version",
      versionId: version.VersionId,
      isLatest: Boolean(version.IsLatest),
      size: version.Size || 0,
      lastModified: version.LastModified ? version.LastModified.toISOString() : null,
    }));
  const deleteMarkers = (listed.DeleteMarkers || [])
    .filter((marker) => marker.Key === key && marker.VersionId)
    .map((marker) => ({
      kind: "delete-marker",
      versionId: marker.VersionId,
      isLatest: Boolean(marker.IsLatest),
      size: 0,
      lastModified: marker.LastModified ? marker.LastModified.toISOString() : null,
    }));
  return {
    key,
    truncated: Boolean(listed.IsTruncated),
    entries: [...versions, ...deleteMarkers].sort((a, b) =>
      (b.lastModified || "").localeCompare(a.lastModified || ""),
    ),
  };
}

async function putBytes(s3, key, body, contentType) {
  if (body.byteLength > MAX_BYTES) throw new InputError("Files must be 5 MB or smaller.");
  const result = await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: kmsKeyId,
    }),
  );
  return {
    key,
    versionId: result.VersionId || null,
    etag: result.ETag || null,
    encryption: result.ServerSideEncryption || null,
    expiration: result.Expiration || null,
  };
}

async function readObject(s3, key, versionId) {
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId || undefined,
    }),
  );
  const bytes = await result.Body.transformToByteArray();
  return {
    bytes,
    versionId: result.VersionId || versionId || "",
    contentType: result.ContentType || "application/octet-stream",
  };
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  const query = event.queryStringParameters || {};
  try {
    const userId = signedInUser(event);
    const prefix = userPrefix(userId);
    const s3 = await s3ForUser(userId);
    if (method === "GET" && path === "/status") {
      return json(200, {
        bucket,
        region,
        roleArn,
        identityArn: roleArn,
        userId,
        prefix,
        vpcEndpointId,
        encryption: "aws:kms",
      });
    }
    if (method === "GET" && path === "/objects") {
      return json(200, await listPrefix(s3, prefix));
    }
    if (method === "GET" && path === "/versions") {
      return json(200, await listKeyVersions(s3, assertObjectKey(userId, query.key)));
    }
    if (method === "GET" && path === "/content") {
      const key = assertObjectKey(userId, query.key);
      const object = await readObject(s3, key, query.versionId);
      const filename = objectKeyName(key);
      return {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          "content-type": object.contentType,
          "content-disposition": `inline; filename="${filename}"`,
          "x-version-id": object.versionId,
          "cache-control": "no-store",
        },
        body: Buffer.from(object.bytes).toString("base64"),
      };
    }
    if (method === "POST" && path === "/objects") {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body || "", "base64").toString("utf8")
        : event.body || "{}";
      const body = JSON.parse(raw);
      const key = objectKey(userId, body.name);
      if (typeof body.contentBase64 === "string") {
        const bytes = Buffer.from(body.contentBase64, "base64");
        return json(200, await putBytes(s3, key, bytes, body.contentType || "application/octet-stream"));
      }
      if (typeof body.content !== "string") throw new InputError("Enter text to store.");
      return json(200, await putBytes(s3, key, Buffer.from(body.content, "utf8"), "text/plain; charset=utf-8"));
    }
    return json(404, { error: "Not found.", code: "NotFound" });
  } catch (error) {
    return failure(error);
  }
};

function objectKeyName(key) {
  return String(key).split("/").pop().replace(/["\r\n]/g, "") || "object";
}
