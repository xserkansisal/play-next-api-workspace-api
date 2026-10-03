# Frontend integration: team workspaces and the admin panel

This document lists every API change the frontend has to adopt for team-based workspaces and
describes the new admin panel API. Each section ends with what the frontend must do.

## 1. Summary of the change

- A user belongs to **zero or more teams**. Collections (with their folders, requests, versions and
  runs), environments, **global** variables, Trash, presence and the change stream belong to
  exactly one team.
- The user works in **one selected team at a time**. The frontend tells the API which team with
  the `X-Team-Id` header (or `?teamId=` on `EventSource`).
- A **system admin** manages teams and memberships through `/api/v1/admin/*` and can work in
  every team. Inside a team, the user's **team role** (`owner`, `member`, `viewer`) decides what
  they may do (section 3a).
- All existing data was moved into the **Game Studio** team.

Unchanged: the auth flow, session cookie, request/response shapes of collections, items,
environments, Trash and runs, the proxy and `/api/v1/preferences/*`.

## 2. Current user: `systemRole`

The user object returned by `POST /api/v1/auth/verify-code` and `GET /api/v1/auth/me` has a new
field:

```json
{ "user": { "id": "…", "email": "…", "firstName": "…", "lastName": "…", "systemRole": "user" } }
```

`systemRole` is `"user"` or `"admin"`.

**Frontend:** show the admin panel entry only when `systemRole === "admin"`. The API checks the
role on every request, so a demoted user gets `403 ADMIN_REQUIRED` immediately; handle it by
leaving the admin panel.

## 3. Team switcher: `GET /api/v1/teams`

Returns the signed-in user's non-archived teams, sorted by name. It needs no team header.

```json
{
  "teams": [
    { "id": "00000000-0000-4000-8000-000000000101", "name": "Game Studio", "description": "", "role": "member" }
  ]
}
```

`role` is the user's effective role in that team: `owner`, `member` or `viewer` (see 3a).
`isMember` is `false` when a system admin sees a team they do not belong to; for those the role is
`owner`. A system admin gets **every** non-archived team in this list; everyone else only their own.

**Frontend:**

1. After sign-in (and on app start with a valid session), call `GET /api/v1/teams`.
2. Choose the active team:
   - the last selected team stored locally (e.g. `localStorage["activeTeamId:<userId>"]`), if it
     is still in the list;
   - otherwise the first team in the list.
3. If the list is empty, show a "You are not a member of any team yet. Ask an administrator to add
   you." screen instead of the workspace. System admins can still open the admin panel.
4. Show a team switcher (e.g. in the header) only when the user has more than one team.

## 3a. Roles and permissions

A user with no team membership has no access to any team. Roles are **per team**: the same person
can be `owner` of one team and `viewer` of another; the role of the selected team applies.

| Role | Can | Cannot |
| --- | --- | --- |
| `viewer` | Read the team's collections, items, environments, variables, Trash and versions; send requests (`/api/v1/proxy`); run collections (own history); keep personal (`user`-scope) variables and preferences; presence and the change stream | Create, edit, delete, move, clone, import or restore anything shared (collections, items, environments, team variables, Trash) |
| `member` | Everything a viewer can, plus create/edit/delete/restore the team's content and write team (`global`) variables | Manage the team's members |
| `owner` | Everything a member can, plus list/add/remove members and change their roles in **their own team** (`/api/v1/teams/:teamId/members`) | Touch other teams, create/archive/delete teams, change system roles |
| system admin (`systemRole: "admin"`) | Everything, in every non-archived team (acts as `owner`), plus the whole `/api/v1/admin/*` panel | Demote the last system admin |

A write a viewer is not allowed to make answers `403` with code `TEAM_ROLE_REQUIRED`. Hide or
disable edit controls for viewers (and member-management for non-owners) and treat this code as a
fallback. A team must always keep at least one owner (`TEAM_LAST_OWNER`).

The former `admin` team role was removed; existing holders became `owner`.

### Member management for owners

| Method | Route | Who | Body / response |
| --- | --- | --- | --- |
| GET | `/api/v1/teams/:teamId/members` | any member, system admin | `{ members: TeamMember[] }` |
| POST | `/api/v1/teams/:teamId/members` | owner, system admin | `{ email, role? }` (default `member`) → `201 TeamMember` |
| PATCH | `/api/v1/teams/:teamId/members/:userId` | owner, system admin | `{ role }` → `TeamMember` |
| DELETE | `/api/v1/teams/:teamId/members/:userId` | owner, system admin | `204` |

