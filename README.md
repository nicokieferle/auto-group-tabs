# Auto-Group Tabs – Once (Nico)

Personal MIT-licensed fork of [loilo/auto-group-tabs](https://github.com/loilo/auto-group-tabs), based on 0.0.24 (`c354e34`). This Chrome build groups **new tabs once** instead of continuously regrouping them. It is a separate unpacked extension, not an official store release.

## Verhalten

- Neue ChatGPT-Tabs (`https://chatgpt.com/*`, auch `https://chat.openai.com/*`) werden der vorhandenen nativen Chrome-Gruppe **GPT** zugeordnet. Die Farbe ist frei wählbar. Fehlt die Gruppe, wird sie erstellt.
- Alle anderen neu geöffneten Tabs, auch leere neue Tabs, kommen in **Default**. Die Regel mit URL-Muster `*` steht deshalb zuletzt.
- GPT nutzt standardmäßig auch eine bestehende Gruppe in einem anderen normalen Fenster. Default bleibt im jeweiligen Fenster. Private und normale Fenster werden nicht vermischt.
- Die Zuordnung erfolgt nach dem ersten Laden, sobald URL/Titel kurz stabil sind; bei einer dauerhaft ladenden Seite spätestens nach 12 Sekunden. Lesezeichen, die in einem **neuen** Tab geöffnet werden, funktionieren damit genauso wie andere neue Tabs.
- Danach bleibt die Zuordnung unverändert: spätere URL-/Titeländerungen, Aktualisieren, manuelles Verschieben oder Aufheben der Gruppierung lösen keine erneute Einsortierung aus. Ein leerer Tab, der schon in Default liegt und später zu ChatGPT navigiert, bleibt also in Default.
- Bereits offene Tabs werden bei Installation, Neustart des Hintergrundprozesses oder Änderung der Regeln nicht nachträglich einsortiert. Eine neue, von Chrome geerbte Gruppe darf bei der Erstzuordnung geändert werden; eine weitere Gruppenänderung während des Ladens beendet die Automatik für diesen Tab. Die erste Gruppenzuweisung eines zuvor ungruppierten neuen Tabs kann Chrome erst nachträglich melden; diese wird als geerbte Gruppe behandelt.
- Angeheftete Tabs, Chrome-Split-View-Tabs und Popup-Fenster bleiben unverändert.

## Titel-Ausnahmen

In den Optionen neben **GPT** auf den Stift klicken → **Erweiterte Einstellungen** → **Titel ausschließen, die Folgendes enthalten**. Ein Begriff pro Zeile, zum Beispiel `xxx` und `Secret`. Groß-/Kleinschreibung ist egal; es genügt, wenn der Tabtitel den Begriff enthält. Ein ausgeschlossener Tab nutzt die nächste passende Regel, normalerweise **Default**.

Die Prüfung verwendet den **Tabtitel der ersten geladenen Seite**, nicht den Namen eines Lesezeichens. Ein erst später von der Website geänderter Titel wird bewusst nicht neu geprüft. Ausnahmen in der Default-Regel lassen die Gruppierung betroffener Tabs unverändert, wenn keine weitere Regel passt.

## Installation in Chrome

1. Das bereitgestellte ZIP entpacken und den Ordner dauerhaft behalten.
2. Eine bereits installierte Original-Erweiterung **Auto-Group Tabs** deaktivieren, damit sie nicht parallel umsortiert.
3. `chrome://extensions` öffnen und **Entwicklermodus** einschalten.
4. **Entpackte Erweiterung laden** wählen und den Ordner `extension-chromium` auswählen (dort liegt `manifest.json`).
5. Beim ersten Start sind GPT und Default vorkonfiguriert. Eine bereits vorhandene Gruppe mit entsprechendem Namen wird verwendet. Gruppenname, URL-Muster und Titel-Ausnahmen lassen sich in **Weitere Optionen** ändern.

Berechtigungen bleiben `tabs`, `tabGroups`, `storage`. Es gibt keine neuen Berechtigungen, Content-Skripte, Host-Berechtigungen oder externen Netzwerkaufrufe im neuen Hintergrundcode. Regeln liegen wie beim Original in Chrome-Sync; der kurzlebige Status noch nicht einsortierter Tabs liegt in Chrome-Session-Storage, ohne URLs oder Titel.

## Build und Tests

Node.js 24 und `npm ci`. `npx playwright install chromium` installiert den Browser für die UI-Tests. `npm run build:chromium` führt Prüfungen und Build aus. Die UI-Tests laufen standardmäßig ohne sichtbares Fenster; mit `PW_HEADED=1 npm run test:browser` lassen sie sich sichtbar starten. Die Unit-Tests simulieren zusätzlich Tab-Ereignisse und Service-Worker-Neustarts.

Die ursprüngliche MIT-Lizenz und die ursprüngliche Entwicklungsdokumentation folgen.

---

# Auto-Group Tabs

This is a browser extension for Google Chrome and Firefox which enables the configuration of tab groups for certain URLs. Navigating to such a URL will automatically add the tab to its configured group (creating the group if it does not exist).

## Development

This project is built with [Vue](https://v3.vuejs.org/) and [Vite](https://vitejs.dev/).

### Setup

> **Requirements:** Note that at least Node.js v24 is needed to develop and build this project.

Clone this project:

```bash
git clone https://github.com/loilo/auto-group-tabs.git
```

Step into the cloned folder and install [npm](https://www.npmjs.com/) dependencies:

```bash
npm ci
```

### Development of the Options UI

The fastest way to tinker with the heart of this extension — its options page — is to run the `dev` script:

```bash
npm run dev
```

This will start up the Vite dev server and serve the options page on [localhost:6655](http://localhost:6655/). Having the options page directly in the browser allows for comfort features like hot module reloading to be usable during development.

In this mode, Chrome extension APIs accessed during production (e.g. `chrome.i18n` and `chrome.storage`) use browser-based fallbacks.

> **Note:** You probably want to use the [device toolbar](https://developers.google.com/web/tools/chrome-devtools/device-mode) of Chrome's devtools to give the options page a proper viewport. Chrome's options overlays are (at the time of writing) 400px wide, and I used a height of 600px during development.

### Testing in the Browser

#### Chrome

To test the extension in Chrome, you'll have to do a production build of it:

```bash
npm run build:chromium
```

This will create a subfolder with the name `extension-chromium` inside the project, which can be installed in your Chrome browser.

#### Firefox

To test the extension in Firefox, you'll have to do a production build of it and zip it:

```bash
npm run pack:gecko
```

This will create a file named `auto-group-tabs.gecko.zip` inside the project root, which can be temporarily added under `about:debugging#/runtime/this-firefox`.

### Do a Production Build

Skim through the `package.json` to find what to run for your target browser. To do all the work necessary for distributing the extension, run:

```bash
npm run deploy
```

This will run all tests, create production builds for all supported browsers, and pack them into zip files ready for upload to the respective extension stores.

### Contributing

Contributions to this project are welcome, but to spare everyone involved some time: Please open an issue first to discuss your ideas before you start working on them.

Pull requests without an issue used to be a grounds for discussion, just because of the amount of time already invested. But since due to AI, contributions have become a commodity for many, I view unsolicited pull requests as noise pollution and will close them without review.
