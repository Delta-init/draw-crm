# 🚀 Feature Registry — Carlton CRM Frontend

> Every feature built in this app must be documented here.
> **Before building a feature**: check if it exists or is partially built.
> **After building**: log it completely — APIs, components, hooks, related features.

---

## How to Use This File

- **Before building**: Search by feature name or module
- **After building**: Fill the template and add it
- **When extending**: Update the entry — bump version, add change note

---

## 📋 Feature Entry Template

```
### Feature Name
- **Module**: leads | teams | users | roles | courses | reports | dashboard | reminders | auth | notifications
- **Version**: 1.0.0
- **Status**: active | wip | deprecated
- **Created**: YYYY-MM-DD
- **Last Updated**: YYYY-MM-DD

**Description**:
What the feature does in 1-3 sentences.

**Pages / Routes**:
- `/app/(dashboard)/[route]/page.tsx` — what the user sees here

**Components Used**:
- `components/[path]/ComponentName.tsx` — why / what it does in this feature

**Hooks Used**:
- `hooks/useXxx.ts` — which functions from this hook

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/...` | ... |

**State**:
- React Query keys: `["..."]`
- Zustand stores: (if any)

**Permissions**:
- Module: `leads | teams | users | roles | reports | dashboard`
- Actions: `view | create | edit | delete`

**Related Features**:
- Feature Name — how they relate

**Notes / Gotchas**:
- Any special behavior, edge cases, or implementation details

**Change Log**:
- 1.0.0 — Initial build
```

---

## 🗂 Feature Registry

---

## 🔐 Authentication

### Login
- **Module**: auth
- **Version**: 1.0.0
- **Status**: active
- **Created**: —
- **Last Updated**: —

**Description**:
JWT-based login. Returns access token + refresh token. Access token stored in memory/localStorage; refresh token in HttpOnly cookie.

**Pages / Routes**:
- `app/(auth)/login/page.tsx` — Login form (email + password)

**Components Used**:
- `components/auth/LoginForm.tsx` — Form with react-hook-form + zod validation

**Hooks Used**:
- Direct axios call (no React Query — auth is not server state)

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/auth/login` | Authenticate user, get tokens |
| POST | `/api/v1/auth/refresh` | Refresh access token |
| POST | `/api/v1/auth/logout` | Invalidate refresh token |

**State**:
- Zustand: auth store (user info, access token)

**Related Features**:
- All protected routes depend on this

**Notes**:
- Access token auto-attached by `lib/axios.ts` interceptor
- On 401 response, axios interceptor calls refresh endpoint automatically
- After login → redirect to `/dashboard`

**Change Log**:
- 1.0.0 — Initial build

---

## 📊 Dashboard

### Dashboard Overview
- **Module**: dashboard
- **Version**: 1.0.0
- **Status**: active
- **Created**: —
- **Last Updated**: —

**Description**:
High-level stats cards showing leads by status, team performance, and recent activity.

**Pages / Routes**:
- `app/(dashboard)/dashboard/page.tsx` — Stats cards + recent leads

**Hooks Used**:
- `hooks/useDashboard.ts` — `useDashboardStats()`

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/dashboard` | Aggregated stats |

**State**:
- React Query keys: `["dashboard"]`

**Permissions**:
- Module: `dashboard` / Action: `view`

**Change Log**:
- 1.0.0 — Initial build

---

## 👥 Leads

### Lead List
- **Module**: leads
- **Version**: 1.0.0
- **Status**: active
- **Created**: —
- **Last Updated**: —

**Description**:
Paginated, filterable list of all leads. Supports filtering by status, assigned team, date range, and search by name/phone.

**Pages / Routes**:
- `app/(dashboard)/leads/page.tsx` — Lead table with filters + create button

**Components Used**:
- `components/leads/LeadDialog.tsx` — Create/edit lead modal
- `components/leads/DeleteLeadDialog.tsx` — Delete confirmation
- `components/leads/AssignLeadDialog.tsx` — Assign lead to team
- `components/leads/LeadsDateFilter.tsx` — Date range filter
- `components/ui/responsive-dialog.tsx` — Modal wrapper

**Hooks Used**:
- `hooks/useLeads.ts` — `useLeads(filters)`, `useCreateLead()`, `useUpdateLead()`, `useDeleteLead()`

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/leads` | List leads (supports query params: status, team, search, from, to, page, limit) |
| POST | `/api/v1/leads` | Create new lead |
| PATCH | `/api/v1/leads/:id` | Update lead |
| DELETE | `/api/v1/leads/:id` | Delete lead |
| PATCH | `/api/v1/leads/:id/team` | Assign to team |
| PATCH | `/api/v1/leads/:id/status` | Change lead status |

