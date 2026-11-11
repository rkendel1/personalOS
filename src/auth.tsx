import { useState, type FormEvent } from "react";
import { useFeltKit, useSession, type FeltKitClientError } from "@feltdb/feltkit/react";

export function describe(error: unknown): string {
  const e = error as FeltKitClientError;
  if (e?.code === "FORBIDDEN") return `Not allowed: ${e.message}. Switch to a member to make changes.`;
  if (e?.code === "UNAUTHORIZED") return "Sign in to continue.";
  if (e?.code === "CONFLICT") return e.message;
  return e?.message ?? String(error);
}

export function SignedOut(props: {
  devUsers: Array<{ id: string; name: string; roles: string[] }>;
  accounts: { signUp: boolean; email?: boolean; providers?: Array<{ id: string; name: string }> } | null;
  onDevSignIn: (id: string) => void;
  onSignIn: (input: { email: string; password: string }) => Promise<void>;
  onSignUp: (input: { email: string; password: string; name?: string }) => Promise<void>;
}) {
  return (
    <div className="center">
      <div className="card narrow">
        {props.devUsers.length ? (
          <>
            <h1>Sign in</h1>
            <p className="muted">Development identities from feltkit/app.ts:</p>
            <div className="stack">
              {props.devUsers.map((u) => (
                <button key={u.id} className="secondary wide" onClick={() => props.onDevSignIn(u.id)}>
                  {u.name} <span className="muted">· {u.roles.join(", ")}</span>
                </button>
              ))}
            </div>
          </>
        ) : props.accounts ? (
          <AccountForm signUpOpen={props.accounts.signUp} email={Boolean(props.accounts.email)} providers={props.accounts.providers ?? []} onSignIn={props.onSignIn} onSignUp={props.onSignUp} />
        ) : (
          <SessionForm />
        )}
      </div>
    </div>
  );
}

/**
 * No dev users and no accounts: access is given by whoever operates the deployment (on AppBoundry,
 * `appboundry admin sessions issue --user <id>`). The session they hand over is pasted here; the
 * server decides whether it is valid, and what it may do.
 */
function SessionForm() {
  const client = useFeltKit();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      client.setToken(token.trim());
      const session = await client.session();
      if (!session.principal) {
        client.setToken(null);
        setError("That session isn't valid, or it has expired or been revoked. Ask your operator for a new one.");
      }
    } catch (err) {
      client.setToken(null);
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h1>Sign in</h1>
      <p className="muted">Access to this app is given by its operator. Paste the session they issued you.</p>
      <label className="field">
        <span>Session</span>
        <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="abs_…" required autoFocus />
      </label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="wide" type="submit" disabled={busy || !token.trim()}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

/** Sign in to an existing account, or create one (auth.accounts in feltkit/app.ts). */
function AccountForm(props: {
  signUpOpen: boolean;
  /** The app sends account e-mail (auth.accounts.email): offer "forgot password". */
  email: boolean;
  providers: Array<{ id: string; name: string }>;
  onSignIn: (input: { email: string; password: string }) => Promise<void>;
  onSignUp: (input: { email: string; password: string; name?: string }) => Promise<void>;
}) {
  const client = useFeltKit();
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const creating = mode === "signup";
  const forgot = mode === "forgot";
  const go = (next: typeof mode) => (setMode(next), setError(null), setInfo(null));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (forgot) setInfo((await client.requestPasswordReset(email)).message);
      else if (creating) {
        await props.onSignUp({ email, password, ...(name.trim() ? { name: name.trim() } : {}) });
        if (!client.tokens.get()) setInfo("Check your e-mail: open the link we sent to verify your address, then sign in.");
      } else await props.onSignIn({ email, password });
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h1>{forgot ? "Reset your password" : creating ? "Create your account" : "Sign in"}</h1>
      {!forgot &&
        props.providers.map((p) => (
          <button key={p.id} type="button" className="secondary wide" onClick={() => client.signInWith(p.id)}>
            Continue with {p.name}
          </button>
        ))}
      {!forgot && props.providers.length > 0 && <p className="muted small-text">or with your e-mail address</p>}
      {creating && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" autoComplete="name" />}
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail" aria-label="E-mail" autoComplete="email" required />
      {!forgot && (
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={creating ? "Password (12+ characters)" : "Password"}
          aria-label="Password"
          autoComplete={creating ? "new-password" : "current-password"}
          minLength={creating ? 12 : undefined}
          required
        />
      )}
      {error && <p className="error-text">{error}</p>}
      {info && <p className="muted">{info}</p>}
      <button type="submit" disabled={busy || !email || (!forgot && !password)}>
        {busy ? "One moment…" : forgot ? "Send reset link" : creating ? "Create account" : "Sign in"}
      </button>
      {mode === "signin" && props.email && (
        <p className="muted small-text">
          <button type="button" className="link" onClick={() => go("forgot")}>
            Forgot your password?
          </button>
        </p>
      )}
      {(props.signUpOpen || forgot) && (
        <p className="muted small-text">
          {forgot ? "Remembered it? " : creating ? "Already have an account? " : "New here? "}
          <button type="button" className="link" onClick={() => go(creating || forgot ? "signin" : "signup")}>
            {creating || forgot ? "Sign in" : "Create an account"}
          </button>
        </p>
      )}
    </form>
  );
}

/** A password reset link opened: choose a new password. */
export function ResetForm({ token, onDone }: { token: string; onDone: () => void }) {
  const client = useFeltKit();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await client.resetPassword(token, password);
      onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h1>Choose a new password</h1>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password (12+ characters)" aria-label="New password" autoComplete="new-password" minLength={12} required />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={busy || !password}>
        {busy ? "One moment…" : "Set password and sign in"}
      </button>
    </form>
  );
}

