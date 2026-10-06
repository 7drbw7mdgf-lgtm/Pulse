# Install Pulse Lite 1.1.0 on macOS without notarization

Pulse Lite 1.1.0 is an Apple Silicon macOS app. Its signature is **ad hoc** and it has **not been notarized by Apple**. macOS may block a downloaded copy on first launch. The procedures below let you approve this specific app locally; they do not give it an Apple notarization ticket or bypass Apple's notary service limits.

Download the DMG, checksum file and helper only from the [official Pulse Lite 1.1.0 release](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/tag/lite-v1.1.0). Trust the publisher before approving the app. A checksum confirms that your download matches the release file; an ad hoc signature checks bundle integrity, not developer identity or malware safety.

## 1. Verify the download and install

Download `Pulse-Lite-1.1.0.dmg` and `Pulse-Lite-1.1.0-SHA256SUMS.txt` into the same folder. In Terminal:

```sh
cd ~/Downloads
shasum -a 256 -c Pulse-Lite-1.1.0-SHA256SUMS.txt
```

Continue only if it prints `Pulse-Lite-1.1.0.dmg: OK`. If verification fails, discard the download and download it again from the release page.

Open the DMG and drag `Pulse Lite.app` into **Applications**. Replace the previous Pulse Lite app if prompted, after quitting it. Your paper library remains in `~/Library/Application Support/pulse-lite/`. Do not run Pulse Lite directly from the mounted DMG.

The disk image also contains `Allow-Pulse-Lite.command` and this guide. The helper does not install the app; copy the app first.

## 2. Approve the app in macOS settings

Try to open `/Applications/Pulse Lite.app`. If macOS blocks it because the developer cannot be verified or Apple cannot check it:

1. Open **System Settings → Privacy & Security**.
2. Find the message that Pulse Lite was blocked and click **Open Anyway**.
3. Confirm **Open** and authenticate if prompted.

Apple documents this procedure in [Safely open apps on your Mac](https://support.apple.com/en-us/102445). The exception is saved for the app. Managed Macs may restrict this option; ask your administrator if it is unavailable.

## 3. Use the app-specific helper if needed

If you trust the downloaded Pulse Lite build and want to remove its quarantine flag, use `Allow-Pulse-Lite.command` from this release. Review the script first. You can double-click it in the mounted DMG to run it in Terminal, or run it from your Downloads folder:

```sh
# Read-only verification; no changes.
bash ~/Downloads/Allow-Pulse-Lite.command --check "/Applications/Pulse Lite.app"

# Verify again, then ask for your explicit approval before changing the app.
bash ~/Downloads/Allow-Pulse-Lite.command "/Applications/Pulse Lite.app"
```

Type `yes` at the helper's prompt. Then open Pulse Lite in Finder. If Terminal cannot run a downloaded `.command` file by double-clicking, use the explicit `bash` command above.

For a copy installed in your personal Applications folder:

```sh
bash ~/Downloads/Allow-Pulse-Lite.command "$HOME/Applications/Pulse Lite.app"
```

The helper checks that the target is a `Pulse Lite.app` bundle with identifier `local.pulse.paper-linkage.lite`, version `1.1.0` and a valid deep code signature. It refuses other apps, other versions, symlink targets and execution as root. It uses this command only on the verified app:

```sh
/usr/bin/xattr -drs com.apple.quarantine "/Applications/Pulse Lite.app"
```

This removes only the quarantine attribute from the app bundle and its contents. The `-s` option acts on symlinks themselves instead of following them outside the bundle. The helper does not clear other attributes, use `sudo`, re-sign or launch the app, download anything, disable Gatekeeper, change SIP, or alter security settings for other apps. `--yes` is available for explicitly approved automated use; the normal invocation asks first.

If the helper reports a permissions error, use **Open Anyway** or install a copy in `~/Applications`. A newly downloaded update may need approval again. To restore the downloaded copy's quarantine state, delete only the app bundle and reinstall it from a fresh browser download; your separate paper library is unaffected.

## Troubleshooting

- **Signature verification failed or checksum mismatch:** download a fresh copy. The helper will not remove quarantine from a bundle whose signature fails verification.
- **“Will damage your computer” or a malware alert:** stop and investigate rather than using this helper to override the alert. Apple's article distinguishes malware alerts from unidentified-developer warnings.
- **“Read-only file system”:** copy the app into Applications first. The helper refuses changes to an app under `/Volumes`.
- **Intel Mac:** this release's native launcher is Apple Silicon only. The Python source can be run separately; see the repository README.
- **Managed Mac policy:** this helper does not override your organization's management policy. Contact your administrator.

For a distribution that opens without this local exception, the publisher must sign with Developer ID and complete Apple's [notarization workflow](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution). These local steps are not notarization.
