# Screen Self-Service for Jira: Documentation

Screen Self-Service for Jira lets project admins manage the screens of their company-managed project themselves, without a ticket to the
Jira admin. Shared configuration stays protected, every change shows a preview first, and the last change can always be undone.

- [Getting started](#getting-started)
- [For Jira admins](#for-jira-admins)
- [For project admins](#for-project-admins)
- [Screen Assistant (Rovo)](#screen-assistant-rovo)
- [Safety rules](#safety-rules)
- [Naming](#naming)
- [FAQ and troubleshooting](#faq-and-troubleshooting)
- [Data and privacy](#data-and-privacy)
- [Support](#support)

## Getting started

1. A Jira admin installs the app from the Atlassian Marketplace. It's free for sites with up to 10 users; larger sites get a 30-day free trial.
2. Optional: the Jira admin opens **Jira settings → Apps → Screen Self-Service for Jira** and chooses which projects may use the app
   (all projects by default).
3. A project admin opens **Project settings → Apps → Screen Self-Service for Jira** in a company-managed project.

The app checks three things when it opens: the project is company-managed, it uses field schemes, and you administer it.

**Requirements:** Jira Cloud, company-managed projects that use field schemes. Team-managed projects don't use screens.
Projects on legacy field configurations are not supported yet.

## For Jira admins

Under **Jira settings → Apps → Screen Self-Service for Jira**:

| Setting | What it does | Default |
|---|---|---|
| Delete unused screens and screen schemes automatically | Deletes objects **created by the app** after they've been unused for the chosen number of days. Project admins see the countdown. | Off (suggested: 30 days) |
| Audit log retention | Deletes older audit entries automatically | 24 months |
| Projects that can use the app | All projects, or only the project keys you list. Jira admins can always use it. | All projects |
| Copy screens from other projects | Whether project admins can search all screens on the site and use them as templates | On |
| Audit log | Every change made through the app, on all projects | — |

Jira admins can do everything a project admin can, in any project.

## For project admins

### Issue types (overview)
Each issue type shows its screen scheme and the screen used for **Default**, **Create**, **Edit** and **View**.
- **Editable** (orange dot): used only by your project.
- **Shared, read only** (lock): also used by other projects. Choose **Why locked?** to see how your project reaches the screen and which
  projects share it. You can copy it instead.
- **Inherits from Default**: the operation uses the Default screen.

### Edit a screen
Choose **Edit** on a screen. Drag fields to reorder them or drop them on another tab's name to move them. Add fields from the list on the
right, and add, rename or remove tabs. Required fields such as Summary and Issue Type can't be removed. Fields that aren't in your project's
field scheme are added to it when you save (only if the field scheme belongs to your project alone). Save with Ctrl+S / ⌘S.

### Change which screen is used
**Change assignment** on an issue type lets you pick the screen for each operation. **What happens on save** lists every rename and
assignment before anything changes. If an issue type shares its screen scheme with other issue types, you can **split it off** (copy or
share the screens) or **merge** issue types onto one scheme.

### New and copied screens
**New screen** creates an empty screen. New create screens start with Summary and Issue Type. **Copy screen** lets you search every screen
on the site (if your Jira admin allows it), preview it, and copy it into your project. The original stays untouched.

### Change fields on many screens
**Change fields on many screens** adds or removes fields on several screens at once. Pick fields, pick screens (with presets such as
"Create + Edit"), and check the per-screen preview. Shared screens are skipped automatically.

### Transition screens
Under **Transition screens**, create a screen named "KEY Transition – … – Screen" and switch it on for the transitions where it should
appear. This works for workflows used only by your project.

### Health
The **Health** page checks your project and offers one-click fixes:
- create screens without Summary (issues can't be created)
- fields on screens but missing from the field scheme (nobody sees them)
- transition screens without fields (users see an empty dialog)
- names that no longer follow the naming scheme
- empty tabs
- unused screens and schemes

### Unused
Screens and screen schemes nothing uses any more. Objects the app created can be deleted (hold the button, or click twice) or are
deleted automatically if your Jira admin turned that on. Other unused objects can only be deleted by a Jira admin.

### Undo and audit log
**Undo** (header button, toast, or Ctrl+Z / ⌘Z) reverts your last change within 24 hours, including deletions. Undo only runs if Jira still
looks exactly as it did right after your change; otherwise it refuses and changes nothing. Every change is listed in the **Audit log**.

### Keyboard
Ctrl+K / ⌘K opens a palette to jump to any screen or action.

## Screen Assistant (Rovo)
If Rovo is enabled on your site, the **Screen Assistant** agent can:
- list which screens your project uses
- explain a screen, including why it's locked
- find unused screens and their deletion dates
- add a field to, or remove a field from, a screen of your project. It asks you to confirm first, and follows the same safety rules as
  the app.

Open it from **Ask Rovo** in the app or from Rovo chat.

## Safety rules
- The app never does more than you may do in Jira: every action checks your **Administer Projects** permission (or **Administer Jira** for
  admin settings).
- Screens, schemes and workflows used by other projects are read-only. This is checked again, against live Jira data, right before every
  change.
- If Jira can't confirm that an object belongs only to your project, the app changes nothing.
- Only objects the app created can be deleted, and only when unused.

## Naming
The app keeps names consistent: `KEY IssueType - operations - Screen` (for example *PROJ Bug - create, edit - Screen*) and
`KEY IssueType - Screen Scheme`. Names follow the current assignment and update automatically when it changes.

## FAQ and troubleshooting

**The app says the project isn't supported.** It must be company-managed and use field schemes.

**I can't open the app.** You need Administer Projects for the project, and your Jira admin may have limited the app to selected projects.

**A screen is locked.** Another project uses it. Copy it to get a version only your project uses.

**"Screen Self-Service for Jira needs an active license".** The trial ended or the subscription was cancelled. A Jira admin can renew it
under Apps → Manage apps. Your Jira configuration keeps working.

**"Temporarily unavailable" or "changes paused".** SUPERPORT paused the app for maintenance. See https://superapps.statuspage.io.

**Undo was refused.** Someone changed the same objects after you. Undo only runs when it can restore exactly.

## Data and privacy
The app runs on Atlassian's platform and sends no data outside it. It stores settings, the audit log (with account IDs, no names), undo
records (24 hours) and the list of objects it created. See the [App EULA & privacy policy](https://www.superport.digital/en/apps/eula) and [Data security & privacy](DATA_SECURITY_PRIVACY.md).

## Support
SUPERPORT P.C. · [mail@superport.digital](mailto:mail@superport.digital) · [contact page](https://www.superport.digital/en/contact) · +30 698 336 9006 · +49 160 99 14 12 88
Working days 9:00–18:00 Athens time, in German, English and Greek. First response within one business day.
Status page: https://superapps.statuspage.io/
