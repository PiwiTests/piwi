---
title: Access, roles and groups
description: "Give each person the rights their job needs, project by project: the five project roles and what each can do, groups, who manages access, and the permission grid."
lang: en-US
---

# Access, roles and groups

With [authentication](./authentication) on, what a signed-in user can do inside a project comes from the **project
roles** they hold there. An Administrator can do everything on every project. A Member can do only what their project
roles allow, granted to them directly or to one of their groups; a Member with no role sees an empty dashboard.

## Project roles

A project role is a fixed set of rights inside a project, granted to a user or a group, on one project or on all
projects. The first four build on each other, each including everything the one before it can do. Uploader stands
apart.

| Role | Typical holder | What it is for |
|---|---|---|
| **Viewer** | stakeholder | Reads everything in the project. |
| **Contributor** | product owner, manager | Files issues, pins links, edits bug reports, schedules reports, adds markers. |
| **Maintainer** | QA engineer, developer | Triages failures, quarantines tests, runs AI diagnosis, uploads runs, creates share links. |
| **Project admin** | QA lead, tech lead | Edits the project settings and members, deletes runs. |
| **Uploader** | CI account | For CI: reads the project and uploads runs, nothing else. |

## What each role can do

Each row is one permission. The **Permission** column is how the [API docs](https://piwitests.dev/demo/docs) name
each endpoint's requirement (`x-required-permission`), so a script author can tell which role a call needs. In the app,
**Settings → Roles** shows the same table to every signed-in user.

| What you can do | Permission | Viewer | Contributor | Maintainer | Project admin | Uploader |
|---|---|:-:|:-:|:-:|:-:|:-:|
| Read runs, executions, clusters, analytics | `project:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| File a Jira issue | `issue:create` | | ✓ | ✓ | ✓ | |
| Pin, edit and remove links | `link:write` | | ✓ | ✓ | ✓ | |
| Edit a bug report | `bug-report:write` | | ✓ | ✓ | ✓ | |
| Save and schedule reports | `report:write` | | ✓ | ✓ | ✓ | |
| Add and edit timeline markers | `marker:write` | | ✓ | ✓ | ✓ | |
| Create share links, share a dashboard | `share:create` | | | ✓ | ✓ | |
| Triage clusters and gaps | `triage:write` | | | ✓ | ✓ | |
| Quarantine and release tests | `quarantine:write` | | | ✓ | ✓ | |
| Run AI diagnosis (spends tokens) | `ai:run` | | | ✓ | ✓ | |
| Re-run in CI, bisect, Flake Lab, fix attempts | `run:control` | | | ✓ | ✓ | |
| Edit selections and test functions | `test-assets:write` | | | ✓ | ✓ | |
| Upload runs | `run:submit` | | | ✓ | ✓ | ✓ |
| Edit project settings and Jira binding | `project:manage` | | | | ✓ | |
| Manage the project's members | `project:members` | | | | ✓ | |
| Delete runs, release kept runs | `run:delete` | | | | ✓ | |

Only an Administrator holds the **instance permissions**: `users:manage`, `groups:manage`, `settings:manage`,
`connections:manage`, `storage:manage`, `tags:manage`, `project:create` and `project:delete`. An endpoint any
signed-in user may call (their profile, API keys, dashboards, channels, subscriptions) declares `signed-in`.

## All projects or one project

A role is granted on one project, or on **All projects**, which also covers projects created later. A user's rights on
a project are the **union** of every role they hold there, on that project and on All projects, directly and through
each of their groups. Maintainer on All projects plus Project admin on `web-app` means Project admin on `web-app` and
Maintainer everywhere else.

Results sent under a new project name create the project only for an account that can upload on All projects.

## Groups

A group is a named set of users, such as *QA*, *Product owners* or *CI*. It receives project roles the way a user
does, so a new hire gets their access by joining groups. Administrators create, rename and delete groups and edit
their members in **Settings → Groups**.

- **Rights add up.** A user in *Product owners* (Contributor on All projects) and *QA* (Maintainer on All projects)
  can do what a Maintainer does everywhere.
- **No deny rules.** To take a right away, remove the role that grants it.
- **No nested groups.** A group holds users, never other groups.
- **A group never makes anyone an Administrator.** That instance role is granted to a user, on their own row in
  **Settings → Users**.

## Who manages access

**Administrators** manage everything: users, groups, and roles on every project and on All projects. A **Project
admin** manages the members of their own projects and may grant any project role there, Project admin included, but
cannot change roles on other projects or on All projects.

Roles are granted from four places, which all edit the same grants:

- **Settings → Permissions**, the [permission grid](#permission-grid): every group and user against every project.
- **Settings → Users → Project roles**, the action next to a user: their role on All projects and on each project,
  with the groups that add to them.
- A project's **Settings → Members**: the users and groups with a role on that project. Project admins see it for
  their own projects.
- **Settings → Groups** for who belongs to each group; its roles are set on the grid or in a project's Members.

Scripts read and change the same grants, called role bindings, through the API; see the
[API docs](https://piwitests.dev/demo/docs).

## Permission grid

**Settings → Permissions** lays every group and user against every project on one grid. Groups come first, above the
users; columns are projects, after an **All projects** column. Each cell is a role selector: pick a role to grant it
there, or none to remove it.

<div class="doc-screenshot">
  <img src="/screenshots/permission-grid.png" alt="Settings → Permissions: groups above users down the side, projects across the top, and a role selector in each cell">
</div>

- **Every change saves at once.** A change the server refuses is rolled back and reported.
- **Inherited roles show faint.** A role a user holds only through a group or All projects appears faint, and its
  tooltip names its source.
- **All projects** also covers projects created later. Removing a role there leaves the per-project roles as they were.
- **Administrators** can do everything everywhere, so their row is locked.
- **Hovering or focusing a cell highlights its row and column.** Tab enters the grid as one stop, the arrow keys move
  between cells, and Space or Enter opens the role selector.
- **Filter users** and **Filter projects** narrow the grid on a large instance.

## Default is no access

A new Member, added in **Settings → Users** or created by an [OAuth](./authentication#oauth-google-github) sign-in,
holds no role and sees an empty dashboard until you grant one, as does an account whose last role you remove. A
project the user has no role on is left out of the project list, sidebar, home dashboard, recent runs and search, and
its runs, test cases and clusters return **403**. A link to one of its pages opens a _No access_ page, answered with the
same 403, that says an administrator or a Project admin of that project can grant a role.

## CI accounts

Run the reporter in CI as a Member with the **Uploader** role, through an [API key](./api-keys): it reads the project
and uploads runs, nothing else. Grant it on All projects when CI should create projects from a new project name, else
on the projects it reports to.

## Upgrading from the three roles

Earlier versions had three instance-wide roles (Administrator, Reporter, User) and assigned projects to each account.
The upgrade converts them:

- **Administrator** stays Administrator.
- **Reporter** becomes a Member with the Maintainer role on the same projects.
- **User** becomes a Member with the Viewer role on the same projects.

Access to all projects becomes a role on All projects. A Maintainer can do exactly what a Reporter could, and a Viewer
what a User could, so nobody gains or loses a right. To narrow a CI account that ran as a Reporter, give it Uploader in
place of Maintainer.

> **Try it in the demo:** the [live demo](https://piwitests.dev/demo/) ships with seeded identities, from an
> administrator to a viewer. Switch between them with the **Acting as** picker in the demo banner and watch the
> projects and actions change. See [UI overview → Live demo](/features/ui-overview#live-demo).

## Related

- [Authentication](./authentication): turning sign-in on, instance roles and user management
- [API keys](./api-keys): a key acts with its owner's instance role and project roles
- [Production checklist](./production-checklist): what to set before anyone else can reach the instance
