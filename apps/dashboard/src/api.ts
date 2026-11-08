/**
 * Client for the local read API. The access token arrives in the URL fragment (never sent to
 * any server), is moved to tab-scoped sessionStorage, and the fragment is removed from the
 * address bar so it is not shared by copy-paste or kept in history.
 */
import type { ApiError } from "@codemap/contracts";

const TOKEN_KEY = "codemap.token";
let token: string | null = null;
/** Non-secret launch options passed in the fragment, e.g. project=<id>. */
export const launchParams = new URLSearchParams();

export function initToken(): boolean {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{16,128})/.exec(location.hash);
  if (m) {
    token = m[1]!;
    for (const [k, v] of new URLSearchParams(location.hash.slice(1))) if (k !== "token" && /^[A-Za-z0-9_]{1,80}$/.test(v)) launchParams.set(k, v);
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage may be unavailable; the in-memory token still works for this page */
    }
    history.replaceState(null, "", location.pathname);
    return true;
  }
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
  return token !== null;
}

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined>;

function url(path: string, params: Params = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return `/api/v1${path}${s ? `?${s}` : ""}`;
}

async function request(path: string, params?: Params): Promise<Response> {
  if (!token) throw new ApiFailure(401, "No access token. Open the dashboard from the link printed by `codemap dashboard`.");
  const res = await fetch(url(path, params), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = ((await res.json()) as ApiError).error.message;
    } catch {
      /* keep status text */
    }
    if (res.status === 401) {
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
    }
    throw new ApiFailure(res.status, message);
  }
  return res;
}

export async function get<T>(path: string, params?: Params): Promise<T> {
  return (await (await request(path, params)).json()) as T;
}

/** Fetches an export with the bearer token and saves it through a temporary object URL. */
export async function download(path: string, params: Params, filename: string): Promise<void> {
  const blob = await (await request(path, params)).blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
