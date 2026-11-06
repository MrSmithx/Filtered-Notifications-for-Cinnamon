const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;

const UUID = "notification-filter@local";

// Config file used by the earlier extension/applet versions. It is read once
// to carry your existing lists over, and never written to.
const LEGACY_CONFIG = GLib.build_filenamev([
    GLib.get_user_config_dir(),
    "cinnamon-notification-filter",
    "config.json"
]);

const HOOK_RETRIES = 5;

// Width of the Enable and Remove columns, so header and rows line up.
const COLUMN_PX = 64;

// The menu is always this wide. Cinnamon widens a menu to fit its widest row
// but doesn't shrink it again afterwards, so the notification lines are given
// fixed widths that fit inside it and the width never changes.
const MENU_MIN_WIDTH_PX = 330;

// Notifications listed under an app (text + time must fit the menu).
const NOTE_INDENT_PX = 0;        // extra indent; 0 lines up with the app name
const NOTE_TEXT_PX = 160;        // the title; longer text is cut with ...
const NOTE_TIME_PX = 76;         // right-aligned "5 min ago" column
const NOTE_ROW_PAD_PX = 1;       // extra space above and below each line

// Both ship in hicolor, so they resolve whatever icon theme is active.
const ICON_ON = "xsi-notifications-symbolic";
const ICON_OFF = "xsi-notifications-disabled-symbolic";

function normalize(value) {
    return String(value || "").trim().toLowerCase();
}

function timeAgo(ts) {
    let secs = Math.floor((Date.now() - ts) / 1000);

    if (secs < 60)
        return "just now";

    let mins = Math.floor(secs / 60);

    if (mins < 60)
        return mins + " min ago";

    let hours = Math.floor(mins / 60);

    if (hours < 24)
        return hours + " h ago";

    return Math.floor(hours / 24) + " d ago";
}

function minutesOr(value, fallback) {
    let n = parseInt(value, 10);

    return n > 0 ? n : fallback;
}

function unpackHint(hints, key) {
    if (!hints || hints[key] === undefined)
        return "";

    try {
        let value = hints[key];

        if (value && typeof value.deep_unpack === "function")
            value = value.deep_unpack();

        return String(value || "").trim();
    } catch (e) {
        return "";
    }
}

/* ------------------- import from the previous version ------------------ */

function readLegacyConfig() {
    try {
        let file = Gio.File.new_for_path(LEGACY_CONFIG);

        if (!file.query_exists(null))
            return null;

        let result = file.load_contents(null);

        if (!result[0])
            return null;

        let cfg = JSON.parse(ByteArray.toString(result[1]));

        let list = function (v) {
            return (Array.isArray(v) ? v : []).map(normalize).filter(Boolean);
        };

        let allowed = new Set(list(cfg.allowedApps));
        let blocked = new Set(list(cfg.blockedApps));
        let allowDefault = cfg.newAppsDefault === "allow";

        let showFor = function (key) {
            return allowDefault ? !blocked.has(key) : allowed.has(key);
        };

        let rows = new Map();

        (Array.isArray(cfg.discoveredApps) ? cfg.discoveredApps : [])
            .forEach(function (app) {
                let key = normalize(app && app.key);

                if (!key || rows.has(key))
                    return;

                rows.set(key, {
                    name: String(app.appName || app.desktopEntry || key),
                    id: String(app.desktopEntry || key),
                    show: showFor(key)
                });
            });

        [allowed, blocked].forEach(function (set) {
            set.forEach(function (key) {
                if (!rows.has(key))
                    rows.set(key, { name: key, id: key, show: showFor(key) });
            });
        });

        let apps = Array.from(rows.values()).sort(function (a, b) {
            return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });

        return {
            enabled: !!cfg.enabled,
            newAppsShow: allowDefault,
            apps: apps
        };
    } catch (e) {
        global.logError(
            "Notification Filter: could not import old config: " + e.message
        );
        return null;
    }
}

/* ------------------------------ the hook ------------------------------- */

let daemon = null;
let originalNotifyAsync = null;
let filterNotifyAsync = null;
let hookActive = false;
let foreignHook = false;