**State**:
- React Query keys: `["leads"]`, `["leads", filters]`

**Permissions**:
- Module: `leads` / Actions: `view`, `create`, `edit`, `delete`

**Lead Statuses**:
`new | assigned | followup | closed | rejected | cnc | booking | partialbooking | interested`

**Related Features**:
- Lead Detail — clicking a lead row opens detail
- Lead Upload — bulk import via CSV
- Reminders — reminder panel inside lead detail
- Payments — payment panel inside lead detail
- AI Chat — AI assistant inside lead detail

**Change Log**:
- 1.0.0 — Initial build

---

### Lead Detail
- **Module**: leads
- **Version**: 1.0.0
- **Status**: active
- **Created**: —
- **Last Updated**: —

**Description**:
Full lead detail page with tabs for: basic info, notes, reminders, payments, AI chat.

**Pages / Routes**:
- `app/(dashboard)/leads/[leadId]/page.tsx` — Lead detail with panels

**Components Used**:
- `components/leads/ReminderPanel.tsx` — Reminder management (CRUD + IST display)
- `components/leads/PaymentPanel.tsx` — Payment tracking
- `components/leads/AiChatPanel.tsx` — AI assistant chat interface

**Hooks Used**:
- `hooks/useLeads.ts` — `useLead(id)`, `useUpdateLead()`
- `hooks/useReminders.ts` — `useAddReminder()`, `useUpdateReminder()`, `useDeleteReminder()`

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/leads/:id` | Lead detail |
| PATCH | `/api/v1/leads/:id` | Update lead info |
| POST | `/api/v1/leads/:id/reminders` | Add reminder |
| PATCH | `/api/v1/leads/:id/reminders/:rid` | Update reminder |
| DELETE | `/api/v1/leads/:id/reminders/:rid` | Delete reminder |
| POST | `/api/v1/leads/:id/payments` | Add payment |
| POST | `/api/v1/ai/chat/:leadId` | AI chat message |
| GET | `/api/v1/ai/memory/:leadId` | Load AI conversation history |
| DELETE | `/api/v1/ai/memory/:leadId` | Clear AI memory |

**State**:
- React Query keys: `["leads", leadId]`

**Notes**:
- Reminder times always displayed in IST with " IST" suffix
- Reminder input uses `toDatetimeLocal()` + `nowIST()` for IST-safe display
- All reminder saves append `:00+05:30` to datetime-local value for IST parsing

**Related Features**:
- Reminder Notifications — reminders here trigger server-side notifications
- AI Chat — powered by Anthropic Claude API via backend

**Change Log**:
- 1.0.0 — Initial build

---

### Lead CSV Upload
- **Module**: leads
- **Version**: 1.1.0
- **Status**: active
- **Created**: —
- **Last Updated**: 2026-04-01

**Description**:
Bulk import leads from a CSV file. Maps columns to lead fields, validates, and creates up to 500 leads per upload.

**Pages / Routes**:
- `app/(dashboard)/leads/upload/page.tsx` — Upload UI + column mapping + preview

**Hooks Used**:
- `hooks/useLeads.ts` — `useBulkUploadLeads()`

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/leads/upload` | Bulk create leads from JSON array |

