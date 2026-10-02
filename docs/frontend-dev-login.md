# Frontend: code-free sign-in in development

In development the API can sign a user in from the email alone, skipping the emailed code.

## Backend setup (developer machine only)

```bash
NODE_ENV=development
AUTH_DEV_BYPASS=true
```

The API refuses to start if `AUTH_DEV_BYPASS=true` while `NODE_ENV` is not `development`, and the
PM2 config pins it to `false`. With the flag off, `POST /api/v1/auth/dev-login` does not exist
(404). The API logs a warning at startup when it is on.

## Endpoint

`POST /api/v1/auth/dev-login`

```json
{ "email": "name.surname@sisal.com" }
```

- `200` returns exactly what `verify-code` returns, and sets the same session cookie:
  `{ "user": { id, email, firstName, lastName, avatarColor, avatarUrl }, "expiresAt": "…" }`.
- `400 EMAIL_DOMAIN_NOT_ALLOWED` for domains other than `fluttersea.com`, `sisal.com`, `sisal.it`.
- `400 VALIDATION_ERROR` for a malformed body.
- `404` when the bypass is not enabled.

No rate limit applies, and no code is created or checked. Send the request with
`credentials: "include"` so the cookie is stored, as for the other auth calls.

## Frontend behaviour

Use a build-time flag so production bundles never take this path:

```ts
const DEV_LOGIN = import.meta.env.DEV && import.meta.env.VITE_DEV_LOGIN === "true";

async function submitEmail(email: string) {
  if (DEV_LOGIN) {
    const res = await fetch(`${API}/api/v1/auth/dev-login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (res.ok) return onSignedIn(await res.json()); // same handler as after verify-code
    if (res.status !== 404) throw await toApiError(res);
    // 404: the API has the bypass off, so fall through to the normal code flow.
  }
  await requestCode(email); // POST /auth/request-code, then show the code step
}
```

Checklist:

1. Add `VITE_DEV_LOGIN=true` to the local `.env.development.local` (not committed).
2. After the email step, call `dev-login`; on `200` run the same post-sign-in logic as after
   `verify-code` (store the user, navigate to the app). Skip the code screen.
3. On `404`, fall back to the normal `request-code` → `verify-code` flow, so the app still works
   against an API without the bypass.
4. Everything after sign-in (`GET /auth/me`, sign-out, avatars) is unchanged.
5. In a local Vite setup the cookie works through the dev proxy or with `CORS_ORIGIN` set to the Vite
   origin, same as the regular flow.
