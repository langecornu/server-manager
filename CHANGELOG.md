# Changelog

## Unreleased

- **Start** button on every app that is not running. It runs the project's `npm run dev` (or `start` / `serve`), shows **Starting…** until the app is listening, and shows the exit code and last lines of output when it stops straight away. Only available on the computer Server Manager runs on.
- Long folder paths no longer push a card wider than its column.
- Package names with a display name (`productName`) keep their spacing.

## 1.0.0

First public release.

- Inventory of the Node apps running on this computer, with each one's ports, name, description and icon, and a link to open it.
- Names and descriptions come from the page title, `package.json` and README; icons come from the app's favicon. Names, descriptions and icons can be changed by hand (emoji or an uploaded image).
- Node projects found in your project folders are listed as "Not running", with the port from their config and the command that starts them.
- Each port is labelled **Local only** or **Local network**, and **HTTP** or **HTTPS**.
- Hide apps you do not care about, and bring them back with **Show hidden**.
- **Refresh** button, plus automatic rechecks every few seconds.
- Optional HTTPS with a self-signed certificate that renews itself, and optional access from the local network. The port, network access and HTTPS are changed from the Settings dialog.
- Starts at login through a macOS launch agent (`npm run autostart:install`).
