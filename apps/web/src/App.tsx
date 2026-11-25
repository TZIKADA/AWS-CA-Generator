import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import "./App.css";

const AUTH_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN as string | undefined;
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const TOKEN_KEY = "sigvault_id_token";
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_PRIVATE_KEY_LENGTH = 65_536;
const KEY_ALGORITHMS = ["RSA_2048", "RSA_3072", "RSA_4096", "ECDSA_P256", "ECDSA_P384"];

type Organization = { id: string; name: string };
type SigningKey = {
    id: string;
    label: string;
    algorithm: string;
    fingerprint: string;
    created_at: string;
    revoked_at: string | null;
};
type DocumentRecord = {
    id: string;
    filename: string;
    status: "uploaded" | "queued" | "signed" | "failed";
    created_at: string;
};
type UploadResponse = { document_id: string; upload_url: string };

async function sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

async function loginUrl(): Promise<string> {
    if (!AUTH_DOMAIN || !CLIENT_ID) return "#";
    const verifier = crypto.randomUUID().replaceAll("-", "");
    const state = crypto.randomUUID();
    sessionStorage.setItem("pkce_verifier", verifier);
    sessionStorage.setItem("oauth_state", state);
    const challenge = await sha256(verifier);
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        scope: "openid email profile",
        redirect_uri: `${window.location.origin}/auth/callback`,
        code_challenge_method: "S256",
        code_challenge: challenge,
        state,
    });
    return `https://${AUTH_DOMAIN}/oauth2/authorize?${params}`;
}

async function apiRequest(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(path, { ...init, headers });
    if (!response.ok) {
        const responseText = await response.text();
        let message = `Request failed (${response.status})`;
        if (responseText) {
            try {
                const body: unknown = JSON.parse(responseText);
                if (
                    typeof body === "object" &&
                    body !== null &&
                    "detail" in body &&
                    typeof body.detail === "string"
                ) {
                    message = body.detail;
                } else {
                    message = responseText;
                }
            } catch {
                message = responseText;
            }
        }
        throw new Error(message);
    }
    return response;
}

