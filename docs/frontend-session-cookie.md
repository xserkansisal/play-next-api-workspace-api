# Frontend: session cookie name per environment

The API now names its session cookie by `NODE_ENV`. **The frontend needs no code change** in the
normal case; this document explains what changes and what to check.

## What changed

| API `NODE_ENV` | Session cookie name |
|---|---|
| `production` | `play_next_session` (unchanged) |
| `development` | `play_next_session_dev` |
| `test` | `play_next_session_test` |

An explicit `AUTH_COOKIE_NAME` on the API overrides these defaults.

Why: browsers scope cookies by host, not port. A dev API and a test API both on `localhost` used to
overwrite each other's `play_next_session` cookie and sign each other out.

## Why the frontend is unaffected

- The cookie is `HttpOnly`, so JavaScript cannot read it and the frontend never referred to its name.
- The browser attaches it automatically when requests use `credentials: "include"` (fetch) or
  `withCredentials: true` (axios/XHR), exactly as before.
- `POST /auth/verify-code`, `POST /auth/dev-login`, `GET /auth/me` and `POST /auth/sign-out` keep the
  same request and response shapes. Sign-out clears whichever cookie the API issued.

## What users will notice

- In **development/test**, the first request after updating the API has no cookie under the new
  name, so `GET /auth/me` returns `401`. The app should already route this to the sign-in screen;
  the user signs in once (with dev login, no code needed).
- The old `play_next_session` cookie stays in the browser, unused, until it expires. It is harmless
  and can be deleted in DevTools → Application → Cookies.
- **Production** keeps `play_next_session`, so nobody is signed out there.

## Checklist

1. Make sure every API call uses `credentials: "include"` (no change if it already does).
2. Do not hard-code a cookie name in the frontend, tests, or mocks. If a Playwright/Cypress test
   sets or asserts the session cookie manually, use `play_next_session_dev` (dev API) or
   `play_next_session_test` (test API), or better, sign in through the API and let the browser
   store it.
3. Treat `401` from `GET /auth/me` as "signed out" and show the sign-in screen.
4. Running two APIs on the same host in different environments now works side by side: each
   keeps its own session.
