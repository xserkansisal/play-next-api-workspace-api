# Frontend changes: team roles and @fluttersea.com sign-in

Details of the API: `docs/frontend-teams.md` (section 3a). This file lists what the frontend must change.

## 1. Team roles

Roles are **per team**. A user can be `owner` in one team and `viewer` in another, so recompute permissions on every team switch (`X-Team-Id`).

| Role | Can do |
| --- | --- |
| (no team) | Base `user`. Sees nothing team-related until added to a team. |
| `viewer` | Read all team content. Send requests (proxy), run collections (own history), personal variables/preferences, presence. **No** create/edit/delete/move/clone/import/restore, no environment or team-variable edits. |
| `member` | Everything a viewer can + edit content. |
| `owner` | Everything a member can + manage that team's members. |
| system admin (`systemRole: "admin"`) | All of the above in **every** team, even without membership (treated as `owner`); also admin panel. |

### 1.1 Type and data changes
- `TeamRole` is now `"owner" | "member" | "viewer"`. **`"admin"` no longer exists** (existing rows were migrated to `owner`). Update types, role selects (admin panel, owner panel), labels, icons.
- `GET /api/v1/teams` items have `role` and a new boolean `isMember`. System admins receive **all** non-archived teams; for teams they do not belong to, `role = "owner"` and `isMember = false`. Show a badge (e.g. "Admin access") and/or group them separately in the team switcher.
- Do not assume the current team is a membership; a system admin can send `X-Team-Id` for any active team.

### 1.2 UI gating (use `currentTeam.role`)
- `viewer`: hide or disable create/rename/delete/move/clone/import/restore buttons for collections, folders, requests, environments, team variables (global) and trash. Keep enabled: Send, run collection / folder / request, personal (`user`-scope) variables incl. reordering, preferences.
- `member`: full content editing; hide member management.
- `owner` / system admin: show a "Members" screen for the team.
- Gating is only UX; the API enforces it.

### 1.3 New error to handle
`403 TEAM_ROLE_REQUIRED` — a viewer attempted a write (or a non-owner attempted member management). Show "You do not have permission in this team", refresh `GET /teams` (the role may have changed) and re-render. Unknown/archived/foreign teams return `404 TEAM_NOT_FOUND` (already handled via team switch fallback).

### 1.4 Member management (owner / system admin)
| Endpoint | Who | Purpose |
| --- | --- | --- |
| `GET /api/v1/teams/:teamId/members` | any member, system admin | list members with roles |
| `POST /api/v1/teams/:teamId/members` | owner, system admin | add by email + role |
| `PATCH /api/v1/teams/:teamId/members/:userId` | owner, system admin | change role |
| `DELETE /api/v1/teams/:teamId/members/:userId` | owner, system admin | remove |

Notes: the member list is visible to viewers/members too (hide the page for them if you prefer). When the signed-in user is removed or demoted, their SSE/presence for that team is revoked, so expect the stream to drop → refetch `/teams`. Role options in forms: `owner`, `member`, `viewer`.

## 2. Sign-in with @fluttersea.com

- The user may still type an `@fluttersea.com`, `@sisal.com` or `@sisal.it` address. Any other domain → `400 EMAIL_DOMAIN_NOT_ALLOWED` (unchanged).
- The code is **always sent to `<local-part>@fluttersea.com`**. `POST /auth/request-code` responds `202 { message, email }` where `email` is that address — show "We sent a code to {email}" and use it for `verify-code` (sending the original address also works).
- The user object / session email is always `@fluttersea.com`. Do not compare it with the typed value; show the canonical address everywhere (profile, member lists, admin panel).
- Admin/owner "add by email" accepts the same domains and resolves to the fluttersea account.
- Dev login (`/auth/dev-login`, dev inbox) behaves the same.
- Migration `0018` deleted every account whose email was not `@fluttersea.com` (sessions, personal variables, runs, preferences, avatars, memberships). Shared content remains but authorship became `null`: handle `createdBy` / `updatedBy` = `null` (show "Unknown user"). Affected users get `401` on next call → normal re-login; the new account has no teams until an owner/admin adds it. Migration `0019` then promotes a remaining member (members before viewers, longest-standing first) to `owner` in any team left without one; teams with no members left stay empty until a system admin adds someone.

## 3. Deleting users (system admin)

`DELETE /api/v1/admin/users/:userId` → `204`. Permanently deletes the account: sessions, team memberships, run history, personal variables, preferences and avatar. Shared content it created stays, with `createdBy` / `updatedBy` = `null`. Logged in the audit log as `user.deleted`.

| Error | When | Suggested UI |
| --- | --- | --- |
| `409 CANNOT_DELETE_SELF` | Admin tries to delete their own account | Hide/disable "Delete" on the signed-in user's row |
| `409 LAST_SYSTEM_ADMIN` | Target is the only system admin | "Promote another admin first" |
| `409 TEAM_LAST_OWNER` | Target is the only owner of a team (`error.details.teamId`) | "Assign another owner to {team} first", link to that team |
| `404 USER_NOT_FOUND` | Already deleted | Refresh the user list |

Frontend tasks:
- Add a "Delete user" action in the admin user list/detail with a confirmation dialog stating the deletion is permanent.
- After `204`, remove the row and refetch team detail screens that listed the user.
- The deleted user's open tabs get `401` on the next request and their SSE/presence stream closes → send them to the login screen. Signing in again creates a new, empty account.
- Add `"user.deleted"` to the audit-log action type and label.

## 4. Checklist
- [ ] `TeamRole` type without `admin`; add `viewer`; update selects/labels
- [ ] Use `isMember` / `role` from `GET /teams`; team switcher shows non-member teams for system admins
- [ ] Per-team permission helper (`canEdit`, `canManageMembers`) recomputed on team switch
- [ ] Disable/hide write actions for viewers; keep send/run/personal variables
- [ ] Global handler for `403 TEAM_ROLE_REQUIRED`
- [ ] Members screen for owners/system admins
- [ ] Login form shows canonical `email` from the 202 response
- [ ] Handle `null` `createdBy` / `updatedBy`
- [ ] Re-login flow after 401 and empty-team state for new accounts
- [ ] "Delete user" action in the admin panel with confirmation and the 409/404 error messages
- [ ] `user.deleted` in the audit-log action type/labels
