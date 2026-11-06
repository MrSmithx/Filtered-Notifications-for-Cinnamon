# Notification Filter

A small Cinnamon applet that decides which applications may show desktop notifications. Pick the apps you want to hear from, silence the rest, and see at a glance what was blocked.

## Features

- **Per-app control.** One list, one *Show* checkbox per app. Apps are added automatically the first time they send a notification.
- **Choose the default for new apps.** Show them, or hide them until you decide.
- **Compact panel menu.** Master switch, pause, and your most recent apps with a switch and a remove button each.
- **See what was blocked.** Recent notification titles are listed under their app, with blocked ones marked. Click a blocked one to start showing that app.
- **Blocked counter.** A small number next to the panel icon counts notifications blocked since you last opened the menu.
- **Critical notifications always get through.** Low battery, disk full and similar urgent warnings are never blocked (can be turned off).
- **Pause until you resume.** Show everything for a while without changing your lists.
- **Native settings window.** Everything else lives in Cinnamon's own applet settings, including an editable table of applications.

## Requirements

- Cinnamon 6.x (developed and used on Cinnamon 6.6.9 with Linux Mint)
- `libnotify-bin` is optional, only for testing with `notify-send`

## Usage

### Panel menu

Click the panel icon.

| Item | What it does |
| --- | --- |
| **Filter notifications** | Master switch. When off, every notification is shown. |
| **Pause until I resume** | Shows everything until you choose **Resume now**. Cleared when Cinnamon restarts. |
| **Recent apps** | The latest apps that sent a notification. The switch shows or hides an app; the **✕** removes it from the list. |
| **Notifications under each app** | Recent titles, newest first. Blocked ones are dimmed and marked *(blocked)*; click one to start showing that app. |
| **Settings…** | Opens the settings window. |

The panel icon is a bell when filtering is on and a slashed bell when it is off or paused. A number beside it counts notifications blocked since you last opened the menu.

### Settings window

Open it from **Settings…** in the menu, or right-click the applet and choose **Configure**.

**General**

| Setting | Default | Description |
| --- | --- | --- |
| Filter notifications | Off | Turns filtering on. |
| Show notifications from new apps | Off | What happens the first time an app notifies. The app is then added to the list. |
| Always show critical notifications | On | Urgent warnings are never blocked. |
| Recent apps shown | 5 | How many apps the panel menu lists (1–15). |
| Notifications shown per app | 3 | Titles listed under each app (0–10). 0 turns the list off. |

**Applications**

A table with one row per app: **Application**, **Identifier** and **Show**. Tick *Show* to allow an app. Use the add, edit and remove buttons to manage rows. You can add an app by name before it has ever notified you; a row matches if either its name or its identifier matches the notification.

### Trying it out

```bash
# A first-time app: it should appear in Settings → Applications
notify-send -a "TestApp" "Hello"

# Untick Show for TestApp, make sure filtering is on, then send it again
notify-send -a "TestApp" "Hello again"

# Critical notifications are shown regardless of the list
notify-send -u critical -a "TestApp" "Important"
```

## How it works

The applet wraps `NotifyAsync` in Cinnamon's notification daemon. Each notification passes through it before anything is shown:

1. The app is identified from its `desktop-entry` hint, falling back to the application name.
2. If the app isn't in your list yet, a row is added using the "new apps" default.
3. If filtering is on and not paused, the app's *Show* setting decides, unless the notification is critical.
4. Blocked notifications are answered with an id of `0` and never displayed.

If anything goes wrong inside the filter, the notification is shown. A broken filter never swallows notifications.

## Privacy

- Only the **app name and the notification title** are remembered, and only **in memory**. Message text is never read or stored.
- The notification history is lost when you log out or reload Cinnamon.
- Your app list and settings are saved by Cinnamon in `~/.config/cinnamon/spices/notification-filter@local/`.

## Limitations

- **Matching is per app.** A browser sends every site's notifications under its own name, so you can't allow one site and block another.
- **Startup gap.** Notifications that arrive before Cinnamon loads the applet at login are not filtered.
- **Blocked notifications can't be replayed.** Showing an app again only affects future notifications.
- **Relies on a Cinnamon internal.** A Cinnamon update could change the function the applet hooks. If so, the filter stops working and notifications show normally; the menu says when the hook isn't active.
- **Only one hook at a time.** Don't run another extension that patches `NotifyAsync` alongside this one.

## Uninstall

1. Right-click the panel, choose **Applets**, and remove **Notification Filter**.
2. Delete the files:

   ```bash
   rm -r ~/.local/share/cinnamon/applets/notification-filter@local
   rm -r ~/.config/cinnamon/spices/notification-filter@local   # saved list and settings
   ```