**Notes / Gotchas**:
- Backend `notes` field must be an **array** `[{ content, author }]` — not a string object
- `email: "No Email"` and invalid emails must be sent as `undefined` (not the invalid string)
- Backend uses `ordered: false` in `insertMany` — partial success is possible; check `created` count in response
- Required fields: `name`, `phone` (others optional)

**Related Features**:
- Lead List — uploaded leads appear here

**Change Log**:
- 1.0.0 — Initial build
- 1.1.0 — Fixed `notes` object vs array bug; fixed `"No Email"` email validation (2026-04-01)

---

## 🔔 Reminders & Notifications

### Reminder Notifications
- **Module**: reminders
- **Version**: 1.2.0
- **Status**: active
- **Created**: —
- **Last Updated**: 2026-04-01

**Description**:
Real-time browser notifications for lead reminders. Notifies via Socket.io (browser open) and Web Push/VAPID (browser closed). Includes a 30-minute advance warning.

**Pages / Routes**:
- `app/(dashboard)/reminders/page.tsx` — Manage all reminders across leads
- `app/(dashboard)/leads/[leadId]/page.tsx` → `ReminderPanel` — Per-lead reminders

**Components Used**:
- `components/leads/ReminderPanel.tsx` — CRUD for reminders on a lead
- `components/notifications/NotificationBell.tsx` — Header bell icon with badge

**Hooks Used**:
- `hooks/useReminderNotifications.ts` — Socket listeners + localStorage dedup + browser notification firing
- `hooks/useReminders.ts` — `useMyReminders()` for polling fallback

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/leads/reminders/mine` | Get current user's upcoming reminders |
| POST | `/api/v1/leads/:id/reminders` | Create reminder |
| PATCH | `/api/v1/leads/:id/reminders/:rid` | Update reminder |
| DELETE | `/api/v1/leads/:id/reminders/:rid` | Delete reminder |

**Socket Events**:
| Event | Direction | Payload |
|---|---|---|
| `reminder:due` | Server → Client | `{ leadId, leadName, remindAt, note }` |
| `reminder:warning` | Server → Client | `{ leadId, leadName, remindAt, minutesLeft, note }` |

**State**:
- React Query keys: `["reminders"]`
- localStorage: `crm_notified_reminders` (JSON map, 25h TTL)

**Architecture**:
- Backend scheduler: `setInterval(tick, 30_000)` in `reminderScheduler.ts`
- Tick Pass 1: on-time (`remindAt ≤ now`, `notifiedAt: null`) → fire + stamp `notifiedAt`
- Tick Pass 2: 30-min warning (`remindAt` in 1–31 min) → fire + stamp `warnedAt`
- Max notification latency: **≤30 seconds** from `remindAt`

**Notes / Gotchas**:
- `new Notification()` crashes on Android Chrome — always use ServiceWorker (see `mistakes.md`)
- All times displayed in IST with " IST" suffix
- Reminder input `min={nowIST()}` prevents past-time selection

**Related Features**:
- Lead Detail — reminders created here
- Socket.io — real-time delivery path

**Change Log**:
- 1.0.0 — Initial reminder CRUD
- 1.1.0 — Added Web Push (VAPID) for background notifications
- 1.2.0 — Fixed Android crash; fixed IST timezone display; added frontend future-time validation (2026-04-01)

---

## 👨‍👩‍👦 Teams

### Team Management
- **Module**: teams
- **Version**: 1.0.0
- **Status**: active
- **Created**: —
- **Last Updated**: —

**Description**:
Create and manage sales teams. Each team has a leader and members. Leads can be assigned to teams. Supports active/inactive member status.

**Pages / Routes**:
- `app/(dashboard)/teams/page.tsx` — Team list
- `app/(dashboard)/teams/[teamId]/page.tsx` — Team detail + member management
- `app/(dashboard)/teams/[teamId]/members/[memberId]/page.tsx` — Member detail

**Components Used**:
- `components/teams/TeamDialog.tsx` — Create/edit team modal
- `components/teams/DeleteTeamDialog.tsx` — Delete confirmation

**Hooks Used**:
- `hooks/useTeams.ts` — `useTeams()`, `useTeam(id)`, `useCreateTeam()`, `useUpdateTeam()`, `useDeleteTeam()`, `useAutoAssign()`

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/teams` | List all teams |
| POST | `/api/v1/teams` | Create team |
| GET | `/api/v1/teams/:id` | Team detail |
| PATCH | `/api/v1/teams/:id` | Update team |
| DELETE | `/api/v1/teams/:id` | Delete team |
| POST | `/api/v1/teams/:id/auto-assign` | Auto-assign leads round-robin |