Same rules and error codes as the admin endpoints of the same name (section 9). A team the caller
cannot enter answers `404 TEAM_NOT_FOUND`; a non-owner gets `403 TEAM_ROLE_REQUIRED` on writes.
Changes by owners appear in the audit log with the owner as actor.

## 4. Sending the selected team

Every request to the following routes **must** carry the header `X-Team-Id: <teamId>`:

| Routes | Team-scoped |
| --- | --- |
| `/api/v1/collections/**` (including items, versions, clone, import, move, run, runs) | yes |
| `/api/v1/environments/**` | yes |
| `/api/v1/variables/**` | yes |
| `/api/v1/trash/**` | yes |
| `/api/v1/presence` | yes |
| `/api/v1/events` | yes (use `?teamId=`; see section 6) |
| `/api/v1/auth/**`, `/api/v1/teams`, `/api/v1/preferences/**`, `/api/v1/proxy/**`, `/api/v1/admin/**` | no |

The header is accepted by CORS. Sending it on non-scoped routes is harmless, so the simplest
implementation is to add it to every API request in the shared HTTP client:

```ts
headers.set("X-Team-Id", activeTeamId);
```

If no team is sent, the API uses the user's only team when there is exactly one, and fails
otherwise. Always send it anyway; do not rely on this fallback.

## 5. New error responses

Errors keep the usual shape `{ "error": { "code": string, "message": string } }`.

| Status | Code | When | Frontend action |
| --- | --- | --- | --- |
| 400 | `TEAM_CONTEXT_REQUIRED` | No team sent and the user is in several | Bug: the header is missing |
| 403 | `TEAM_MEMBERSHIP_REQUIRED` | The user is in no team | Show the "no team" screen |
| 403 | `TEAM_ROLE_REQUIRED` | The role in this team is too low for the write (e.g. viewer editing) | Show a "no permission" message; refresh the role via `GET /api/v1/teams` |
| 404 | `TEAM_NOT_FOUND` | The team does not exist, is archived, or the user was removed from it | Refetch `GET /api/v1/teams`, select another team (or show the "no team" screen), drop the old team's cached data and tell the user they no longer have access |

Treat `TEAM_NOT_FOUND` as a global handler in the HTTP client, because it can arrive on any
team-scoped request at any time (an admin may remove the user or archive the team).

A collection or environment of **another** team answers like a missing one (`404`, the usual
not-found codes). This happens if a stale ID from the previous team is used after switching; make
sure open tabs/selection are cleared on switch.

## 6. Change stream and presence (SSE)

`EventSource` cannot send headers, so pass the team as a query parameter:

```ts
new EventSource(`/api/v1/events?teamId=${encodeURIComponent(activeTeamId)}`, { withCredentials: true });
```

- The stream carries only the selected team's change events and that team's presence snapshots.
  Personal events still arrive whichever team is selected.
- When the team changes, **close the old `EventSource` and open a new one** with the new `teamId`.
  Do not reuse `Last-Event-ID` across teams; start fresh and refetch the lists.
- When the user is removed from the team or the team is archived, the server **ends the stream**.
  The browser will try to reconnect and the reconnect fails with `404 TEAM_NOT_FOUND`. On a stream
  error, call `GET /api/v1/teams` once; if the active team is no longer listed, handle it like
  `TEAM_NOT_FOUND` in section 5 instead of retrying forever.
- `PUT /api/v1/presence` needs `X-Team-Id`, and the `collectionId` in its body must belong to that
  team (otherwise `404`). Presence snapshots list only viewers in the same team.

## 7. Switching teams

When the active team changes:

1. Save the new team ID locally.
2. Clear all team-scoped client state: collections tree, open request tabs, selected
   environment, environments list, variables list, Trash, run results, presence, and any query
   cache entries. Key such caches by `teamId` (e.g. `["collections", teamId]`) so data from two
   teams can never mix.
3. Reconnect the event stream (section 6).
4. Reload collections, environments and variables for the new team.