function installHook(handler) {
    daemon = Main.notificationDaemon;

    if (!daemon || typeof daemon.NotifyAsync !== "function")
        return false;

    // Something else (e.g. the old extension) already patched it.
    if (daemon._notificationFilterOriginal) {
        foreignHook = true;
        global.logError(
            "Notification Filter: notifications are already hooked; " +
            "disable the old extension"
        );
        return false;
    }

    foreignHook = false;
    originalNotifyAsync = daemon.NotifyAsync;

    filterNotifyAsync = function (params, invocation) {
        let allowed = true;

        try {
            allowed = handler(params);
        } catch (e) {
            global.logError("Notification Filter: " + e.message);
            allowed = true;   // fail open
        }

        if (allowed)
            return originalNotifyAsync.call(this, params, invocation);

        invocation.return_value(new GLib.Variant("(u)", [0]));
    };

    daemon._notificationFilterOriginal = originalNotifyAsync;
    daemon.NotifyAsync = filterNotifyAsync;
    hookActive = true;

    global.log("Notification Filter: enabled");
    return true;
}

function removeHook() {
    if (daemon && filterNotifyAsync &&
        daemon.NotifyAsync === filterNotifyAsync) {
        daemon.NotifyAsync = originalNotifyAsync;
        delete daemon._notificationFilterOriginal;
    }

    daemon = null;
    originalNotifyAsync = null;
    filterNotifyAsync = null;
    hookActive = false;

    global.log("Notification Filter: disabled");
}

/* ------------------------------- applet -------------------------------- */

class NotificationFilterApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.metadata = metadata;

        // Bound to the settings window (settings-schema.json)
        this.filterEnabled = false;
        this.newAppsShow = false;
        this.recentCount = 5;
        this.notesPerApp = 3;
        this.apps = [];
        this.migrated = false;

        this._index = new Map();   // identifier -> show (true/false)
        this._recent = [];         // apps seen since login, newest first
        this._pausedUntil = 0;     // not saved, so a restart clears a pause

        this._suppressClose = false;
        this._suppressId = 0;
        this._idleId = 0;
        this._retryId = 0;

        this.settings = new Settings.AppletSettings(this, UUID, instanceId);
        let both = Settings.BindingDirection.BIDIRECTIONAL;
        this.settings.bindProperty(both, "enabled", "filterEnabled",
            this._onSettingsChanged.bind(this), null);
        this.settings.bindProperty(both, "new-apps-show", "newAppsShow",
            this._onSettingsChanged.bind(this), null);
        this.settings.bindProperty(both, "recent-count", "recentCount",
            null, null);
        this.settings.bindProperty(both, "notes-per-app", "notesPerApp",
            this._onNotesSettingChanged.bind(this), null);
        this.settings.bindProperty(both, "apps", "apps",
            this._reindex.bind(this), null);
        this.settings.bindProperty(both, "migrated", "migrated",
            null, null);

        this.set_applet_icon_symbolic_name(ICON_OFF);

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.box.set_style("min-width: " + MENU_MIN_WIDTH_PX + "px;");

        // Activating a menu item makes Cinnamon close the menu. While an
        // item we handle is being activated, ignore that close request
        // (outside clicks and Escape arrive later and still close it).
        let originalClose = this.menu.close;
        this.menu.close = (animate) => {
            if (this._suppressClose)
                return;

            return originalClose.call(this.menu, animate);
        };
    }

    /* ---- lifecycle ---- */

    on_applet_added_to_panel() {
        this._migrate();
        this._reindex();
        this._tryInstall(0);
        this._updateIndicator();
    }

    on_applet_removed_from_panel() {
        [this._suppressId, this._idleId, this._retryId]
            .forEach(function (id) {
                if (id)
                    GLib.source_remove(id);
            });

        this._suppressId = this._idleId = 0;
        this._retryId = 0;
        this._suppressClose = false;

        removeHook();
        this.settings.finalize();
        this.menu.destroy();
    }

    on_applet_clicked() {
        if (!this.menu.isOpen)
            this._buildMenu();

        this.menu.toggle();
    }

    _tryInstall(attempt) {
        this._retryId = 0;

        if (installHook((params) => this._onNotification(params))) {
            this._updateIndicator();
            return;
        }

        // The daemon may not exist yet while Cinnamon is still starting.
        if (!foreignHook && attempt + 1 < HOOK_RETRIES) {
            this._retryId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 2, () => {
                    this._tryInstall(attempt + 1);
                    return false;
                });
        } else {
            this._updateIndicator();
        }
    }

    // One-time import of the lists from the previous version.
    _migrate() {
        if (this.migrated)
            return;

        this._set("migrated", "migrated", true);

        if (Array.isArray(this.apps) && this.apps.length > 0)
            return;

        let legacy = readLegacyConfig();

        if (!legacy)
            return;

        this._set("enabled", "filterEnabled", legacy.enabled);
        this._set("new-apps-show", "newAppsShow", legacy.newAppsShow);
        this._saveApps(legacy.apps);
    }

    /* ---- settings helpers ---- */

    _set(key, prop, value) {
        this[prop] = value;

        try {
            this.settings.setValue(key, value);
        } catch (e) {
            global.logError(
                "Notification Filter: could not save " + key + ": " + e.message
            );
        }
    }

    _saveApps(rows) {
        this._set("apps", "apps", rows);
        this._reindex();
    }

    _onSettingsChanged() {
        if (!this.filterEnabled)
            this._pausedUntil = 0;

        this._updateIndicator();
    }

    // identifier (id or name, lower case) -> show, for fast matching
    _reindex() {
        let index = new Map();

        (Array.isArray(this.apps) ? this.apps : []).forEach(function (row) {
            let show = !!row.show;

            [normalize(row.id), normalize(row.name)].forEach(function (id) {
                if (id && !index.has(id))
                    index.set(id, show);
            });
        });

        this._index = index;

        // Apps deleted from the table in Settings drop out of the menu too.
        let before = this._recent.length;

        this._recent = this._recent.filter(function (rec) {
            return [normalize(rec.id), normalize(rec.name)].some(function (id) {
                return id && index.has(id);
            });
        });

        if (this._recent.length !== before && this.menu && this.menu.isOpen)
            this._rebuildSoon();
    }

    /* ---- filtering ---- */

    _isPaused() {
        return this._pausedUntil > Date.now();
    }

    _lookup(names) {
        for (let i = 0; i < names.length; i++) {
            if (this._index.has(names[i]))
                return { matched: true, show: this._index.get(names[i]) };
        }

        return { matched: false, show: this.newAppsShow };
    }

    _onNotification(params) {
        let appName = String(params[0] || "").trim();
        let desktopEntry = unpackHint(params[6] || {}, "desktop-entry");

        // The desktop entry is the more reliable name, so it goes first.
        let names = [normalize(desktopEntry), normalize(appName)]
            .filter(Boolean);

        if (names.length === 0)
            return true;

        let result = this._lookup(names);

        this._noteSeen(names[0], appName, desktopEntry);

        // A first-time app gets a row, so you can change it in Settings.
        if (!result.matched) {
            let rows = (Array.isArray(this.apps) ? this.apps : []).concat([{
                name: appName || desktopEntry,
                id: desktopEntry || appName,
                show: this.newAppsShow
            }]);

            this._saveApps(rows);
        }

        let allowed = (!this.filterEnabled || this._isPaused())
            ? true
            : result.show;

        this._record(names[0], params[3], allowed);

        return allowed;
    }

    /* ---- notifications under each app (titles only, never saved) ---- */

    _onNotesSettingChanged() {
        if (!(parseInt(this.notesPerApp, 10) > 0)) {
            this._recent.forEach(function (rec) {
                rec.notes = [];
            });
        }
    }

    _record(key, summary, shown) {
        try {
            if (!(parseInt(this.notesPerApp, 10) > 0))
                return;

            let rec = this._recent.find(function (r) {
                return r.key === key;
            });

            if (!rec)
                return;

            let title = String(summary || "").trim();
            let last = rec.notes[0];

            // The same notification repeating collapses into one line
            if (last && last.title === title && last.shown === shown) {
                last.count++;
                last.ts = Date.now();
                return;
            }

            rec.notes.unshift({
                title: title, shown: shown, count: 1, ts: Date.now()
            });
            rec.notes = rec.notes.slice(0, 10);
        } catch (e) {
            global.logError("Notification Filter: " + e.message);
        }
    }

    _noteSeen(key, appName, desktopEntry) {
        let rec = this._recent.find(function (r) {
            return r.key === key;
        });

        if (rec) {
            rec.ts = Date.now();
        } else {
            this._recent.push({
                key: key,
                name: appName || desktopEntry,
                id: desktopEntry || appName,
                ts: Date.now(),
                notes: []          // newest first; titles only, memory only
            });
        }

        this._recent.sort(function (a, b) {
            return b.ts - a.ts;
        });
        this._recent = this._recent.slice(0, 20);
    }

    _isShown(rec) {
        return this._lookup(
            [normalize(rec.id), normalize(rec.name)].filter(Boolean)).show;
    }

    _setShown(rec, value) {
        let ids = [normalize(rec.id), normalize(rec.name)].filter(Boolean);
        let rows = (Array.isArray(this.apps) ? this.apps : []).map(
            function (r) { return Object.assign({}, r); });

        let row = rows.find(function (r) {
            return ids.indexOf(normalize(r.id)) !== -1 ||
                   ids.indexOf(normalize(r.name)) !== -1;
        });

        if (row)
            row.show = value;
        else
            rows.push({ name: rec.name, id: rec.id, show: value });

        this._saveApps(rows);
    }

    /* ---- pause ---- */

    // Filtering stays off until you resume (a Cinnamon restart also clears it)
    _pause() {
        this._pausedUntil = Infinity;
        this._updateIndicator();
    }

    /* ---- indicator ---- */

    _updateIndicator() {
        let enabled = hookActive && this.filterEnabled;
        let paused = enabled && this._isPaused();
        let filtering = enabled && !paused;

        this.set_applet_icon_symbolic_name(filtering ? ICON_ON : ICON_OFF);
        this.set_applet_tooltip(
            "Notification Filter: " +
            (paused ? "paused" : (filtering ? "on" : "off")));
    }

    /* ---- menu ---- */

    _keepOpen() {
        this._suppressClose = true;

        if (this._suppressId)
            GLib.source_remove(this._suppressId);

        this._suppressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._suppressId = 0;
            this._suppressClose = false;
            return false;
        });
    }

    _rebuildSoon() {
        // Deferred so a handler never destroys the item that is running it.
        if (this._idleId)
            return;

        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this._buildMenu();
            return false;
        });
    }

    // Removes the app from the settings table (and from this list).
    // It is added again, with the "new apps" default, if it notifies again.
    _removeApp(rec) {
        let ids = [normalize(rec.id), normalize(rec.name)].filter(Boolean);
        let rows = (Array.isArray(this.apps) ? this.apps : []).filter(
            function (r) {
                return ids.indexOf(normalize(r.id)) === -1 &&
                       ids.indexOf(normalize(r.name)) === -1;
            });

        this._recent = this._recent.filter(function (r) {
            return r.key !== rec.key;
        });

        this._saveApps(rows);
        this._rebuildSoon();
    }

    // One notification, indented under its app.
    _buildNoteItem(note) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let text = note.title || "(no title)";

        if (note.count > 1)
            text += " \u00d7" + note.count;

        if (!note.shown)
            text += " (blocked)";

        let pad = "padding: " + NOTE_ROW_PAD_PX + "px 0; font-size: 90%;";

        // Fixed-width boxes, so a line's width never depends on its text.
        let column = function (child, width) {
            let bin = new St.Bin({
                style: "width: " + width + "px;",
                x_fill: true
            });

            bin.set_child(child);
            return bin;
        };

        item.addActor(column(new St.Label({
            text: text,
            style: pad + " padding-left: " + NOTE_INDENT_PX + "px;",
            y_align: Clutter.ActorAlign.CENTER,
            opacity: note.shown ? 200 : 120
        }), NOTE_TEXT_PX), { expand: true });

        item.addActor(column(new St.Label({
            text: timeAgo(note.ts),
            style: pad + " text-align: right;",
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 150
        }), NOTE_TIME_PX));

        return item;
    }

    _columnCell(child) {
        let cell = new St.Bin({ style: "width: " + COLUMN_PX + "px;" });

        cell.set_child(child);
        return cell;
    }

    _buildHeaderItem() {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });

        let heading = function (text) {
            return new St.Label({
                text: text,
                style: "font-size: 85%; color: white;",
            });
        };

        item.addActor(heading("Application"), { expand: true });
        item.addActor(this._columnCell(heading("Enable")));
        item.addActor(this._columnCell(heading("Remove")));

        return item;
    }

    // One row: app name, show/hide switch, and a small x to remove it.
    _buildRecentItem(rec) {
        let item = new PopupMenu.PopupBaseMenuItem();
        let shown = this._isShown(rec);
        let toggle = new PopupMenu.Switch(shown);
        let skipActivate = false;

        item.addActor(new St.Label({
            text: rec.name,
            y_align: Clutter.ActorAlign.CENTER
        }), { expand: true });
        item.addActor(this._columnCell(toggle.actor));

        let remove = new St.Button({
            label: "\u2715",
            reactive: true,
            can_focus: true,
            track_hover: true,
            style: "padding: 0 8px; color: white;",
            opacity: 150
        });
        item.addActor(this._columnCell(remove));

        item.connect("activate", () => {
            // The x button's click can also reach the row; ignore that one.
            if (skipActivate) {
                skipActivate = false;
                return;
            }

            this._keepOpen();
            shown = !shown;
            toggle.setToggleState(shown);
            this._setShown(rec, shown);
        });

        remove.connect("clicked", () => {
            skipActivate = true;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                skipActivate = false;
                return false;
            });

            this._keepOpen();
            this._removeApp(rec);
        });

        return item;
    }

    _buildMenu() {
        this.menu.removeAll();

        // On / off
        let master = new PopupMenu.PopupSwitchMenuItem(
            "Filter Notifications", this.filterEnabled);

        master.connect("toggled", (_item, value) => {
            this._keepOpen();
            this._set("enabled", "filterEnabled", value);

            if (!value)
                this._pausedUntil = 0;

            this._updateIndicator();
            this._rebuildSoon();   // shows or hides the pause entry
        });
        this.menu.addMenuItem(master);

        // Problems with the hook
        if (foreignHook) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                "The old extension is still active. Disable it.",
                { reactive: false }));
        } else if (!hookActive) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                "Not active: could not hook notifications.",
                { reactive: false }));
        }

        // Pause
        if (this.filterEnabled) {
            if (this._isPaused()) {
                this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    "Notification Filtering is Paused", { reactive: false }));

                let resume = new PopupMenu.PopupMenuItem("Resume Notification Filtering");
                resume.connect("activate", () => {
                    this._pausedUntil = 0;
                    this._updateIndicator();
                });
                this.menu.addMenuItem(resume);
            } else {
                let pause = new PopupMenu.PopupMenuItem(
                    "Pause Notification Filtering");

                pause.connect("activate", () => this._pause());
                this.menu.addMenuItem(pause);
            }
        }

        // Recent apps
        this.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem("Recent apps"));

        let recent = this._recent.slice(0, minutesOr(this.recentCount, 5));

        if (recent.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                "No Recent Notifications", { reactive: false }));
        }

        if (recent.length > 0)
            this.menu.addMenuItem(this._buildHeaderItem());

        let notesShown = Math.max(0, parseInt(this.notesPerApp, 10) || 0);

        recent.forEach((rec) => {
            this.menu.addMenuItem(this._buildRecentItem(rec));

            (rec.notes || []).slice(0, notesShown).forEach((note) => {
                this.menu.addMenuItem(this._buildNoteItem(note));
            });
        });

        // Everything else is in the settings window
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let settings = new PopupMenu.PopupMenuItem("Settings\u2026");
        settings.connect("activate", () => this.configureApplet());
        this.menu.addMenuItem(settings);
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new NotificationFilterApplet(
        metadata, orientation, panelHeight, instanceId);
}