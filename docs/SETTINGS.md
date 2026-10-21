# Pulse Options

The unreleased source uses a Word-style Options window: categories on the left, grouped preferences on the right and Apply/Close actions along the bottom. Existing model, API-key, reference-manager, sync and update controls remain available.

## Themes

Open **Settings → General → Application theme**. Choose System, Light, Dark, Sepia or High Contrast from the menu or preview cards. Changes apply immediately across the interface and canvas. System follows the device's light/dark appearance while Pulse is running. The existing Cmd/Ctrl+D shortcut switches explicitly between Light and Dark.

The choice is stored on this computer in a small `appearance.json` file, separately from credentials and the library. It is restored even when the desktop backend starts on a different local port. If saving fails, the selected theme remains visible and **Retry save** lets you retry persistence. Appearance preferences are not synced between computers. High Contrast is an interface theme, not a claim of complete accessibility certification.

## Finding and saving preferences

- Use **Find a setting** or Cmd/Ctrl+F to search across all categories. Titles and control labels receive priority over diagnostic text. Entered passwords and API-key values are not searched.
- Arrow keys move between categories; Tab stays within the open Options window. Escape clears an active search first, then closes the window. Closing returns focus to the control that opened Settings.
- **Apply changes** saves AI/model, paper-scanning, source-key and experimental-ranking preferences. Reference-manager setup, sync, recovery and updates retain their explicit action buttons. Themes save automatically.
- **Paper scanning** includes the full-text corpus importer. **Storage & recovery** links to the existing workspace recovery dialog.

Browser coverage includes theme previews, operating-system changes, rapid switches and failed-save recovery, profile restoration after a backend restart, settings search, API-key/ranking saves, existing connection controls, keyboard focus and 420–1440 px layouts.
