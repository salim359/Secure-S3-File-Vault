"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type Status = {
  bucket: string;
  region: string;
  roleArn: string;
  identityArn: string | null;
  userId?: string;
  prefix?: string;
  vpcEndpointId?: string;
  encryption?: string;
};

const apiBase = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";

function apiUrl(path: string) {
  if (!apiBase) {
    throw new Error("Set NEXT_PUBLIC_API_URL to the API Gateway URL, then restart the app.");
  }
  return `${apiBase}${path}`;
}

async function apiFetch(path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(apiUrl(path), { ...init, headers, cache: "no-store" });
}

async function cognito(action: string, fields: { email: string; password?: string; confirmationCode?: string }) {
  let response: Response;
  try {
    response = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...fields }),
    });
  } catch {
    throw new Error("Could not reach the sign-in service.");
  }
  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.message || "Sign-in failed.");
  }
  return payload ?? {};
}

type ObjectRow = {
  key: string;
  size: number;
  lastModified: string | null;
  versionCount: number;
  latestVersionId: string | null;
};

type VersionEntry = {
  kind: "version" | "delete-marker";
  versionId: string;
  isLatest: boolean;
  size: number;
  lastModified: string | null;
};

type Preview = {
  key: string;
  versionId: string;
  isLatest: boolean;
  text: string | null;
  downloadUrl: string | null;
  contentType: string;
};

async function readError(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
  return payload?.code ? `${payload.code}: ${payload.error}` : payload?.error || `Request failed (${response.status})`;
}

