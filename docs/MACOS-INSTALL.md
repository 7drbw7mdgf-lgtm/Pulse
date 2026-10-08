# Install Pulse 1.5.7

Quit Pulse, open **Pulse-1.5.7.dmg**, and drag **Pulse.app** into **Applications**.

This build is for Apple Silicon Macs running macOS 11 or later. It requires Python 3.10 or later at `/opt/homebrew/bin/python3` or `/usr/local/bin/python3`. PDF extraction dependencies are included. The app is ad hoc signed and has not been notarized by Apple. Ollama is installed separately for local AI reports.

## Mendeley citations

Open the **Mendeley** pill at the top of the page. Choose which papers to export, then click **Export for Mendeley**. In Mendeley, drag in the RIS file or choose **Add New → Import Library → RIS**.

For direct account transfer, click **Set up direct transfer** and configure a registered Mendeley application. Shared application registration and provider verification remain unfinished; no application secret is bundled. See the included activation review for the remaining steps.

## Graph and compact library

The static topic legend has been removed from the map.

Click empty graph space to hide the inspector; click a paper node to show its details. Library cards use compact titles and author/year lines. Hover for full metadata, or expand the library into the full-screen table.

## Bulk actions and recovery

In the full-screen table, tick row-selection checkboxes to export, tag, transfer or remove the chosen papers. Map checkboxes remain independent. Use **Undo** for the latest change or **Recovery** for saved removal and workspace recovery points, which survive restarting Pulse. Recovery is local; JSON export makes a portable backup.

## Verification

Six frontend JavaScript test suites, syntax checks and isolated browser checks passed for this update. Packaging verifies the app signature, resource contents, version and disk image. The four existing saved papers and their content were preserved. No live Mendeley transfer was performed.