function messageFrom(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export default function App() {
    const [health, setHealth] = useState("Checking");
    const [token, setToken] = useState<string | null>(() => {
        const sessionToken = sessionStorage.getItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_KEY);
        return sessionToken;
    });
    const [orgName, setOrgName] = useState("");
    const [assistantPrompt, setAssistantPrompt] = useState("");
    const [isAssisting, setIsAssisting] = useState(false);
    const [orgs, setOrgs] = useState<Organization[]>([]);
    const [selectedOrgId, setSelectedOrgId] = useState("");
    const [keys, setKeys] = useState<SigningKey[]>([]);
    const [documents, setDocuments] = useState<DocumentRecord[]>([]);
    const [keyLabel, setKeyLabel] = useState("");
    const [keyAlgorithm, setKeyAlgorithm] = useState(KEY_ALGORITHMS[1]);
    const [privateKey, setPrivateKey] = useState("");
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [selectedKeyId, setSelectedKeyId] = useState("");
    const [busy, setBusy] = useState(false);
    const [loadingWorkspace, setLoadingWorkspace] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const workspaceRequest = useRef(0);
    const callbackStarted = useRef(false);

    useEffect(() => {
        fetch("/api/health")
            .then(async (response) => {
                if (!response.ok) throw new Error(`API health check failed (${response.status})`);
                return response.json();
            })
            .then((body: { status: string }) => setHealth(body.status))
            .catch((cause: unknown) => setHealth(`Unavailable: ${messageFrom(cause)}`));
    }, []);

    useEffect(() => {
        const callback = new URL(window.location.href);
        if (callback.pathname !== "/auth/callback" || callbackStarted.current) return;
        callbackStarted.current = true;
        const code = callback.searchParams.get("code");
        const state = callback.searchParams.get("state");
        const expectedState = sessionStorage.getItem("oauth_state");
        if (!code || !state || !expectedState || state !== expectedState) {
            setError("Sign-in callback is invalid.");
            return;
        }
        if (!AUTH_DOMAIN || !CLIENT_ID) {
            setError("Cognito environment variables are not configured.");
            return;
        }
        const verifier = sessionStorage.getItem("pkce_verifier");
        if (!verifier) {
            setError("Sign-in request was interrupted.");
            return;
        }
        fetch(`https://${AUTH_DOMAIN}/oauth2/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: CLIENT_ID,
                code,
                redirect_uri: `${window.location.origin}/auth/callback`,
                code_verifier: verifier,
            }),
        })
            .then(async (response) => {
                const body = await response.json();
                if (!response.ok) throw new Error(body.error_description || "Sign-in failed");
                if (!body.id_token) throw new Error("Cognito did not return an ID token");
                sessionStorage.setItem(TOKEN_KEY, body.id_token);
                sessionStorage.removeItem("pkce_verifier");
                sessionStorage.removeItem("oauth_state");
                setToken(body.id_token);
                window.history.replaceState({}, "", "/");
            })
            .catch((cause: unknown) => setError(messageFrom(cause)));
    }, []);

    useEffect(() => {
        if (!token) {
            setOrgs([]);
            setSelectedOrgId("");
            setKeys([]);
            setDocuments([]);
            return;
        }
        apiRequest("/api/orgs", token)
            .then((response) => response.json())
            .then((rows: Organization[]) => setOrgs(rows))
            .catch((cause: unknown) => setError(`Could not load organizations: ${messageFrom(cause)}`));
    }, [token]);

    useEffect(() => {
        if (orgs.length === 0) {
            setSelectedOrgId("");
        } else if (!orgs.some((org) => org.id === selectedOrgId)) {
            setSelectedOrgId(orgs[0].id);
        }
    }, [orgs, selectedOrgId]);

    const refreshWorkspace = useCallback(async () => {
        if (!token || !selectedOrgId) {
            setKeys([]);
            setDocuments([]);
            return;
        }
        const requestId = ++workspaceRequest.current;
        setLoadingWorkspace(true);
        try {
            const orgPath = `/api/orgs/${encodeURIComponent(selectedOrgId)}`;
            const [keysResponse, documentsResponse] = await Promise.all([
                apiRequest(`${orgPath}/keys`, token),
                apiRequest(`${orgPath}/documents`, token),
            ]);
            const [keyRows, documentRows] = await Promise.all([
                keysResponse.json() as Promise<SigningKey[]>,
                documentsResponse.json() as Promise<DocumentRecord[]>,
            ]);
            if (requestId === workspaceRequest.current) {
                setKeys(keyRows);
                setDocuments(documentRows);
            }
        } finally {
            if (requestId === workspaceRequest.current) setLoadingWorkspace(false);
        }
    }, [selectedOrgId, token]);

    useEffect(() => {
        workspaceRequest.current += 1;
        if (!selectedOrgId || !token) {
            setKeys([]);
            setDocuments([]);
            setLoadingWorkspace(false);
            return;
        }
        setKeys([]);
        setDocuments([]);
        refreshWorkspace().catch((cause: unknown) =>
            setError(`Could not load organization data: ${messageFrom(cause)}`),
        );
    }, [refreshWorkspace, selectedOrgId, token]);

    useEffect(() => {
        if (!token || !selectedOrgId || !documents.some((document) => document.status === "queued")) {
            return;
        }
        const timer = window.setInterval(() => {
            refreshWorkspace().catch((cause: unknown) =>
                setError(`Could not refresh signing status: ${messageFrom(cause)}`),
            );
        }, 3000);
        return () => window.clearInterval(timer);
    }, [documents, refreshWorkspace, selectedOrgId, token]);

    useEffect(() => {
        const usableKey = keys.find((key) => !key.revoked_at);
        if (!usableKey) {
            setSelectedKeyId("");
        } else if (!keys.some((key) => key.id === selectedKeyId && !key.revoked_at)) {
            setSelectedKeyId(usableKey.id);
        }
    }, [keys, selectedKeyId]);

    async function createOrg(event: FormEvent) {
        event.preventDefault();
        if (!token) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const response = await apiRequest("/api/orgs", token, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: orgName.trim() }),
            });
            const created = (await response.json()) as Organization;
            setOrgs((current) => [...current, created]);
            setSelectedOrgId(created.id);
            setOrgName("");
            setNotice(`Organization "${created.name}" created.`);
        } catch (cause: unknown) {
            setError(`Could not create organization: ${messageFrom(cause)}`);
        } finally {
            setBusy(false);
        }
    }

    async function suggestOrganizationName() {
        if (!token) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        setIsAssisting(true);
        try {
            const response = await apiRequest("/api/assistant/organization-name", token, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: assistantPrompt }),
            });
            const body = (await response.json()) as { name: string };
            setOrgName(body.name);
        } catch (cause: unknown) {
            setError(`Could not suggest a name: ${messageFrom(cause)}`);
        } finally {
            setIsAssisting(false);
            setBusy(false);
        }
    }

    async function createKey(event: FormEvent) {
        event.preventDefault();
        if (!token || !selectedOrgId) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await apiRequest(`/api/orgs/${encodeURIComponent(selectedOrgId)}/keys`, token, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    label: keyLabel.trim(),
                    algorithm: keyAlgorithm,
                    private_key_armored: privateKey.trim(),
                }),
            });
            setKeyLabel("");
            setPrivateKey("");
            await refreshWorkspace();
            setNotice("Signing key registered.");
        } catch (cause: unknown) {
            setError(`Could not register signing key: ${messageFrom(cause)}`);
        } finally {
            setBusy(false);
        }
    }

    async function revokeKey(key: SigningKey) {
        if (!token || !selectedOrgId) return;
        if (!window.confirm(`Revoke "${key.label}"? It will no longer be available for signing.`)) {
            return;
        }
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await apiRequest(
                `/api/orgs/${encodeURIComponent(selectedOrgId)}/keys/${encodeURIComponent(key.id)}`,
                token,
                { method: "DELETE" },
            );
            await refreshWorkspace();
            setNotice(`Signing key "${key.label}" revoked.`);
        } catch (cause: unknown) {
            setError(`Could not revoke signing key: ${messageFrom(cause)}`);
        } finally {
            setBusy(false);
        }
    }

    async function uploadDocument(event: FormEvent) {
        event.preventDefault();
        if (!token || !selectedOrgId || !selectedFile) return;
        if (selectedFile.size > MAX_DOCUMENT_BYTES) {
            setError("The signing worker accepts files up to 5 MiB.");
            return;
        }
        const contentType = selectedFile.type || "application/octet-stream";
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const response = await apiRequest(
                `/api/orgs/${encodeURIComponent(selectedOrgId)}/documents`,
                token,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ filename: selectedFile.name, content_type: contentType }),
                },
            );
            const upload = (await response.json()) as UploadResponse;
            const uploadResponse = await fetch(upload.upload_url, {
                method: "PUT",
                headers: { "Content-Type": contentType },
                body: selectedFile,
            });
            if (!uploadResponse.ok) {
                throw new Error(`File upload failed (${uploadResponse.status})`);
            }
            const filename = selectedFile.name;
            setSelectedFile(null);
            if (fileInput.current) fileInput.current.value = "";
            await refreshWorkspace();
            setNotice(`"${filename}" uploaded and ready to sign.`);
        } catch (cause: unknown) {
            setError(`Could not upload document: ${messageFrom(cause)}`);
        } finally {
            setBusy(false);
        }
    }

    async function signDocument(document: DocumentRecord) {
        if (!token || !selectedOrgId || !selectedKeyId) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await apiRequest(
                `/api/orgs/${encodeURIComponent(selectedOrgId)}/documents/${encodeURIComponent(document.id)}/sign`,
                token,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key_id: selectedKeyId }),
                },
            );
            await refreshWorkspace();
            setNotice(`Signing started for "${document.filename}".`);
        } catch (cause: unknown) {
            setError(`Could not start signing: ${messageFrom(cause)}`);
        } finally {
            setBusy(false);
        }
    }

    async function downloadSignature(record: DocumentRecord) {
        if (!token || !selectedOrgId) return;
        setError(null);
        try {
            const response = await apiRequest(
                `/api/orgs/${encodeURIComponent(selectedOrgId)}/documents/${encodeURIComponent(record.id)}/download`,
                token,
            );
            const body = (await response.json()) as { download_url: string };
            const signatureResponse = await fetch(body.download_url);
            if (!signatureResponse.ok) {
                throw new Error(`Signature download failed (${signatureResponse.status})`);
            }
            const objectUrl = URL.createObjectURL(await signatureResponse.blob());
            const link = window.document.createElement("a");
            link.href = objectUrl;
            link.download = `${record.filename.replace(/[\\/]/g, "_")}.sig`;
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        } catch (cause: unknown) {
            setError(`Could not get signature download: ${messageFrom(cause)}`);
        }
    }

    async function signIn() {
        window.location.assign(await loginUrl());
    }

    function signOut() {
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem("pkce_verifier");
        sessionStorage.removeItem("oauth_state");
        setToken(null);
        setPrivateKey("");
        setSelectedFile(null);
        if (fileInput.current) fileInput.current.value = "";
        setError(null);
        setNotice(null);
        if (AUTH_DOMAIN && CLIENT_ID) {
            const params = new URLSearchParams({
                client_id: CLIENT_ID,
                logout_uri: `${window.location.origin}/`,
            });
            window.location.assign(`https://${AUTH_DOMAIN}/logout?${params}`);
        }
    }

    const activeKeys = keys.filter((key) => !key.revoked_at);

    return (
        <main className="app-shell">
            <header className="topbar">
                <a className="brand" href="/" aria-label="SigVault home">
                    <span className="brand-mark" aria-hidden="true">S</span>
                    <span>SigVault</span>
                </a>
                <div className="topbar-actions">
                    <span className={`health-indicator ${health === "ok" ? "is-healthy" : ""}`}>
                        <span className="health-dot" />
                        API {health}
                    </span>
                    {token && <button className="button button-quiet" onClick={signOut}>Sign out</button>}
                </div>
            </header>

            {error && <div className="alert alert-error" role="alert">{error}</div>}
            {notice && <div className="alert alert-success" role="status">{notice}</div>}

            {!token ? (
                <section className="welcome-card">
                    <p className="eyebrow">DOCUMENT SIGNING, SIMPLIFIED</p>
                    <h1>Keep important documents verifiable.</h1>
                    <p className="welcome-copy">
                        Organize your signing keys, sign documents with PGP, and download
                        detached signatures from one secure workspace.
                    </p>
                    <button className="button button-primary" type="button" onClick={signIn}
                        disabled={!AUTH_DOMAIN || !CLIENT_ID}>
                        Sign in
                    </button>
                    {(!AUTH_DOMAIN || !CLIENT_ID) && (
                        <p className="helper-text">Cognito sign-in is not configured for this app.</p>
                    )}
                </section>
            ) : (
                <div className="workspace">
                    <section className="page-heading">
                        <div>
                            <p className="eyebrow">YOUR WORKSPACE</p>
                            <h1>Document signing</h1>
                            <p className="muted">Manage organizations, signing keys, and signed documents.</p>
                        </div>
                    </section>

                    <section className="panel organization-panel">
                        <div className="panel-heading">
                            <div>
                                <p className="eyebrow">ORGANIZATION</p>
                                <h2>Choose a workspace</h2>
                            </div>
                            {orgs.length > 0 && (
                                <label className="select-label">
                                    <span className="visually-hidden">Selected organization</span>
                                    <select value={selectedOrgId} disabled={busy}
                                        onChange={(event) => {
                                            setSelectedOrgId(event.target.value);
                                            setPrivateKey("");
                                            setSelectedFile(null);
                                            if (fileInput.current) fileInput.current.value = "";
                                            setError(null);
                                            setNotice(null);
                                        }}>
                                        {orgs.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
                                    </select>
                                </label>
                            )}
                        </div>
                        <div className="organization-create">
                            <form className="form-grid" onSubmit={createOrg}>
                                <label>
                                    <span>Organization name</span>
                                    <input value={orgName} onChange={(event) => setOrgName(event.target.value)}
                                        maxLength={200} required placeholder="e.g. Acme Research" />
                                </label>
                                <button className="button button-secondary" type="submit"
                                    disabled={busy || !orgName.trim()}>
                                    Create organization
                                </button>
                            </form>
                            <details className="ai-suggestion">
                                <summary>Suggest a name with AI</summary>
                                <form className="suggest-form" onSubmit={(event) => {
                                    event.preventDefault();
                                    void suggestOrganizationName();
                                }}>
                                    <label>
                                        <span>Describe the organization</span>
                                        <textarea value={assistantPrompt}
                                            onChange={(event) => setAssistantPrompt(event.target.value)}
                                            maxLength={2000} required rows={2}
                                            placeholder="What does your organization do?" />
                                    </label>
                                    <button className="button button-quiet" type="submit"
                                        disabled={busy || !assistantPrompt.trim()}>
                                        {isAssisting ? "Suggesting…" : "Suggest name"}
                                    </button>
                                </form>
                            </details>
                        </div>
                    </section>

                    {selectedOrgId ? (
                        <div className="content-grid">
                                <section className="panel">
                                    <div className="panel-heading">
                                        <div>
                                            <p className="eyebrow">SIGNING KEYS</p>
                                            <h2>Key vault</h2>
                                        </div>
                                        <span className="count-badge">{keys.length}</span>
                                    </div>
                                    <form className="stack-form" onSubmit={createKey}>
                                        <label>
                                            <span>Key label</span>
                                            <input value={keyLabel} onChange={(event) => setKeyLabel(event.target.value)}
                                                maxLength={120} required placeholder="e.g. Demo signing key" />
                                        </label>
                                        <label>
                                            <span>Algorithm</span>
                                            <select value={keyAlgorithm}
                                                onChange={(event) => setKeyAlgorithm(event.target.value)}>
                                                {KEY_ALGORITHMS.map((algorithm) =>
                                                    <option key={algorithm} value={algorithm}>{algorithm.replace("_", " ")}</option>,
                                                )}
                                            </select>
                                        </label>
                                        <label>
                                            <span>Unprotected PGP private key</span>
                                            <textarea value={privateKey}
                                                onChange={(event) => setPrivateKey(event.target.value)}
                                                maxLength={MAX_PRIVATE_KEY_LENGTH}
                                                autoComplete="off" required rows={5} spellCheck={false}
                                                placeholder={"-----BEGIN PGP PRIVATE KEY BLOCK-----\nPaste a disposable test key"} />
                                        </label>
                                        <p className="helper-text">
                                            Use an unprotected test key only. The key is sent to the API and
                                            stored in the document bucket. Select the key's matching algorithm.
                                        </p>
                                        <button className="button button-primary" type="submit"
                                            disabled={busy || !keyLabel.trim() || !privateKey.trim()}>
                                            Register signing key
                                        </button>
                                    </form>
                                    <div className="item-list">
                                        {keys.length === 0 ? (
                                            <p className="empty-state">No signing keys registered yet.</p>
                                        ) : keys.map((key) => (
                                            <article className="list-item" key={key.id}>
                                                <div className="item-main">
                                                    <div className="item-title-row">
                                                        <strong>{key.label}</strong>
                                                        <span className={`status-pill ${key.revoked_at ? "status-muted" : "status-ready"}`}>
                                                            {key.revoked_at ? "Revoked" : "Active"}
                                                        </span>
                                                    </div>
                                                    <span className="item-meta">{key.algorithm.replace("_", " ")}</span>
                                                    <code className="fingerprint">{key.fingerprint}</code>
                                                </div>
                                                {!key.revoked_at && (
                                                    <button className="text-button" type="button" disabled={busy}
                                                        onClick={() => void revokeKey(key)}>
                                                        Revoke
                                                    </button>
                                                )}
                                            </article>
                                        ))}
                                    </div>
                                </section>

                                <section className="panel">
                                    <div className="panel-heading">
                                        <div>
                                            <p className="eyebrow">DOCUMENTS</p>
                                            <h2>Sign a document</h2>
                                        </div>
                                        <span className="count-badge">{documents.length}</span>
                                    </div>
                                    <form className="stack-form" onSubmit={uploadDocument}>
                                        <label className="file-picker">
                                            <span>Choose a document <small>(up to 5 MiB)</small></span>
                                            <input ref={fileInput} type="file" required
                                                onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} />
                                        </label>
                                        {selectedFile && (
                                            <p className="file-selection">
                                                {selectedFile.name} <span>{(selectedFile.size / 1024).toFixed(1)} KiB</span>
                                            </p>
                                        )}
                                        <button className="button button-primary" type="submit"
                                            disabled={busy || !selectedFile || activeKeys.length === 0}>
                                            Upload document
                                        </button>
                                        {activeKeys.length === 0 && (
                                            <p className="helper-text">Register an active signing key before uploading.</p>
                                        )}
                                    </form>
                                    <div className="item-list">
                                        {documents.length === 0 ? (
                                            <p className="empty-state">No documents yet. Upload one to get started.</p>
                                        ) : documents.map((document) => (
                                            <article className="list-item" key={document.id}>
                                                <div className="item-main">
                                                    <div className="item-title-row">
                                                        <strong>{document.filename}</strong>
                                                        <span className={`status-pill status-${document.status}`}>
                                                            {document.status === "queued" ? "Signing…" : document.status}
                                                        </span>
                                                    </div>
                                                    <span className="item-meta">
                                                        {new Date(document.created_at).toLocaleString()}
                                                    </span>
                                                    {document.status === "uploaded" && (
                                                        <label className="inline-key-select">
                                                            <span>Sign with</span>
                                                            <select value={selectedKeyId}
                                                                onChange={(event) => setSelectedKeyId(event.target.value)}>
                                                                {activeKeys.map((key) =>
                                                                    <option key={key.id} value={key.id}>{key.label}</option>,
                                                                )}
                                                            </select>
                                                            <button className="button button-secondary" type="button"
                                                                disabled={busy || !selectedKeyId}
                                                                onClick={() => void signDocument(document)}>
                                                                Sign
                                                            </button>
                                                        </label>
                                                    )}
                                                    {document.status === "queued" && (
                                                        <span className="helper-text">Waiting for the signing worker…</span>
                                                    )}
                                                    {document.status === "signed" && (
                                                        <button className="text-button" type="button"
                                                            onClick={() => void downloadSignature(document)}>
                                                            Download signature
                                                        </button>
                                                    )}
                                                    {document.status === "failed" && (
                                                        <span className="helper-text error-text">
                                                            Signing failed. This document cannot be retried in the current POC.
                                                        </span>
                                                    )}
                                                </div>
                                            </article>
                                        ))}
                                    </div>
                                    {loadingWorkspace && <p className="loading-label">Refreshing workspace…</p>}
                                </section>
                        </div>
                    ) : (
                        <section className="panel empty-workspace">
                            <h2>Create your first organization</h2>
                            <p className="muted">An organization keeps its signing keys and documents together.</p>
                        </section>
                    )}
                </div>
            )}
            <footer className="footer-note">
                SigVault POC · Use disposable keys and non-sensitive documents only.
            </footer>
        </main>
    );
}