Keep per-user settings (theme, variable display order from `/api/v1/preferences/*` and
`/api/v1/variables/order`, avatar) unchanged; they are not team-specific.

## 8. Behavior changes in the workspace

- **Names are unique per team.** Two teams can each have a collection or environment called
  "Staging"; inside one team the existing `409 COLLECTION_NAME_CONFLICT` /
  `ENVIRONMENT_NAME_CONFLICT` rules are unchanged.
- **Variables:** the API scope names stay `user` and `global`, but `global` now means *shared with
  everyone in this team*. Rename the label in the UI (e.g. "Team" / "Everyone in this team"
  instead of "Global"/"Everyone"). The API's own label text was changed to "Everyone in this team".
  `user` variables stay personal and are the same in every team.
- **Move:** an item can only be moved into a collection of the same team; the move target picker
  should list only the current team's collections (which it does if it uses the team-scoped
  collection list). A foreign target returns `404 TARGET_NOT_FOUND`.
- **Runner:** the selected environment must be in the same team; otherwise `404`.
- **Trash** lists and restores only the current team's deleted items.
- **Run history** stays personal.
- **Error code change:** a request under an unknown collection, e.g.
  `GET /api/v1/collections/<unknownId>/items/<itemId>`, now returns `404` with code `NOT_FOUND`
  (previously `ITEM_NOT_FOUND`). Check for status `404` rather than the specific code.

## 9. Admin panel (`/api/v1/admin/*`)

Available only to `systemRole === "admin"`; everyone else gets `403 ADMIN_REQUIRED`. No team
header is needed. A system admin can also open any team's content by sending its `X-Team-Id`, as an owner.

### Types

```ts
type TeamRole = "owner" | "member" | "viewer";

interface TeamSummary {
  id: string; name: string; description: string; memberCount: number;
  createdAt: string; updatedAt: string; archivedAt: string | null;
}
interface TeamMember {
  userId: string; email: string; firstName: string; lastName: string;
  avatarColor: string; role: TeamRole; joinedAt: string;
  avatarUrl: string | null; // same convention as /auth/me; null when no photo was uploaded
}
interface TeamDetail extends TeamSummary { members: TeamMember[] }

interface AdminUser {
  id: string; email: string; firstName: string; lastName: string; avatarColor: string;
  systemRole: "user" | "admin"; createdAt: string;
  hasSignedIn: boolean; // false for accounts created by adding a member who never signed in
  avatarUrl: string | null; // same convention as /auth/me; null when no photo was uploaded
}
interface AdminUserDetail extends AdminUser {
  teams: { id: string; name: string; role: TeamRole; archivedAt: string | null }[];
}

interface AuditLogEntry {
  id: string; actor: string | null; // actor email
  action: "team.created" | "team.updated" | "team.archived" | "team.unarchived" | "team.deleted"
    | "team.member_added" | "team.member_role_changed" | "team.member_removed"
    | "user.system_role_changed"
    | "user.deleted";
  targetType: "team" | "team_member" | "user"; targetId: string; teamId: string | null;
  details: Record<string, unknown>; createdAt: string;
}
```

### Endpoints

