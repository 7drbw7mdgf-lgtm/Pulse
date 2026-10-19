# Release signing

Builds can run locally with an ad hoc Mac signature and an unsigned Windows setup while the publisher certificates are being obtained. These are not notarized or publicly trusted signatures.

## Mac

Install a **Developer ID Application** certificate and its private key in the build Mac's Keychain. Set `APPLE_SIGNING_IDENTITY` to that identity. Tauri signs the application; the packaging script also signs the DMG. To submit and staple the custom DMG, set `PULSE_NOTARY_PROFILE` to a previously configured `notarytool` Keychain profile. Tauri can also notarize its app bundle with the Apple environment variables described in its official documentation. Keep passwords and API private keys out of source and shell arguments.

```sh
APPLE_SIGNING_IDENTITY='Developer ID Application: Your publisher (TEAMID)' \
PULSE_NOTARY_PROFILE='pulse-notary' \
PULSE_BACKEND_BUILD_PYTHON=/path/to/compatible-build-venv/bin/python \
bash scripts/package-desktop.sh /path/to/fresh-release '' /path/to/portable-search-runtime
```

The build interpreter must target macOS 11+ (the existing portable CPython 3.11 build is suitable), with `scripts/requirements-macos-build.txt` installed. The resulting app includes its Python interpreter; users do not install Python.

See [Tauri Mac signing](https://v2.tauri.app/distribute/sign/macos/) for certificate and notarization setup.

## Windows

Use an existing signing certificate in `Cert:\CurrentUser\My` by setting `PULSE_WINDOWS_CERT_THUMBPRINT`. For CI, configure GitHub Actions secrets `PULSE_WINDOWS_CERT_BASE64` and `PULSE_WINDOWS_CERT_PASSWORD` instead. They are read inside PowerShell, never passed as command-line values. A PFX is imported into the temporary build user's certificate store and removed afterwards if this script imported it. Pre-existing certificates are kept.

The script signs the bundled backend and ranker, then configures Tauri to sign its native app and NSIS installer using SHA-256 and an RFC 3161 timestamp. A configured signed build fails if the final installer does not have a valid Authenticode signature. `signing.json` records whether the setup was signed. With no certificate configured the normal local/CI build still produces an unsigned installer.

See [Microsoft PFX import](https://learn.microsoft.com/en-us/powershell/module/pki/import-pfxcertificate) and [Tauri Windows configuration](https://v2.tauri.app/reference/config/#windowsconfig). No certificates or private keys belong in the repository or release assets.
