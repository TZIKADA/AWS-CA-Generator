import { useEffect, useState } from "react";

const AUTH_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN as string | undefined;
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const TOKEN_KEY = "sigvault_id_token";

function loginUrl(): string {
    if (!AUTH_DOMAIN || !CLIENT_ID) return "#";
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        scope: "openid email profile",
        redirect_uri: `${window.location.origin}/auth/callback`,
    });
    return `https://${AUTH_DOMAIN}/oauth2/authorize?${params}`;
}

export default function App() {
    const [health, setHealth] = useState<string>("…");

    useEffect(() => {
        fetch("/api/health")
            .then((r) => r.json())
            .then((j) => setHealth(String(j.status)))
            .catch((e) => setHealth(String(e)));
    }, []);

    return (
        <main style={{ fontFamily: "system-ui, sans-serif", padding: 32 }}>
            <h1>SigVault</h1>
            <p>
                API health: <strong>{health}</strong>
            </p>
            <p>
                <a href={loginUrl()}>Sign in</a>
            </p>
        </main>
    );
}