| Method | Route | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/api/v1/admin/teams` | `?includeArchived=true` (default `false`) | `{ teams: TeamSummary[] }` |
| POST | `/api/v1/admin/teams` | `{ name, description? }` | `201 TeamDetail` |
| GET | `/api/v1/admin/teams/:teamId` | | `TeamDetail` |
| PATCH | `/api/v1/admin/teams/:teamId` | `{ name?, description? }` (at least one) | `TeamDetail` |
| POST | `/api/v1/admin/teams/:teamId/archive` | | `TeamDetail` |
| POST | `/api/v1/admin/teams/:teamId/unarchive` | | `TeamDetail` |
| DELETE | `/api/v1/admin/teams/:teamId` | | `204` |
| GET | `/api/v1/admin/teams/:teamId/members` | | `{ members: TeamMember[] }` |
| POST | `/api/v1/admin/teams/:teamId/members` | `{ email, role? }` (default `member`) | `201 TeamMember` |
| PATCH | `/api/v1/admin/teams/:teamId/members/:userId` | `{ role }` | `TeamMember` |
| DELETE | `/api/v1/admin/teams/:teamId/members/:userId` | | `204` |
| GET | `/api/v1/admin/users` | `?query=&limit=50&offset=0` (limit ≤ 200) | `{ users: AdminUser[], total }` |
| GET | `/api/v1/admin/users/:userId` | | `AdminUserDetail` |
| PATCH | `/api/v1/admin/users/:userId` | `{ systemRole: "user" \| "admin" }` | `AdminUserDetail` |
| DELETE | `/api/v1/admin/users/:userId` | | `204`. Permanently deletes the account. `409 CANNOT_DELETE_SELF`, `LAST_SYSTEM_ADMIN`, `TEAM_LAST_OWNER` (assign another owner first) |
| GET | `/api/v1/admin/audit-log` | `?teamId=&limit=50&offset=0` | `{ entries: AuditLogEntry[], total }` |

### Rules and error codes

| Status | Code | Meaning | Suggested UI |
| --- | --- | --- | --- |
| 409 | `TEAM_NAME_CONFLICT` | Team name taken (case-insensitive, archived teams included) | Inline error on the name field |
| 409 | `TEAM_ARCHIVED` | Membership of an archived team cannot change | Disable member actions for archived teams |
| 409 | `TEAM_NOT_ARCHIVED` | Delete requires archiving first | Offer "Archive" first; show "Delete" only for archived teams |
| 409 | `TEAM_NOT_EMPTY` | Team still owns collections, environments or global variables (trashed ones too) | Explain that content must be removed/moved first |
| 409 | `TEAM_LAST_OWNER` | Would remove or demote the team's last owner | Ask to promote another owner first |
| 409 | `TEAM_MEMBER_EXISTS` | User already in the team | Inline error |
| 409 | `LAST_SYSTEM_ADMIN` | Would demote the last system admin | Inline error |
| 400 | `EMAIL_DOMAIN_NOT_ALLOWED` | Email domain not allowed for sign-in | Inline error on the email field |
| 404 | `TEAM_NOT_FOUND` / `TEAM_MEMBER_NOT_FOUND` / `USER_NOT_FOUND` | Target missing | Refresh the list |
| 400 | `VALIDATION_ERROR` | Invalid body | Field errors |

Notes:

- Members are added **by email**. If the person has never signed in, an account is created
  (`hasSignedIn: false`) and their membership is ready on first sign-in. Show a "not signed in
  yet" badge for such users.
- Removing a member or archiving a team ends that member's (or everyone's) live stream
  immediately; their next request gets `TEAM_NOT_FOUND` (section 5).
- An admin who manages their own membership is affected the same way: after removing themselves
  from the active team, refetch `GET /api/v1/teams`.

### Suggested screens

1. **Teams list** – name, description, member count, archived badge; "show archived" toggle;
   create button.
2. **Team detail** – edit name/description; members table (name, email, role select, joined,
   "not signed in yet" badge, remove); "add member" form (email + role); archive / unarchive /
   delete actions with confirmation.
3. **Users** – searchable, paginated list (`query` matches email and name); user detail shows
   their teams and a system-role toggle.
4. **Audit log** – paginated table, optionally filtered by team.

## 10. Data after the migration

- Teams: Game Studio, Mobile Gaming, PAM, Cross Module, Lottery, Hybrid App, Native App.
- All existing collections, folders, requests, environments and global variables are in
  **Game Studio**. The other teams start empty.
- Users who are in no team see the "no team" screen until an admin adds them.
- The first system admin is `serkan.taghan@fluttersea.com`.

## 11. Checklist

- [ ] Read `systemRole` from `/auth/me`; gate the admin panel.
- [ ] Load `GET /api/v1/teams` after sign-in; persist and restore the active team per user.
- [ ] "No team" empty state.
- [ ] Team switcher (when more than one team).
- [ ] `X-Team-Id` on every API request.
- [ ] `?teamId=` on the `EventSource` URL; reconnect on switch; handle a stream ended by the server.
- [ ] Global `TEAM_NOT_FOUND` / `TEAM_MEMBERSHIP_REQUIRED` handling.
- [ ] Clear and re-key team-scoped caches on switch.
- [ ] Rename "Global" variables to a team-wide label.
- [ ] Treat `404` (not `ITEM_NOT_FOUND` specifically) as "item missing".
- [ ] Admin panel: teams, members, users, audit log.
