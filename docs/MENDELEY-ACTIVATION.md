# Mendeley activation review — Pulse 1.5.7

Pulse now uses authorization-code sign-in with an S256 PKCE challenge. The implicit flow is disabled. The browser callback returns a success/failure message and removes the authorization response from browser history; access tokens and the PKCE verifier are never placed in browser content.

Requests validate the exact callback host/path, unique state, expiry, and one-use responses. Credentials and tokens stay in protected local settings. Token storage follows a successful account-profile check. Changing configuration or disconnecting prevents a delayed token response from reconnecting the old account. Provider redirects are not followed by credential-bearing requests.

## Citation export in 1.5.7

Without developer registration, **Export for Mendeley** creates a RIS file containing the chosen papers. Import it into Mendeley using drag and drop or Add New → Import Library → RIS. **Set up direct transfer** opens configuration; it does not imply account activation has completed. Connected accounts retain direct transfer.

## Activation status

**Registration is unfinished.** The Mendeley Developer Portal is at the Elsevier sign-in screen. Pulse has no real shared application client ID. Sign in to the registration tab to continue; enter credentials only on Mendeley’s page.

**Provider PKCE support is unverified.** Mendeley’s published authorization-code instructions require a confidential client secret and do not document PKCE support. Merely accepting a `code_challenge` parameter does not prove the provider enforces it.

A custom confidential application can still be configured under Advanced connection settings. Pulse sends an S256 challenge and verifier along with that application’s code exchange, but cannot claim enforced provider PKCE until live verification succeeds. No application secret is bundled in the desktop installer.

The shared public-client registration remains disabled. Its registration file requires both a real client ID and `pkceVerified: true` after verification. There is no automatic fallback to implicit sign-in.

## Steps before a public connection release

1. Sign in to the [Mendeley Developer Portal](https://dev.mendeley.com/myapps.html), register Pulse, and use the exact redirect `http://127.0.0.1:8765/mendeley/callback`. Complete any final permission/terms steps yourself when prompted.
2. Verify whether the registered native/public client is supported without distributing a secret. Ask Mendeley to confirm S256 PKCE support if the portal does not document it.
3. With the real application, verify a successful sign-in, rejected mismatched and missing verifiers, rejected duplicate/replayed codes, declined consent, expiry, disconnect, and token refresh. A successful ordinary sign-in alone does not establish PKCE enforcement.
4. If public-client PKCE is supported and these checks pass, add the public client ID/redirect and verified flag to the bundled registration. Keep secrets out of the build.
5. If Mendeley requires a confidential application, a shared desktop connection needs an HTTPS service that retains the application secret server-side, with its own reviewed code exchange and token lifecycle. No such service has been deployed for Pulse. Use custom local configuration or RIS export until it is available.

## Local verification

Automated tests cover S256 generation against the RFC 7636 example, callback host/state checks, duplicate-state rejection, encrypted token storage, provider rejection, invalid tokens/expiry, disabled implicit flow, and the shared-registration gate. These use synthetic accounts and mocked provider responses; they are not live Mendeley activation tests.

References: [OAuth Security Best Current Practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), [Mendeley authorization-code documentation](https://dev.mendeley.com/reference/topics/authorization_auth_code.html).