**State**:
- React Query keys: `["teams"]`, `["teams", teamId]`

**Permissions**:
- Module: `teams` / Actions: `view`, `create`, `edit`, `delete`

**Notes / Gotchas**:
- `inactiveMembers` returned as `[{ _id: ObjectId }]` (populated), not raw ObjectIds
- Auto-assign excludes team leader + inactive members
- Round-robin distribution based on current lead count per member

**Related Features**:
- Lead List — leads assigned to teams
- Auto-assign — distributes leads automatically

**Change Log**:
- 1.0.0 — Initial build

---

## 👤 Users

### User Management
- **Module**: users
- **Version**: 1.0.0
- **Status**: active
- **Created**: —
- **Last Updated**: —

**Description**:
Create and manage CRM users. Each user has a role with specific permissions.

**Pages / Routes**:
- `app/(dashboard)/users/page.tsx` — User list
- `app/(dashboard)/users/[userId]/page.tsx` — User detail + edit

**Components Used**:
- `components/users/UserDialog.tsx` — Create/edit user modal
- `components/users/DeleteUserDialog.tsx` — Delete confirmation

**Hooks Used**:
- `hooks/useUsers.ts` — `useUsers()`, `useUser(id)`, `useCreateUser()`, `useUpdateUser()`, `useDeleteUser()`

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/users` | List users |
| POST | `/api/v1/users` | Create user |
| GET | `/api/v1/users/:id` | User detail |
| PATCH | `/api/v1/users/:id` | Update user |
| DELETE | `/api/v1/users/:id` | Delete user |

**State**:
- React Query keys: `["users"]`, `["users", userId]`

**Permissions**:
- Module: `users` / Actions: `view`, `create`, `edit`, `delete`

**Change Log**:
- 1.0.0 — Initial build

---

## 🔑 Roles & Permissions

### Role Management
- **Module**: roles
- **Version**: 1.0.0
- **Status**: active
- **Created**: —
- **Last Updated**: —

**Description**:
Define roles with granular permissions across modules (leads, teams, users, roles, reports, dashboard).

**Pages / Routes**:
- `app/(dashboard)/roles/page.tsx` — Role list + permission matrix

**Components Used**:
- `components/roles/RoleDialog.tsx` — Create/edit role
- `components/roles/PermissionMatrix.tsx` — Visual grid of module × action permissions
- `components/roles/DeleteRoleDialog.tsx` — Delete confirmation

**Hooks Used**:
- `hooks/useRoles.ts` — `useRoles()`, `useCreateRole()`, `useUpdateRole()`, `useDeleteRole()`

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/roles` | List roles |
| POST | `/api/v1/roles` | Create role |
| PATCH | `/api/v1/roles/:id` | Update role + permissions |
| DELETE | `/api/v1/roles/:id` | Delete role |

**State**:
- React Query keys: `["roles"]`

**Permissions**:
- Module: `roles` / Actions: `view`, `create`, `edit`, `delete`

**Permission Modules**: `dashboard | leads | teams | users | roles | reports`
**Permission Actions**: `view | create | edit | delete`

