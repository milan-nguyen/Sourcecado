// Hosted sign-in. When VITE_SUPABASE_URL is set at build time the app is in
// hosted mode: Supabase Auth with Google holds the session, and its access
// token replaces the local club token on every backend request. Without that
// setting nothing here runs and the app behaves as the local build.
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

export type AuthProblem = "unauthorized" | "not_invited";

export function isHosted(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL);
}

let client: SupabaseClient | null = null;
let accessToken = "";
const problemListeners = new Set<(problem: AuthProblem) => void>();

export function authClient(): SupabaseClient {
  if (!client) {
    client = createClient(import.meta.env.VITE_SUPABASE_URL!, import.meta.env.VITE_SUPABASE_ANON_KEY || "", {
      // PKCE returns `?code=` in the query string. The implicit flow would put
      // tokens in the URL hash, which the hash router owns.
      auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    });
  }
  return client;
}

/** The current Supabase access token, or "" when signed out. Synchronous so apiToken() can read it. */
export function currentAccessToken(): string {
  return accessToken;
}

export function rememberSession(session: Session | null): void {
  accessToken = session?.access_token ?? "";
}

/** Remove the one-time sign-in code (and any sign-in error) from the address bar. */
export function removeCodeFromUrl(): void {
  const url = new URL(window.location.href);
  const params = ["code", "error", "error_code", "error_description"];
  if (!params.some((name) => url.searchParams.has(name))) return;
  for (const name of params) url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export async function signInWithGoogle(): Promise<void> {
  const { error } = await authClient().auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  accessToken = "";
  await authClient().auth.signOut({ scope: "local" });
}

export function onAuthProblem(listener: (problem: AuthProblem) => void): () => void {
  problemListeners.add(listener);
  return () => problemListeners.delete(listener);
}

/**
 * Wrap window.fetch so a 401 `sign_in_required` or a 403 `not_invited` from the
 * backend reaches the sign-in gate, whichever of the app's many request helpers
 * made the call. Any other 401 is left alone: some routes answer 401 when a
 * connector is not connected, and that does not mean the person is signed out.
 * Returns a function that puts the original fetch back.
 */
export function watchBackendResponses(): () => void {
  const original = window.fetch;
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
  const report = (problem: AuthProblem) => problemListeners.forEach((listener) => listener(problem));
  const wrapped: typeof fetch = async (input, init) => {
    const response = await original.call(window, input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (supabaseUrl && url.startsWith(supabaseUrl)) return response;
    if (response.status === 401 || response.status === 403) {
      const body = await response.clone().json().catch(() => null);
      const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
      if (response.status === 401 && error === "sign_in_required") report("unauthorized");
      if (response.status === 403 && error === "not_invited") report("not_invited");
    }
    return response;
  };
  window.fetch = wrapped;
  return () => {
    if (window.fetch === wrapped) window.fetch = original;
  };
}
