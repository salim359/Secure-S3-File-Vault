"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

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

type AuthMode = "sign-in" | "sign-up" | "confirm" | "forgot" | "reset";
type VaultTab = "upload" | "files" | "versions";

const fieldClass =
  "w-full rounded-xl border border-line bg-paper px-3.5 py-2.5 text-sm transition focus:border-blush focus:outline-none focus:ring-4 focus:ring-blush/25 disabled:opacity-60";
const primaryBtnClass =
  "inline-flex items-center justify-center rounded-xl bg-blush px-4 py-2.5 text-sm text-ink transition hover:opacity-90 disabled:opacity-60";
const ghostBtnClass =
  "inline-flex items-center justify-center rounded-xl border border-line bg-panel px-3 py-2 text-sm transition hover:bg-paper disabled:opacity-60";
const linkClass = "text-blush-deep underline underline-offset-4 hover:text-ink";
const kickerClass = "text-sm font-semibold tracking-[0.14em] text-ink uppercase";

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

function fileName(key: string) {
  return key.split("/").filter(Boolean).pop() || "file";
}

function fileExtension(key: string) {
  const name = fileName(key);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

function tokenEmail(token: string) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? "")) as { email?: string };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

const authCopy: Record<AuthMode, { kicker: string; title: string; note: string }> = {
  "sign-in": {
    kicker: "Welcome back",
    title: "Sign in to Locket",
    note: "Each account keeps files under its own private prefix. The API reads that id from your sign-in token.",
  },
  "sign-up": {
    kicker: "New folder",
    title: "Create your private folder",
    note: "Use a password of at least 12 characters. We will send a short code to confirm the email.",
  },
  confirm: {
    kicker: "Almost there",
    title: "Confirm your email",
    note: "Enter the code from your inbox to finish creating the account.",
  },
  forgot: {
    kicker: "Account recovery",
    title: "Reset your password",
    note: "We will email a reset code if this address has a Locket.",
  },
  reset: {
    kicker: "Account recovery",
    title: "Choose a new password",
    note: "Use the code from your email, then sign in with the new password.",
  },
};

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("sign-in");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [name, setName] = useState("versioning-test.txt");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState("");
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
  const [vaultTab, setVaultTab] = useState<VaultTab>("upload");

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
        await response.json();
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
  const signedInEmail = token ? tokenEmail(token) : null;
  const visibleObjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return objects;
    return objects.filter((object) => fileName(object.key).toLowerCase().includes(needle));
  }, [objects, query]);

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
      setVaultTab("files");
      setRefreshKey((current) => current + 1);
      setNotice(`Stored ${fileName(stored.key)}.`);
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
    setObjects([]);
    setVersions([]);
    setSelectedKey("");
    setNotice(null);
    setError(null);
  }

  function takeFile(next: File | null) {
    setFile(next);
    if (next) setName(next.name);
  }

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <p className="text-sm text-muted">Opening Locket…</p>
      </div>
    );
  }

  if (!token) {
    const copy = authCopy[authMode];
    return (
      <div className="relative min-h-screen px-4 py-8 sm:px-6 sm:py-12">
        <div className="mx-auto grid max-w-5xl items-center gap-10 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="hidden lg:block">
            <BrandMark />
            <h1 className="mt-8 max-w-md font-serif text-5xl font-semibold leading-[1.1] tracking-tight">
              A quiet place for files that should stay yours.
            </h1>
            <p className="mt-5 max-w-md text-base leading-7 text-muted">
              Upload a note or a file, save the same name again, and the older copy remains. Open any version later from
              this folder.
            </p>
            <ul className="mt-8 space-y-3 text-sm text-muted">
              <li className="flex items-center gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-blush-soft text-blush-deep">
                  <LockIcon />
                </span>
                Signed-in users only see their own prefix
              </li>
              <li className="flex items-center gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-blush-soft text-blush-deep">
                  <HistoryIcon />
                </span>
                Every save keeps the previous version
              </li>
              <li className="flex items-center gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-blush-soft text-blush-deep">
                  <FileIcon kind="txt" />
                </span>
                Open text in place, download everything else
              </li>
            </ul>
          </section>

          <section className="rounded-3xl border border-line bg-panel/90 p-6 shadow-[0_24px_60px_-28px_rgba(27,24,19,0.45)] backdrop-blur sm:p-8">
            <div className="lg:hidden">
              <BrandMark />
            </div>
            <p className={`mt-6 lg:mt-0 ${kickerClass}`}>{copy.kicker}</p>
            <h2 className="mt-2 font-serif text-3xl font-semibold tracking-tight">{copy.title}</h2>
            <p className="mt-3 text-sm leading-6 text-muted">{copy.note}</p>

            <form onSubmit={submitAuth} className="mt-6 space-y-4">
              <Field label="Email" htmlFor="email">
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  className={fieldClass}
                />
              </Field>

              {authMode === "forgot" ? null : (
                <Field label={authMode === "reset" ? "New password" : "Password"} htmlFor="password">
                  <span className="relative block">
                    <input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete={authMode === "sign-in" ? "current-password" : "new-password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      minLength={12}
                      className={`${fieldClass} pr-11`}
                    />
                    <button
                      type="button"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((current) => !current)}
                      className="absolute top-1/2 right-3 -translate-y-1/2 text-muted transition-colors hover:text-ink"
                    >
                      {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </span>
                </Field>
              )}

              {authMode === "confirm" || authMode === "reset" ? (
                <Field label="Confirmation code" htmlFor="code">
                  <input
                    id="code"
                    value={confirmationCode}
                    onChange={(event) => setConfirmationCode(event.target.value)}
                    required
                    className={`${fieldClass} font-mono`}
                  />
                </Field>
              ) : null}

              <button type="submit" disabled={busy} className={`${primaryBtnClass} w-full`}>
                {busy
                  ? "Working…"
                  : authMode === "sign-up"
                    ? "Create account"
                    : authMode === "confirm"
                      ? "Confirm email"
                      : authMode === "forgot"
                        ? "Send reset code"
                        : authMode === "reset"
                          ? "Save new password"
                          : "Sign in"}
              </button>

              <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                {authMode !== "sign-in" ? (
                  <button type="button" className={linkClass} onClick={() => setAuthMode("sign-in")}>
                    Back to sign in
                  </button>
                ) : (
                  <>
                    <button type="button" className={linkClass} onClick={() => setAuthMode("sign-up")}>
                      Create an account
                    </button>
                    <button type="button" className={linkClass} onClick={() => setAuthMode("forgot")}>
                      Forgot password
                    </button>
                  </>
                )}
              </div>

              {notice ? <Banner tone="ok">{notice}</Banner> : null}
              {error ? <Banner tone="bad">{error}</Banner> : null}
            </form>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line/80 bg-panel/80 px-4 py-4 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="min-w-0">
            <BrandMark compact />
            <p className="mt-2 truncate text-sm text-muted">
              {signedInEmail ? signedInEmail : "Your private folder"}
              {objects.length > 0 ? ` · ${objects.length} ${objects.length === 1 ? "file" : "files"}` : ""}
            </p>
          </div>
          <button type="button" onClick={signOut} className={`${ghostBtnClass} shrink-0`}>
            Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col md:flex-row">
        <aside className="border-b border-line/80 md:w-56 md:shrink-0 md:border-r md:border-b-0">
          <nav className="flex gap-1 p-3 md:flex-col md:py-5" aria-label="Vault">
            {(
              [
                ["upload", "New upload", <UploadIcon key="u" />],
                ["files", "Your files", <StackIcon key="f" />],
                ["versions", "Versions", <HistoryIcon key="v" />],
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                aria-current={vaultTab === id ? "page" : undefined}
                onClick={() => setVaultTab(id)}
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors md:flex-none md:justify-start ${
                  vaultTab === id ? "bg-blush text-ink shadow-sm" : "text-ink hover:bg-paper"
                }`}
              >
                <span className={vaultTab === id ? "text-ink" : "text-muted"}>{icon}</span>
                {label}
              </button>
            ))}
          </nav>
        </aside>

        <section className="min-w-0 flex-1 px-4 py-6 sm:px-6">
          {error ? (
            <Banner tone="bad" className="mb-4">
              {error}
            </Banner>
          ) : null}
          {notice ? (
            <Banner tone="ok" className="mb-4">
              {notice}
            </Banner>
          ) : null}

          {vaultTab === "upload" ? (
            <form onSubmit={storeVersion} className="mx-auto max-w-2xl rounded-3xl border border-line bg-panel p-5 shadow-[0_20px_50px_-32px_rgba(27,24,19,0.5)] sm:p-7">
              <p className={kickerClass}>Store</p>
              <h2 className="mt-2 font-serif text-3xl font-semibold tracking-tight">New version</h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                Type a name and some text, or drop a file. Saving the same name again keeps the previous copy.
              </p>

              <label
                htmlFor="file"
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  takeFile(event.dataTransfer.files?.[0] ?? null);
                }}
                className={`mt-6 block cursor-pointer rounded-2xl border border-dashed px-4 py-8 text-center transition-colors ${
                  dragOver || file ? "border-blush bg-blush-soft/70" : "border-line bg-paper/70 hover:border-blush/70"
                }`}
              >
                <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-panel text-blush-deep">
                  <UploadIcon />
                </span>
                <span className="mt-3 block text-sm">
                  {file ? file.name : "Drop a file here, or click to choose one"}
                </span>
                <span className="mt-1 block text-xs text-muted">
                  {file ? `${formatSize(file.size)} · ${file.type || "unknown type"}` : "Any file Locket accepts"}
                </span>
                <input
                  id="file"
                  type="file"
                  onChange={(event) => takeFile(event.target.files?.[0] ?? null)}
                  className="sr-only"
                />
              </label>
              {file ? (
                <button type="button" className={`${linkClass} mt-3`} onClick={() => takeFile(null)}>
                  Use the text box instead of {file.name}
                </button>
              ) : null}

              <Field label="File name" htmlFor="file-name" className="mt-6">
                <input
                  id="file-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={Boolean(file)}
                  className={`${fieldClass} font-mono`}
                />
              </Field>

              <Field label="Contents" htmlFor="contents" className="mt-4">
                <textarea
                  id="contents"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  disabled={Boolean(file)}
                  rows={8}
                  className={`${fieldClass} min-h-40 resize-y font-mono`}
                  placeholder="version 1 — original contents"
                />
              </Field>

              <button type="submit" disabled={busy} className={`${primaryBtnClass} mt-5`}>
                {busy ? "Working…" : "Store version"}
              </button>
            </form>
          ) : null}

          {vaultTab === "files" ? (
            <div className="mx-auto max-w-3xl">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className={kickerClass}>Library</p>
                  <h2 className="mt-2 font-serif text-3xl font-semibold tracking-tight">Your files</h2>
                  {truncated ? <p className="mt-1 text-xs text-muted">Showing the first page of versions.</p> : null}
                </div>
                <label className="block text-sm sm:w-64" htmlFor="search">
                  <span className="sr-only">Search files</span>
                  <input
                    id="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by name"
                    className={fieldClass}
                  />
                </label>
              </div>

              <ul className="mt-5 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_18px_40px_-30px_rgba(27,24,19,0.55)]">
                {listLoading ? (
                  <EmptyRow>Loading objects…</EmptyRow>
                ) : objects.length === 0 ? (
                  <EmptyRow>
                    {error ? (
                      "Could not load your files."
                    ) : (
                      <>
                        Nothing is stored in your folder yet.{" "}
                        <button type="button" className={linkClass} onClick={() => setVaultTab("upload")}>
                          Add the first file
                        </button>
                      </>
                    )}
                  </EmptyRow>
                ) : visibleObjects.length === 0 ? (
                  <EmptyRow>No files match “{query}”.</EmptyRow>
                ) : (
                  visibleObjects.map((object) => {
                    const selected = object.key === selectedKey;
                    const extension = fileExtension(object.key);
                    return (
                      <li key={object.key}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedKey(object.key);
                            setVaultTab("versions");
                          }}
                          className={`flex w-full items-start gap-3 px-4 py-4 text-left transition-colors ${
                            selected ? "bg-blush-soft/60" : "hover:bg-paper/80"
                          }`}
                        >
                          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-paper text-blush-deep">
                            <FileIcon kind={extension} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{fileName(object.key)}</span>
                            <span className="mt-1 block text-xs text-muted">
                              {`${object.versionCount} ${object.versionCount === 1 ? "version" : "versions"} · ${formatSize(object.size)} · ${formatWhen(object.lastModified)}`}
                            </span>
                          </span>
                          <span className="mt-1 hidden text-xs text-muted sm:block">Open versions</span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          ) : null}

          {vaultTab === "versions" ? (
            <div className="mx-auto max-w-3xl">
              <p className={kickerClass}>History</p>
              <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="font-serif text-3xl font-semibold tracking-tight">Versions</h2>
                  <p className="mt-1 text-sm text-muted">{selectedKey ? fileName(selectedKey) : "Choose a file first"}</p>
                </div>
                <button type="button" className={ghostBtnClass} onClick={() => setVaultTab("files")}>
                  Back to files
                </button>
              </div>

              <ul className="relative mt-5 space-y-3">
                {versionsLoading ? (
                  <li className="rounded-2xl border border-line bg-panel px-4 py-5 text-sm text-muted">Loading versions…</li>
                ) : versions.length === 0 ? (
                  <li className="rounded-2xl border border-line bg-panel px-4 py-5 text-sm text-muted">
                    {selectedKey ? "No copies yet." : "Pick a file from Your files to see its history."}
                  </li>
                ) : (
                  versions.map((entry, index) => (
                    <li key={entry.versionId} className="rounded-2xl border border-line bg-panel px-4 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium">
                              {entry.kind === "delete-marker" ? "Removed" : index === 0 ? "Latest" : "Earlier"}
                            </p>
                            {entry.isLatest && entry.kind === "version" ? (
                              <span className="rounded-full bg-blush-soft px-2 py-0.5 text-[11px] text-blush-deep">Current</span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs text-muted">
                            {entry.kind === "delete-marker" ? "This copy was removed" : formatSize(entry.size)} ·{" "}
                            {formatWhen(entry.lastModified)}
                          </p>
                        </div>
                        {entry.kind === "version" ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => openVersion(entry)}
                            className={`${ghostBtnClass} shrink-0`}
                          >
                            {busy ? "Opening…" : "Open"}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))
                )}
              </ul>

              {preview ? (
                <article className="mt-5 overflow-hidden rounded-2xl border border-line bg-panel">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <div>
                      <h3 className="text-sm font-medium">{preview.isLatest ? "Latest copy" : "Earlier copy"}</h3>
                      <p className="mt-1 text-xs text-muted">{preview.contentType}</p>
                    </div>
                    {preview.downloadUrl ? (
                      <a className={ghostBtnClass} href={preview.downloadUrl} download={preview.key.split("/").pop()}>
                        Download
                      </a>
                    ) : null}
                  </div>
                  {preview.text != null ? (
                    <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap bg-paper/70 px-4 py-4 font-mono text-sm leading-6">
                      {preview.text}
                    </pre>
                  ) : preview.downloadUrl && preview.contentType.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={preview.downloadUrl} alt={fileName(preview.key)} className="max-h-[28rem] w-full object-contain bg-paper/70 p-4" />
                  ) : preview.downloadUrl ? (
                    <p className="px-4 py-6 text-sm text-muted">This version is ready to download.</p>
                  ) : null}
                </article>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="group flex items-center gap-3">
      <span
        className={`grid place-items-center rounded-[1.4rem] bg-panel shadow-[0_10px_24px_-16px_rgba(196,122,122,0.9)] ring-1 ring-blush-soft ${
          compact ? "h-12 w-12" : "h-16 w-16"
        }`}
      >
        <LocketMark size={compact ? 40 : 54} />
      </span>
      <span>
        <span className={`block font-serif font-semibold leading-none tracking-tight text-ink ${compact ? "text-2xl" : "text-4xl"}`}>
          Locket
        </span>
        {compact ? null : <span className="mt-1.5 block text-sm font-medium text-muted">A private folder, kept close</span>}
      </span>
    </div>
  );
}

function LocketMark({ size = 42 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 72 72"
      className="locket-mark"
      role="img"
      aria-label="Locket"
    >
      <path d="M18 11h8.2" stroke="#C47A7A" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M45.8 11H54" stroke="#C47A7A" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="16.4" cy="11" r="1.5" fill="#C47A7A" />
      <circle cx="55.6" cy="11" r="1.5" fill="#C47A7A" />
      <circle cx="36" cy="11" r="5.2" fill="#FCF8F8" stroke="#C47A7A" strokeWidth="2.2" />
      <circle cx="36" cy="11" r="1.7" fill="#F5AFAF" />
      <path d="M36 16.3v4.2" stroke="#C47A7A" strokeWidth="2.2" strokeLinecap="round" />

      <ellipse cx="26" cy="44" rx="16.5" ry="20" fill="#F5AFAF" stroke="#C47A7A" strokeWidth="1.6" />
      <ellipse cx="26" cy="44" rx="10.8" ry="13.6" fill="#FCF8F8" />
      <text
        x="26"
        y="50"
        textAnchor="middle"
        fill="#C47A7A"
        fontFamily="Georgia, 'Iowan Old Style', serif"
        fontSize="15"
        fontStyle="italic"
      >
        L
      </text>

      <g className="locket-lid">
        <ellipse cx="49" cy="42" rx="14.5" ry="18.2" fill="#C47A7A" />
        <ellipse cx="49" cy="42" rx="9" ry="12" fill="#FBEFEF" fillOpacity="0.55" />
        <path
          d="M44 31c7 2 11.5 8 10 17"
          fill="none"
          stroke="#FCF8F8"
          strokeWidth="1.7"
          strokeLinecap="round"
          opacity="0.9"
        />
        <circle className="locket-gleam" cx="45.5" cy="34.5" r="1.8" fill="#FCF8F8" />
      </g>

      <circle cx="36.2" cy="40" r="2" fill="#FCF8F8" stroke="#C47A7A" strokeWidth="1.2" />
      <circle cx="36.2" cy="48.4" r="2" fill="#FCF8F8" stroke="#C47A7A" strokeWidth="1.2" />
    </svg>
  );
}

function Field({
  label,
  htmlFor,
  children,
  className = "",
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block text-sm ${className}`} htmlFor={htmlFor}>
      <span className="mb-1.5 block text-muted">{label}</span>
      {children}
    </label>
  );
}

function Banner({
  tone,
  children,
  className = "",
}: {
  tone: "ok" | "bad";
  children: ReactNode;
  className?: string;
}) {
  const styles =
    tone === "ok"
      ? "border-blush/40 bg-blush-soft text-blush-deep"
      : "border-clay/25 bg-clay-soft text-clay";
  return (
    <p className={`rounded-xl border px-3 py-2 text-sm ${styles} ${className}`} role={tone === "bad" ? "alert" : undefined}>
      {children}
    </p>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return <li className="px-4 py-8 text-center text-sm text-muted">{children}</li>;
}

function FileIcon({ kind }: { kind: string }) {
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(kind)) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="8.5" cy="10" r="1.4" />
        <path d="M21 16l-5.5-5.5L7 19" />
      </svg>
    );
  }
  if (["json", "js", "ts", "tsx", "css", "html", "xml", "yml", "yaml"].includes(kind)) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M8 8l-4 4 4 4M16 8l4 4-4 4" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 16V5" />
      <path d="M8 9l4-4 4 4" />
      <path d="M5 19h14" />
    </svg>
  );
}

function StackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 8l8-4 8 4-8 4z" />
      <path d="M4 12l8 4 8-4" />
      <path d="M4 16l8 4 8-4" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 2.3-5.6" />
      <path d="M4 4v5h5" />
      <path d="M12 8v5l3 2" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
      <path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c5.5 0 9.5 4.2 11 7-1 1.8-2.6 3.8-4.7 5.2M6.1 6.1C4.2 7.4 2.7 9.2 1 12c1.5 2.8 5.5 7 11 7 1.3 0 2.5-.2 3.6-.7" />
    </svg>
  );
}