**Change Log**:
- 1.0.0 — Initial build

---

## 📚 Courses

### Course Management
- **Module**: courses
- **Version**: 1.0.0
- **Status**: active
- **Created**: —
- **Last Updated**: —

**Description**:
Manage courses that leads can be assigned/interested in.

**Pages / Routes**:
- `app/(dashboard)/courses/page.tsx` — Course list

**Components Used**:
- `components/courses/CourseDialog.tsx` — Create/edit course
- `components/courses/DeleteCourseDialog.tsx` — Delete confirmation

**Hooks Used**:
- `hooks/useCourses.ts` — `useCourses()`, `useCreateCourse()`, `useUpdateCourse()`, `useDeleteCourse()`

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/courses` | List courses |
| POST | `/api/v1/courses` | Create course |
| PATCH | `/api/v1/courses/:id` | Update course |
| DELETE | `/api/v1/courses/:id` | Delete course |

**State**:
- React Query keys: `["courses"]`

**Change Log**:
- 1.0.0 — Initial build

---

## 📈 Reports

### Reports & Export
- **Module**: reports
- **Version**: 1.0.0
- **Status**: active
- **Created**: —
- **Last Updated**: —

**Description**:
Date-range based reports on lead conversion, team performance. Supports PDF export.

**Pages / Routes**:
- `app/(dashboard)/reports/page.tsx` — Report charts + filters

**Components Used**:
- `components/reports/ExportPdfDialog.tsx` — PDF export options

**Hooks Used**:
- `hooks/useReports.ts` — `useReports(dateRange)`

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/reports` | Aggregated report data |

**State**:
- React Query keys: `["reports", { from, to }]`

**Permissions**:
- Module: `reports` / Actions: `view`

**Change Log**:
- 1.0.0 — Initial build

---

## 🤖 AI Chat (per Lead)

### AI Lead Assistant
- **Module**: leads
- **Version**: 1.0.0
- **Status**: active
- **Created**: —
- **Last Updated**: —

**Description**:
Per-lead AI chat assistant powered by Anthropic Claude. Stores conversation memory in MongoDB per lead + user. Useful for quick summaries, follow-up suggestions, and lead analysis.

**Pages / Routes**:
- `app/(dashboard)/leads/[leadId]/page.tsx` → AI Chat tab

**Components Used**:
- `components/leads/AiChatPanel.tsx` — Chat interface with message history

**Hooks Used**:
- `hooks/useAiChat.ts` — `useAiMemory(leadId)`, `useSendMessage()`, `useClearMemory()`

