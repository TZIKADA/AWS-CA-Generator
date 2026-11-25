import { useEffect, useState, type FormEvent } from "react";

const AUTH_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN as string | undefined;
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const TOKEN_KEY = "sigvault_id_token";

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

export default function App() {
    const [health, setHealth] = useState<string>("…");
    const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
    const [orgName, setOrgName] = useState("");
    const [assistantPrompt, setAssistantPrompt] = useState("");
    const [isAssisting, setIsAssisting] = useState(false);
    const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch("/api/health")
            .then((r) => r.json())
            .then((j) => setHealth(String(j.status)))
            .catch((e) => setHealth(String(e)));
    }, []);

    useEffect(() => {
        const callback = new URL(window.location.href);
        if (callback.pathname !== "/auth/callback") return;
        const code = callback.searchParams.get("code");
        const state = callback.searchParams.get("state");
        if (!code || state !== sessionStorage.getItem("oauth_state")) {
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
            .then(async (r) => {
                const body = await r.json();
                if (!r.ok) throw new Error(body.error_description || "Sign-in failed");
                if (!body.id_token) throw new Error("Cognito did not return an ID token");
                localStorage.setItem(TOKEN_KEY, body.id_token);
                setToken(body.id_token);
                window.history.replaceState({}, "", "/");
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, []);

    useEffect(() => {
        if (!token) {
            setOrgs([]);
            return;
        }
        fetch("/api/orgs", { headers: { Authorization: `Bearer ${token}` } })
            .then(async (r) => {
                if (!r.ok) throw new Error(`Could not load organizations (${r.status})`);
                return r.json();
            })
            .then((rows) => setOrgs(rows))
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, [token]);

    async function createOrg(event: FormEvent) {
        event.preventDefault();
        if (!token) return;
        setError(null);
        const r = await fetch("/api/orgs", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: orgName }),
        });
        if (!r.ok) {
            setError(`Could not create organization (${r.status})`);
            return;
        }
        setOrgName("");
        const created = await r.json();
        setOrgs((current) => [...current, created]);
    }

    async function suggestOrganizationName() {
        if (!token) return;
        setError(null);
        setIsAssisting(true);
        try {
            const response = await fetch("/api/assistant/organization-name", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ prompt: assistantPrompt }),
            });
            const body = await response.json();
            if (!response.ok) {
                throw new Error(body.detail || `AI assistant failed (${response.status})`);
            }
            setOrgName(body.name);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setIsAssisting(false);
        }
    }

    async function signIn() {
        window.location.assign(await loginUrl());
    }

    function signOut() {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setError(null);
        if (AUTH_DOMAIN && CLIENT_ID) {
            const params = new URLSearchParams({
                client_id: CLIENT_ID,
                logout_uri: `${window.location.origin}/`,
            });
            window.location.assign(`https://${AUTH_DOMAIN}/logout?${params}`);
        }
    }

    return (
        <main style={{ fontFamily: "system-ui, sans-serif", padding: 32 }}>
            <h1>SigVault</h1>
            <p>
                API health: <strong>{health}</strong>
            </p>
            {error && <p style={{ color: "crimson" }}>{error}</p>}
            {!token ? (
                <button type="button" onClick={signIn} disabled={!AUTH_DOMAIN || !CLIENT_ID}>
                    Sign in
                </button>
            ) : (
                <>
                    <button type="button" onClick={signOut}>Sign out</button>
                    <h2>Organizations</h2>
                    <label>
                        Describe your organization
                        <input
                            aria-label="Describe your organization"
                            value={assistantPrompt}
                            onChange={(event) => setAssistantPrompt(event.target.value)}
                            maxLength={2000}
                        />
                    </label>
                    <button
                        type="button"
                        onClick={suggestOrganizationName}
                        disabled={!assistantPrompt.trim() || isAssisting}
                    >
                        {isAssisting ? "Generating..." : "Suggest organization name"}
                    </button>
                    <form onSubmit={createOrg}>
                        <input
                            aria-label="Organization name"
                            value={orgName}
                            onChange={(event) => setOrgName(event.target.value)}
                            maxLength={200}
                            required
                        />
                        <button type="submit">Create</button>
                    </form>
                    <ul>
                        {orgs.map((org) => <li key={org.id}>{org.name}</li>)}
                    </ul>
                </>
            )}
        </main>
    );
}