function formatWhen(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up" | "confirm" | "forgot" | "reset">("sign-in");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [name, setName] = useState("versioning-test.txt");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [objects, setObjects] = useState<ObjectRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loadedListKey, setLoadedListKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loadedVersionKey, setLoadedVersionKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadObjects = useCallback(async (accessToken: string) => {
    const response = await apiFetch("/objects", accessToken);
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as { objects: ObjectRow[]; truncated: boolean };
    return payload;
  }, []);

  const loadVersions = useCallback(async (key: string, accessToken: string) => {
    const response = await apiFetch(`/versions?key=${encodeURIComponent(key)}`, accessToken);
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as { entries: VersionEntry[] };
    return payload.entries;
  }, []);

  useEffect(() => {
    setToken(sessionStorage.getItem("vault-id-token"));
    setAuthReady(true);
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await apiFetch("/status", token);
        if (!response.ok) throw new Error(await readError(response));
        const payload = (await response.json()) as Status;
        if (!cancelled) setStatus(payload);
      } catch (reason: unknown) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Could not read API status.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const listKey = `${token ?? ""}:${refreshKey}`;
  const versionKey = selectedKey ? `${selectedKey}:${refreshKey}` : null;
  const listLoading = loadedListKey !== listKey;
  const versionsLoading = Boolean(versionKey) && loadedVersionKey !== versionKey;

  useEffect(() => {
    let cancelled = false;
    if (!token) return;
    const requestKey = `${token}:${refreshKey}`;
    loadObjects(token)
      .then((payload) => {
        if (cancelled) return;
        setError(null);
        setLoadedListKey(requestKey);
        setObjects(payload.objects);
        setTruncated(payload.truncated);
        if (payload.objects.length === 0) {
          setSelectedKey(null);
          setVersions([]);
          setPreview(null);
          return;
        }
        setSelectedKey((current) => {
          if (current && payload.objects.some((object) => object.key === current)) return current;
          return payload.objects[0]?.key ?? null;
        });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setLoadedListKey(requestKey);
        setObjects([]);
        setSelectedKey(null);
        setVersions([]);
        setLoadedVersionKey(null);
        setPreview(null);
        setError(reason instanceof Error ? reason.message : "Could not list objects.");
      });
    return () => {
      cancelled = true;
    };
  }, [token, loadObjects, refreshKey]);

  useEffect(() => {
    if (!selectedKey || !token) return;
    let cancelled = false;
    const requestKey = `${selectedKey}:${refreshKey}`;
    loadVersions(selectedKey, token)
      .then((entries) => {
        if (cancelled) return;
        setVersions(entries);
        setLoadedVersionKey(requestKey);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not list versions.");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedKey, token, loadVersions, refreshKey]);

  useEffect(() => {
    return () => {
      if (preview?.downloadUrl) URL.revokeObjectURL(preview.downloadUrl);
    };
  }, [preview]);

  async function openVersion(entry: VersionEntry) {
    if (!selectedKey || entry.kind === "delete-marker") return;
    setBusy(true);
    setError(null);
    try {
      if (!token) throw new Error("Sign in before opening a file.");
      const response = await apiFetch(
        `/content?key=${encodeURIComponent(selectedKey)}&versionId=${encodeURIComponent(entry.versionId)}`,
        token,
      );
      if (!response.ok) throw new Error(await readError(response));
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const versionId = response.headers.get("x-version-id") || entry.versionId;
      if (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml")) {
        setPreview({
          key: selectedKey,
          versionId,
          isLatest: entry.isLatest,
          text: await response.text(),
          downloadUrl: null,
          contentType,
        });
      } else {
        const blob = await response.blob();
        setPreview({
          key: selectedKey,
          versionId,
          isLatest: entry.isLatest,
          text: null,
          downloadUrl: URL.createObjectURL(blob),
          contentType,
        });
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not read that version.");
    } finally {
      setBusy(false);
    }
  }

  async function storeVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!token) throw new Error("Sign in before storing a file.");
      const payload = file
        ? {
            name: file.name,
            contentBase64: await fileToBase64(file),
            contentType: file.type || "application/octet-stream",
          }
        : { name, content };
      const response = await apiFetch("/objects", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await readError(response));
      const stored = (await response.json()) as { key: string; versionId: string | null };
      setSelectedKey(stored.key);
      setRefreshKey((current) => current + 1);
      setNotice(
        stored.versionId
          ? `Stored ${stored.key} as version ${stored.versionId}.`
          : `Stored ${stored.key}.`,
      );
      setFile(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not store the object.");
    } finally {
      setBusy(false);
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (authMode === "sign-up") {
        await cognito("SignUp", { email, password });
        setAuthMode("confirm");
        setNotice("Check your email for the confirmation code.");
        return;
      }
      if (authMode === "confirm") {
        await cognito("ConfirmSignUp", { email, confirmationCode });
        setAuthMode("sign-in");
        setNotice("Email confirmed. Sign in with the same password.");
        return;
      }
      if (authMode === "forgot") {
        await cognito("ForgotPassword", { email });
        setAuthMode("reset");
        setNotice("Check your email for a reset code.");
        return;
      }
      if (authMode === "reset") {
        await cognito("ConfirmForgotPassword", { email, password, confirmationCode });
        setAuthMode("sign-in");
        setPassword("");
        setConfirmationCode("");
        setNotice("Password updated. Sign in with the new password.");
        return;
      }
      const result = (await cognito("InitiateAuth", { email, password })) as {
        AuthenticationResult?: { IdToken?: string; RefreshToken?: string };
      };
      const idToken = result.AuthenticationResult?.IdToken;
      if (!idToken) throw new Error("Cognito did not return a sign-in token.");
      sessionStorage.setItem("vault-id-token", idToken);
      if (result.AuthenticationResult?.RefreshToken) {
        sessionStorage.setItem("vault-refresh-token", result.AuthenticationResult.RefreshToken);
      }
      setToken(idToken);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    sessionStorage.removeItem("vault-id-token");
    sessionStorage.removeItem("vault-refresh-token");
    setToken(null);
    setStatus(null);
    setObjects([]);
    setVersions([]);
    setSelectedKey("");
    setNotice(null);
    setError(null);
  }

  if (!authReady) {
    return <p className="px-6 py-6 text-sm text-muted">Loading…</p>;
  }

  if (!token) {
    return (
      <div className="min-h-screen">
        <header className="border-b border-line px-6 py-6">
          <p className="font-mono text-xs tracking-[0.16em] text-muted">S3 FILE VAULT</p>
          <h1 className="mt-2 font-serif text-2xl">
            {authMode === "forgot" || authMode === "reset" ? "Reset your password" : "Sign in to your folder"}
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted">
            Each account stores files under its own vault prefix. The API reads that id from the sign-in token.
          </p>
        </header>
        <form onSubmit={submitAuth} className="mx-6 mt-6 max-w-md border border-line bg-panel p-4">
          <label className="block text-sm" htmlFor="email">
            Email
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="mt-1 w-full border border-line bg-paper px-3 py-2 text-sm"
            />
          </label>
          {authMode === "forgot" ? null : (
            <label className="mt-4 block text-sm" htmlFor="password">
              {authMode === "reset" ? "New password" : "Password"}
              <span className="relative mt-1 block">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={authMode === "sign-in" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={12}
                  className="w-full border border-line bg-paper py-2 pr-10 pl-3 text-sm"
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((current) => !current)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-muted"
                >
                  {showPassword ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      <path d="M3 3l18 18" />
                      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                      <path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c5.5 0 9.5 4.2 11 7-1 1.8-2.6 3.8-4.7 5.2M6.1 6.1C4.2 7.4 2.7 9.2 1 12c1.5 2.8 5.5 7 11 7 1.3 0 2.5-.2 3.6-.7" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </span>
            </label>
          )}
          {authMode === "confirm" || authMode === "reset" ? (
            <label className="mt-4 block text-sm" htmlFor="code">
              Confirmation code
              <input
                id="code"
                value={confirmationCode}
                onChange={(event) => setConfirmationCode(event.target.value)}
                required
                className="mt-1 w-full border border-line bg-paper px-3 py-2 font-mono text-sm"
              />
            </label>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            className="mt-4 border border-ink bg-ink px-3 py-2 text-sm text-paper disabled:opacity-60"
          >
            {authMode === "sign-up"
              ? "Create account"
              : authMode === "confirm"
                ? "Confirm email"
                : authMode === "forgot"
                  ? "Send reset code"
                  : authMode === "reset"
                    ? "Save new password"
                    : "Sign in"}
          </button>
          <div className="mt-3 flex gap-4 text-xs">
            {authMode !== "sign-in" ? (
              <button type="button" className="underline" onClick={() => setAuthMode("sign-in")}>
                Sign in
              </button>
            ) : (
              <>
                <button type="button" className="underline" onClick={() => setAuthMode("sign-up")}>
                  Create an account
                </button>
                <button type="button" className="underline" onClick={() => setAuthMode("forgot")}>
                  Forgot password
                </button>
              </>
            )}
          </div>
          {notice ? <p className="mt-3 text-sm text-pine">{notice}</p> : null}
          {error ? <p className="mt-3 text-sm text-clay">{error}</p> : null}
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line px-6 py-6">
        <p className="font-mono text-xs tracking-[0.16em] text-muted">S3 FILE VAULT</p>
        <h1 className="mt-2 font-serif text-2xl">Store a file, then read an older version</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
          Saving the same name again keeps the previous body in this bucket. Open a version ID to
          read it. Files stay in your folder
          {status?.prefix ? ` ${status.prefix}/` : " vault/<your-user-id>/"} until you delete them.
        </p>
        <button type="button" onClick={signOut} className="mt-3 text-xs underline">
          Sign out
        </button>
        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs text-ink">
          <div>
            <dt className="text-muted">Bucket</dt>
            <dd>{status?.bucket ?? "…"}</dd>
          </div>
          <div>
            <dt className="text-muted">Region</dt>
            <dd>{status?.region ?? "…"}</dd>
          </div>
          <div>
            <dt className="text-muted">Caller</dt>
            <dd className="max-w-xl break-all">{status?.identityArn ?? "…"}</dd>
          </div>
          <div>
            <dt className="text-muted">VPC endpoint</dt>
            <dd>{status?.vpcEndpointId ?? "…"}</dd>
          </div>
          <div>
            <dt className="text-muted">Encryption</dt>
            <dd>{status?.encryption ?? "…"}</dd>
          </div>
        </dl>
      </header>

      <main className="grid gap-8 px-6 py-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <form onSubmit={storeVersion} className="border border-line bg-panel p-4">
          <h2 className="font-serif text-xl">New version</h2>
          <p className="mt-2 text-xs leading-5 text-muted">
            The browser calls API Gateway. The function reaches S3 through the VPC endpoint and stores objects with the vault KMS key.
          </p>

          <label className="mt-4 block text-sm" htmlFor="file-name">
            File name
            <input
              id="file-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={Boolean(file)}
              className="mt-1 w-full border border-line bg-paper px-3 py-2 font-mono text-sm"
            />
          </label>

          <label className="mt-4 block text-sm" htmlFor="contents">
            Contents
            <textarea
              id="contents"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              disabled={Boolean(file)}
              rows={7}
              className="mt-1 w-full border border-line bg-paper px-3 py-2 font-mono text-sm"
              placeholder="version 1 — original contents"
            />
          </label>

          <label className="mt-4 block text-sm" htmlFor="file">
            Or choose a file
            <input
              id="file"
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm"
            />
          </label>
          {file ? (
            <button
              type="button"
              className="mt-2 text-sm text-pine underline"
              onClick={() => setFile(null)}
            >
              Use the text box instead of {file.name}
            </button>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="mt-5 bg-pine px-4 py-2 text-sm text-paper disabled:opacity-60"
          >
            {busy ? "Working…" : "Store version"}
          </button>
        </form>

        <section>
          {error ? (
            <p className="mb-4 border border-clay bg-panel px-3 py-2 text-sm text-clay" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="mb-4 border border-pine bg-panel px-3 py-2 text-sm text-pine">{notice}</p>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-2">
            <div>
              <h2 className="font-serif text-xl">Your files</h2>
              {truncated ? (
                <p className="mt-1 text-xs text-muted">Showing the first page of versions.</p>
              ) : null}
              <ul className="mt-3 divide-y divide-line border border-line bg-panel">
                {listLoading ? (
                  <li className="px-3 py-4 text-sm text-muted">Loading objects…</li>
                ) : objects.length === 0 ? (
                  error ? null : (
                    <li className="px-3 py-4 text-sm text-muted">Nothing is stored in your folder.</li>
                  )
                ) : (
                  objects.map((object) => {
                    const selected = object.key === selectedKey;
                    return (
                      <li key={object.key}>
                        <button
                          type="button"
                          onClick={() => setSelectedKey(object.key)}
                          className={`block w-full px-3 py-3 text-left ${selected ? "bg-paper" : ""}`}
                        >
                          <span className="block font-mono text-sm">{object.key}</span>
                          <span className="mt-1 block text-xs text-muted">
                            {`${object.versionCount} ${object.versionCount === 1 ? "version" : "versions"} · ${formatSize(object.size)} · ${formatWhen(object.lastModified)}`}
                          </span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>

            <div>
              <h2 className="font-serif text-xl">Versions</h2>
              <p className="mt-1 break-all font-mono text-xs text-muted">
                {selectedKey ?? "Select an object"}
              </p>
              <ul className="mt-3 divide-y divide-line border border-line bg-panel">
                {versionsLoading ? (
                  <li className="px-3 py-4 text-sm text-muted">Loading versions…</li>
                ) : (
                  versions.map((entry) => (
                  <li key={entry.versionId} className="px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-mono text-xs break-all">{entry.versionId}</p>
                        <p className="mt-1 text-xs text-muted">
                          {entry.kind === "delete-marker" ? "Delete marker" : formatSize(entry.size)} ·{" "}
                          {formatWhen(entry.lastModified)}
                          {entry.isLatest ? " · latest" : ""}
                        </p>
                      </div>
                      {entry.kind === "version" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => openVersion(entry)}
                          className="shrink-0 border border-line px-2 py-1 text-xs"
                        >
                          Open
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))
                )}
              </ul>

              {preview ? (
                <article className="mt-4 border border-line bg-panel p-3">
                  <h3 className="text-sm">
                    {preview.isLatest ? "Latest version" : "Older version"}
                  </h3>
                  <p className="mt-1 break-all font-mono text-xs text-muted">{preview.versionId}</p>
                  {preview.text != null ? (
                    <pre className="mt-3 overflow-auto whitespace-pre-wrap font-mono text-sm">
                      {preview.text}
                    </pre>
                  ) : preview.downloadUrl ? (
                    <a
                      className="mt-3 inline-block text-sm text-pine underline"
                      href={preview.downloadUrl}
                      download={preview.key.split("/").pop()}
                    >
                      Download this version
                    </a>
                  ) : null}
                </article>
              ) : null}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