**API Routes**:
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/ai/chat/:leadId` | Send message, get AI response |
| GET | `/api/v1/ai/memory/:leadId` | Load conversation history |
| DELETE | `/api/v1/ai/memory/:leadId` | Clear conversation memory |

**State**:
- React Query keys: `["ai", "memory", leadId]`

**Notes**:
- Conversations are scoped to `leadId + userId` — different users see different conversations for the same lead
- Model: Anthropic Claude (configured in backend `.env`)

**Change Log**:
- 1.0.0 — Initial build

---

## ➕ Adding a New Feature

Copy the template at the top and place it in the correct module section.

**Feature count**: 13
*(Increment every time you add a feature)*

---

## Mentor Booking

- **Page**: `app/(dashboard)/mentors/page.tsx`
- **Navigation**: `Mentors` entry in `components/layout/Sidebar.tsx`
- **Backend**: Authenticated `/api/v1/mentors/*` routes; schedule and meetings are served by the configured LMS.
- **State**: React Query keys use the `mentors` prefix; meeting changes invalidate the schedule.

## Pages every role has (2026-10-03)

- **Pages**: Mentors (`/mentors`), My Tracker (`/my-tracker`), My Enrolments (`/enrolments`) — in every role's sidebar (`permModule: null` in `components/layout/Sidebar.tsx`), and the page guard in `app/(dashboard)/layout.tsx` lets every role open them
- **Guard rule** (`canOpen`): a path named after a permission module (`CRM_MODULES`) needs that module's view; any other sidebar page needs its item's `permModule` — Calls is Leads — or nothing
- **My Enrolments**: own sales for everyone; "Show everyone's" with Students → view; "Generate invoice", "Correct it" and "Send again" with Students → edit
- **Roles & Permissions**: no "Daily Tracker" row — My Tracker is everyone's, so nothing checked it

---

## Course mapping (finance products + LMS courses)

- **Page**: `app/(dashboard)/courses/page.tsx` — "Map" on each course card, and mapping chips on the card
- **Dialog**: `components/courses/MapCourseDialog.tsx`
- **Backend**: `GET /api/v1/courses/finance-items`, `GET /api/v1/courses/lms-courses`, `PUT /api/v1/courses/:id` with `financeItemId` / `lmsCourseSlugs`
- **Why**: an enrolment bills against the mapped finance product, and its approval opens every mapped LMS course (a bundle opens two)

## Enrolment at the close (like Delta CRM)

- **Dialog**: `components/students/CreateStudentModal.tsx`, opened through `components/students/CloseLeadDialog.tsx` from every way of closing (status menu, lead page, Kanban drop, bulk on the leads and team pages — one after another)
- **Asks**: course(s), client email (when missing), language, payment method, receipt, bonus (yes/no + amount); shows the balance
- **Backend**: `POST /api/v1/students/receipts/:leadId`, `POST /api/v1/students` (refuses an incomplete close)
- **Why**: a close is a sale, and finance (Delta HQ) can only invoice and approve it with all of this; a lead closed any other way was a sale nobody downstream heard of

## A course's bonus (2026-10-04)

- **Page**: `app/(dashboard)/courses/page.tsx` — the card says "Course fee · $500 bonus" when a course has one
- **Dialog**: `components/courses/CourseDialog.tsx` — a Bonus field on Add and Edit (0 for none)
- **Close**: `components/students/CreateStudentModal.tsx` — a new close starts "Bonus given?" at yes with the courses' bonuses added up ("From the course — change it if this sale differs"); picking other courses moves it until the seller answers it
- **Backend**: `POST` / `PUT /api/v1/courses` with `bonusAmount`
- **Why**: what a course comes with is set once, where the course is, rather than typed at every close

---

## Commission (2026-10-04)

- **Page**: `app/(dashboard)/commission/page.tsx` — Earnings (a month: totals, per person, every sale) and Plan (each course's amounts, Sales Manager, excluded logins)
- **Courses**: each card shows what the course pays
- **Close**: the enrolment dialog shows what the counsellor earns on the sale, once finance approves it
- **Backend**: `/api/v1/commission/*`
- **Why**: the owner's commission plan per course, per CRM, with what each person earned

---

## An enrolment's five steps (2026-10-04)

- **My Enrolments**: every card ends with Finance approved → LMS account → CS assigned → Onboarded → MT5 bonus, green / yellow / red, and what it waits on
- **Enrolment page**: `/enrolments/[id]` — the steps with who did each and when, and what the sale earns
- **Commission**: a sale counts once every step is done; until then it's "In progress" with its next step

## View as (2026-10-05)

**What it does**: A super admin opens the CRM as one of their people — "View as" (eye icon) on a Users row or the user's page, for
any active user who is not a super admin. For 30 minutes the CRM is exactly theirs (pages, leads, permissions), read only, under an
amber bar: "Viewing as … · View only · 29:12 left · Back to my account". Back, the time running out or any sign-in error returns to
the admin's own account (Users page); Logout ends it and signs the admin out. The browser's push setting is left alone. The Remote
CRM's "View as", brought here unchanged.

**API**: `POST /users/:id/impersonate`, `POST /auth/impersonation/stop`.

**Change Log**:
- 1.0.0 — Initial build

## Split payments at the close (2026-10-05)

**What it does**: The closing dialog takes each payment as its own row — method, amount and receipt — with "Add another
payment" (up to 10). Money already recorded on the lead is the first row, its amount fixed. The fee summary adds them up, and
saving is blocked, in red, when collected is more than the fee. Each new payment is also added to the lead's payments, saying
how it was paid. Editing an enrolment keeps its single "collected now" figure, and refuses more than the fee too.

**API**: `POST /students` with `payments[]`; `PUT /students/:id`.

**Change Log**:
- 1.0.0 — Initial build

## Notifications keep arriving (2026-10-05)

**What it does**: New-lead notifications and browser notifications kept failing (the user, 2026-10-05).
- **Live notifications** (the bell, the sidebar's counts, reminders, team rooms): one live connection per tab
  (`lib/socket.ts`; `useSocket` hands out the same one), which never gives up — it used to stop after five quick tries,
  so after a server restart, a dropped network or a sleeping laptop the bell stayed quiet until the page was reloaded.
  Every try signs in with the latest token; it tries again at once when the tab is looked at again or the network comes
  back; somebody else signing in on the tab gets their own connection. Team rooms are joined again on every reconnect.
- **Browser notifications**: with notifications allowed, every visit makes sure the server has this device (it used to
  only on pressing Enable, so a device the server had dropped stayed silent) — and if the server's VAPID key has
  changed since the device registered (`lib/pushKey.ts`), it is registered again with the new key.
- **Test notifications** at the foot of the bell panel: whether this device has notifications on, with Enable; a test
  shown by this browser; and "Send a test to all my devices" (`POST /push/test`), which reaches the installed phone app
  even when it's closed.

**API**: `GET /push/vapid-public-key`, `POST /push/subscribe`, `DELETE /push/unsubscribe`, `POST /push/test`.

## Correct a sent-back enrolment, and see it was sent again (2026-10-05)

**What it does**: As in the Sales CRM. When finance sends an enrolment back, "Correct it" (My Enrolments, the enrolment's
page, and a banner on the student's page — for whoever has Students → edit) opens the whole closing form, filled in:
the client's name, phone and email, the courses (one or more), the fee, each payment with its receipt, the language,
the date, the fee status, the bonus, the notes, and who closed it and for which team. "Save & send again" saves it and
sends it to finance in one step, as the same invoice.

Once sent again — corrected, or with "Send again" — the card says so: "Sending again" while it is on its way, then
"Sent again" with the time (and how many times), "waiting for approval"; the steps line and the enrolment's page too.

**API**: `GET /students/:id/correction`, `PUT /students/:id/correction`; `handover.resentAt` / `resends` on the lists.

## Calls from 3CX (2026-10-12)

**What it does**: The Calls page shows only calls with leads through 3CX (synced every minute): stat cards for all,
outgoing, incoming, connected, missed and not answered (click one to filter), talk time and the average connected call;
a table per person; period (Today, 7 days, 30 days, This month, Custom — Dubai days), direction, result, salesperson and
lead name / number filters; sort by date, talk or ring; pages of 50; a CSV; and each call's recording to play. A lead's
page lists its calls the same way. A note says when it last synced, or that 3CX is not connected. Each person sees their
own calls (and their leads'), a team leader their team's, the Super Admin / Reporter / Sales Manager everyone's.

**API**: `GET /calls/log`, `GET /calls/log/lead/:leadId`, `GET /calls/log/:id/recording-link`, `POST /calls/log/sync`, `POST /calls/log/test` (Super Admin's Test connection, 2026-10-12 — settings, sign in, extensions, the newest 200 rows of the last 24 hours, one recording; as in Tetra Commission).

## Kanban pages (2026-10-13)

- **Where**: the Kanban on the Leads page and the profile page (`KanbanBoard`), and the team page's by-member board (`TeamMemberKanban`)
- **What**: one page of leads at a time — Show 100 / 300 / 500 / 1,000 (500 to start, remembered per browser) — with "1–500 of 839" and Previous / Next; shown once a board has more than 100 leads. A new filter goes back to page 1.
- **Backend**: lead lists give up to 1,000 a page (was 300; the team's 500)

## Exact money figures (2026-10-13)

- **Where**: Reports (KPI cards, rankings, leaderboards, Top Revenue Earners, tables, chart tooltips) and the team page (revenue cards, member revenue)
- **What**: the whole amount — "$2,250", "$71,570.25" — where it used to be shortened to one decimal ("$2.3K"). Only chart axes stay short ("$1.5K"), being the scale, not a figure. At most two decimals (`fmtFull`).
- **Cards**: the figure sits on its own line under the title and icon, a size smaller when long, so the whole amount fits on a phone (`KpiCard` on Reports, `MoneyFigure` on the team page)

## The open leaderboard — a TV board, live (2026-10-15)

- **Where**: `/public/leaderboard` — no sign-in; the Leaderboard page's **Public link** button copies it (or opens it
  where copying isn't allowed). For a TV on the wall or a phone. The same board as the Sales CRM's.
- **What**: only the leaderboard — a card per salesperson, the month's revenue, calls (connected), call time against
  1,000 minutes a month and today's calls and call time against 100 minutes (bars blue on the way, green with a tick
  once reached), closings, follow-ups (leads moved to Follow Up) and the leads each holds now by status. Ranked by
  revenue, calls or call time.
- **Look**: dark unless a screen is switched to light (remembered on that screen); solid colours only, blue the main one;
  1st gold, 2nd silver, 3rd bronze, everyone else the same; a turning 3D trophy for the leader only.
- **Live**: the board changes the moment the API says so (within about 5 s of a sale, a call or a lead moving); the
  cards slide to their new places, ▲ / ▼ shows who moved for a few seconds, a changed figure shows blue for a moment.
  The badge says Connecting, Live, or Reconnecting (then it still refreshes every 30 s; every minute while live). A wall
  screen moves on to the new month at midnight on the 1st (Dubai). Statuses are named as this CRM names them. Not for
  search engines.
- **On a TV**: the controls (rank, month, refresh, light / dark, full screen) and the pointer fade after 4 s untouched
  and come back with the mouse; untouched for 20 s, a board taller than the screen glides down, rests and goes back up
  (big screens only). The Dubai clock ticks in the corner.
- **Signed-in Leaderboard page**: a Today column (calls · call time today) for the current month.

## Activity — who is here, and the HRMS's shift and clock-ins (2026-10-15)

- **Where**: sidebar → Activity (the "Activity" box in Roles — the Super Admin only until a role is given it); a
  team's page → Attendance (its leaders, or the Activity box); Settings → Idle alerts.
- **People**: everyone's status now (active, no activity for…, app closed, signed out, not seen today), active time
  today, last seen, last sign-in (device, IP), "Alerted" when an idle alert is out, where the HRMS has them (clocked
  in / not clocked in / clocked out / on leave / day off), and "Shift 10:00–19:00 · in 09:57 · out 18:02".
- **Attendance**: a day (today by default, or any day picked): each person's HRMS shift, first clock-in, last
  clock-out ("still in" today, "no clock-out" on a past day), every session, worked time, the day (present,
  late · 25m, half day, left early, on leave, WFH, day off, not in yet), and now. The day's counts on top. Search and
  team filter. The HRMS not linked, or not answering → said which.
- **Sign-ins** and **Idle alerts**: every sign-in, refused one (and why) and sign-out; the alerts that went out.
- **Idle alerts (Settings)**: switch, the limit, "also alert the person's team leaders", and the working hours; only
  for someone clocked in on the HRMS (activity alone without it); never on leave; quiet counts from a later clock-in;
  in the bell (while the CRM is open) and by push — no email. While the HRMS isn't answering they wait — the Activity
  page's badge says "paused".
- **Sign-out**: recorded when someone presses Logout.
