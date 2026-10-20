using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace PulseSetup {
    public sealed class Asset { public string name; public long size; public string digest; public string browser_download_url; }
    public sealed class Release { public string tag_name; public bool draft; public bool prerelease; public Asset[] assets; }
    public sealed class Component { public string file; public long bytes; public string sha256; }
    public sealed class Manifest { public int schema; public string version; public string[] bundled; public Dictionary<string, Component> components; }
    public sealed class Plan { public string Version; public Asset Pulse; }
    public sealed class Update {
        public string Text; public double? Fraction;
        public Update(string text, double? fraction = null) { Text = text; Fraction = fraction; }
    }
    public sealed class SetupCore : IDisposable {
        public const string Repo = "7drbw7mdgf-lgtm/Pulse";
        public static readonly string[] Models = { "gemma3:4b", "nomic-embed-text" };
        public readonly string Cache;
        readonly HttpClient http;
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 2097152 };
        readonly IProgress<Update> progress;
        public SetupCore(string cache, IProgress<Update> progress, HttpMessageHandler handler = null) {
            Cache = cache; this.progress = progress;
            http = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false });
            http.Timeout = Timeout.InfiniteTimeSpan;
            http.DefaultRequestHeaders.UserAgent.ParseAdd("Pulse-Setup/1.0");
        }
        public void Dispose() { http.Dispose(); }
        void Report(string text, double? fraction = null) { if (progress != null) progress.Report(new Update(text, fraction)); }
        public static bool ValidVersion(string text) { return text != null && Regex.IsMatch(text, @"^\d{1,4}\.\d{1,4}\.\d{1,4}$"); }
        public static bool ValidHash(string text) { return text != null && Regex.IsMatch(text, "^[a-f0-9]{64}$"); }
        public static Uri AssetUrl(Asset asset, string repo, string tag) {
            Uri uri;
            if (asset == null || asset.size <= 0 || asset.size > 20L * 1024 * 1024 * 1024 ||
                String.IsNullOrEmpty(asset.name) || asset.name.Contains("/") || asset.name.Contains("\\") || asset.name.Contains("..") ||
                String.IsNullOrEmpty(tag) || tag.Contains("/") || asset.digest == null || !asset.digest.StartsWith("sha256:") ||
                !ValidHash(asset.digest.Substring(7)) || !Uri.TryCreate(asset.browser_download_url, UriKind.Absolute, out uri) ||
                uri.Scheme != "https" || uri.Host != "github.com" || !uri.IsDefaultPort || uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "" ||
                Uri.UnescapeDataString(uri.AbsolutePath) != "/" + repo + "/releases/download/" + tag + "/" + asset.name)
                throw new Exception("GitHub supplied an invalid asset or missing SHA-256 digest. No file was installed.");
            return uri;
        }
        public static Plan MakePlan(Manifest manifest, Release release, string platform = "windows-x64") {
            if (manifest == null || manifest.schema != 1 || !ValidVersion(manifest.version) || new Version(manifest.version) < new Version("2.1.1") ||
                release == null || release.draft || release.prerelease || release.tag_name != "v" + manifest.version || manifest.bundled == null ||
                new[] { "python", "pdf", "ocr", "search-ranker" }.Except(manifest.bundled).Any())
                throw new Exception("This release does not contain the complete Pulse runtime required by setup.");
            Component component;
            if (manifest.components == null || !manifest.components.TryGetValue(platform, out component))
                throw new Exception("Pulse " + manifest.version + " has no compatible package for this computer yet. Retry after the publisher adds it.");
            var expected = "Pulse-" + manifest.version + (platform == "windows-x64" ? "-Windows-x64-Setup.exe" : ".dmg");
            var asset = (release.assets ?? new Asset[0]).FirstOrDefault(a => a.name == expected);
            if (component.file != expected || !ValidHash(component.sha256) || asset == null || asset.size != component.bytes || asset.digest != "sha256:" + component.sha256)
                throw new Exception("The setup manifest and GitHub installer do not agree. Retry after the release upload finishes.");
            AssetUrl(asset, Repo, release.tag_name);
            return new Plan { Version = manifest.version, Pulse = asset };
        }
        public static string Hash(string path) {
            using (var file = File.OpenRead(path)) using (var sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
        }
        public static bool Verified(string path, Asset asset) {
            return File.Exists(path) && new FileInfo(path).Length == asset.size && asset.digest == "sha256:" + Hash(path);
        }
        static bool RedirectAllowed(Uri uri) {
            return uri.Scheme == "https" && uri.IsDefaultPort && uri.UserInfo == "" &&
                new[] { "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com" }.Contains(uri.Host);
        }
        async Task<HttpResponseMessage> Get(Uri uri, CancellationToken token) {
            for (int i = 0; i < 6; i++) {
                HttpResponseMessage response;
                using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token)) {
                    timeout.CancelAfter(TimeSpan.FromSeconds(60));
                    response = await http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                }
                var status = (int)response.StatusCode;
                if (status >= 300 && status < 400) {
                    var location = response.Headers.Location;
                    var next = location == null ? null : (location.IsAbsoluteUri ? location : new Uri(uri, location));
                    response.Dispose();
                    if (next == null || !RedirectAllowed(next)) throw new Exception("GitHub redirected the download to an untrusted address.");
                    uri = next; continue;
                }
                if (status != 200) {
                    response.Dispose();
                    throw new Exception(status == 403 || status == 429 ? "GitHub is rate limiting requests. Wait a few minutes and retry." : "Download failed (HTTP " + status + "). Check your connection and retry.");
                }
                return response;
            }
            throw new Exception("GitHub returned too many redirects.");
        }
        async Task<int> Read(Stream input, byte[] buffer, CancellationToken token) {
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token)) {
                timeout.CancelAfter(TimeSpan.FromSeconds(120));
                return await input.ReadAsync(buffer, 0, buffer.Length, timeout.Token);
            }
        }
        async Task<string> Fetch(Uri uri, long limit, string label, CancellationToken token) {
            Directory.CreateDirectory(Cache);
            var path = Path.Combine(Cache, ".download-" + Guid.NewGuid().ToString("N"));
            try {
                using (var response = await Get(uri, token)) {
                    if (response.Content.Headers.ContentLength > limit) throw new Exception("Download is larger than the release metadata allows.");
                    using (var input = await response.Content.ReadAsStreamAsync())
                    using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 131072, true)) {
                        byte[] buffer = new byte[131072]; long count = 0; int read; var clock = Stopwatch.StartNew();
                        while ((read = await Read(input, buffer, token)) != 0) {
                            count += read;
                            if (count > limit) throw new Exception("Download exceeded its expected size.");
                            await output.WriteAsync(buffer, 0, read, token);
                            if (clock.ElapsedMilliseconds >= 100 || count >= limit) {
                                Report(label + (limit > 2097152 ? String.Format(" · {0:0.0} / {1:0.0} MB", count / 1000000.0, limit / 1000000.0) : ""), limit > 2097152 ? (double?)count / limit : null);
                                clock.Restart();
                            }
                        }
                    }
                }
                return path;
            } catch { if (File.Exists(path)) File.Delete(path); throw; }
        }
        public async Task<Release> GetRelease(string repo, CancellationToken token) {
            var path = await Fetch(new Uri("https://api.github.com/repos/" + repo + "/releases/latest"), 2097152, "Checking GitHub releases", token);
            try { return json.Deserialize<Release>(File.ReadAllText(path)); } finally { File.Delete(path); }
        }
        public async Task<string> Download(Asset asset, string repo, string tag, CancellationToken token) {
            var uri = AssetUrl(asset, repo, tag);
            var path = Path.Combine(Cache, asset.digest.Substring(7) + "-" + asset.name);
            Report("Checking " + asset.name);
            if (Verified(path, asset)) return path;
            if (File.Exists(path)) File.Delete(path);
            var temporary = await Fetch(uri, asset.size, "Downloading " + asset.name, token);
            try {
                Report("Verifying SHA-256 · " + asset.name);
                if (!Verified(temporary, asset)) throw new Exception("The download failed SHA-256 verification. It was discarded. Check your connection and retry.");
                // Preserve Windows' normal downloaded-app checks for executable payloads.
                if (asset.name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                    File.WriteAllText(temporary + ":Zone.Identifier", "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=" + uri.AbsoluteUri + "\r\n");
                token.ThrowIfCancellationRequested(); File.Move(temporary, path); return path;
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        public async Task<Plan> GetPlan(CancellationToken token) {
            var release = await GetRelease(Repo, token);
            var asset = (release.assets ?? new Asset[0]).FirstOrDefault(a => a.name == "pulse-install-manifest.json");
            if (asset == null || asset.size > 65536)
                throw new Exception("GitHub's latest release (" + release.tag_name + ") is not ready for this wizard. The publisher must add the complete Pulse 2.1.1+ package and setup manifest. Retry after publication, or open the release page.");
            var path = await Download(asset, Repo, release.tag_name, token);
            return MakePlan(json.Deserialize<Manifest>(File.ReadAllText(path)), release);
        }
        public static void DiskCheck(bool localAI) {
            var drive = new DriveInfo(Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)));
            var needed = localAI ? 16000000000L : 2000000000L;
            if (drive.AvailableFreeSpace < needed) throw new Exception("Free at least " + (localAI ? "16" : "2") + " GB on your user disk, then retry.");
        }
        // Do not kill a native installer on cancellation: it must finish its own transaction.
        public static void RunInstaller(string path, string arguments = "") {
            using (var process = Process.Start(new ProcessStartInfo(path, arguments) { UseShellExecute = true })) {
                process.WaitForExit();
                if (process.ExitCode != 0 && process.ExitCode != 3010) throw new Exception("The component installer did not finish (exit " + process.ExitCode + "). Retry when ready.");
            }
        }
        public static string PulsePath {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pulse", "pulse-desktop.exe"); }
        }
        public static string FindPulse() {
            var folders = new List<string>();
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Pulse")) {
                var registered = key == null ? null : key.GetValue("InstallLocation") as string;
                if (!String.IsNullOrWhiteSpace(registered)) folders.Add(registered.Trim('"'));
            }
            folders.Add(Path.GetDirectoryName(PulsePath));
            foreach (var folder in folders.Distinct()) {
                if (!Directory.Exists(folder)) continue;
                var executable = Directory.GetFiles(folder, "*.exe").FirstOrDefault(p => !Path.GetFileName(p).ToLowerInvariant().Contains("uninstall"));
                if (executable != null) return executable;
            }
            return null;
        }
        public async Task InstallPulse(Plan plan, CancellationToken token) {
            var installer = await Download(plan.Pulse, Repo, "v" + plan.Version, token);
            var active = FindPulse();
            if (active != null && Process.GetProcessesByName(Path.GetFileNameWithoutExtension(active)).Any())
                throw new Exception("Pulse was opened during the download. Close Pulse, then retry setup.");
            token.ThrowIfCancellationRequested(); Report("Installing Pulse · complete the installer prompts");
            RunInstaller(installer);
            var path = FindPulse();
            if (path == null || !File.Exists(Path.Combine(Path.GetDirectoryName(path), "resources", "backend", "pulse_backend.exe")))
                throw new Exception("Pulse setup closed before the complete app was installed. Retry the installer.");
            var installed = FileVersionInfo.GetVersionInfo(path).ProductVersion;
            Version installedVersion;
            var expectedVersion = new Version(plan.Version);
            if (!Version.TryParse(installed, out installedVersion) || installedVersion.Major != expectedVersion.Major ||
                installedVersion.Minor != expectedVersion.Minor || installedVersion.Build != expectedVersion.Build)
                throw new Exception("The installed app version does not match the downloaded release. Retry setup.");
        }
        public async Task<string[]> OllamaTags(CancellationToken token) {
            try {
                using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token)) {
                    timeout.CancelAfter(TimeSpan.FromSeconds(2));
                    using (var response = await http.GetAsync("http://127.0.0.1:11434/api/tags", timeout.Token)) {
                        if (!response.IsSuccessStatusCode) return null;
                        var data = json.Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync());
                        var models = data["models"] as System.Collections.IEnumerable;
                        if (models == null) return null;
                        return models.Cast<object>().OfType<Dictionary<string, object>>().Select(m => (string)m["name"]).ToArray();
                    }
                }
            } catch (OperationCanceledException) { token.ThrowIfCancellationRequested(); return null; }
            catch { return null; }
        }
        public async Task EnsureOllama(CancellationToken token) {
            if (await OllamaTags(token) != null) { Report("Using your existing Ollama server"); return; }
            var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Ollama");
            var cli = Path.Combine(folder, "ollama.exe");
            if (!File.Exists(cli)) {
                var release = await GetRelease("ollama/ollama", token);
                var asset = (release.assets ?? new Asset[0]).FirstOrDefault(a => a.name == "OllamaSetup.exe");
                if (release.draft || release.prerelease || asset == null) throw new Exception("The official Ollama Windows installer is unavailable. Retry later.");
                var file = await Download(asset, "ollama/ollama", release.tag_name, token);
                token.ThrowIfCancellationRequested(); Report("Installing Ollama · complete the installer prompts");
                RunInstaller(file);
            }
            if (await OllamaTags(token) == null && File.Exists(cli)) {
                var start = new ProcessStartInfo(cli, "serve") { UseShellExecute = false, CreateNoWindow = true };
                start.EnvironmentVariables["OLLAMA_HOST"] = "127.0.0.1:11434";
                using (var child = Process.Start(start)) { /* Runtime stays available after setup closes. */ }
            }
            for (int i = 0; i < 120; i++) {
                token.ThrowIfCancellationRequested();
                if (await OllamaTags(token) != null) return;
                await Task.Delay(500, token);
            }
            throw new Exception("Ollama is installed but is not responding. Open Ollama, complete its prompts and retry. Pulse is already installed.");
        }
        public static bool ReadModelLine(string line, IProgress<Update> progress, string model) {
            var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
            if (data.ContainsKey("error")) throw new Exception("Ollama: " + data["error"]);
            var status = data.ContainsKey("status") ? (string)data["status"] : "Downloading model";
            double? fraction = null;
            if (data.ContainsKey("total") && data.ContainsKey("completed") && Convert.ToDouble(data["total"]) > 0)
                fraction = Convert.ToDouble(data["completed"]) / Convert.ToDouble(data["total"]);
            if (progress != null) progress.Report(new Update(model + " · " + status, fraction));
            return status == "success";
        }
        public async Task PullModels(CancellationToken token) {
            foreach (var model in Models) {
                var names = await OllamaTags(token) ?? new string[0];
                if (names.Contains(model) || names.Contains(model + ":latest")) { Report(model + " is already available", 1); continue; }
                Report("Downloading " + model + " from the Ollama registry");
                using (var request = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:11434/api/pull")) {
                    request.Content = new StringContent(json.Serialize(new { model = model, stream = true }), Encoding.UTF8, "application/json");
                    using (var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token)) {
                        if (!response.IsSuccessStatusCode) throw new Exception("Ollama could not start the model download. Check Ollama and retry.");
                        bool success = false;
                        using (var stream = await response.Content.ReadAsStreamAsync()) {
                            byte[] bytes = new byte[4096]; var line = new MemoryStream(); int count;
                            while ((count = await Read(stream, bytes, token)) > 0) {
                                for (int i = 0; i < count; i++) {
                                    if (bytes[i] == 10) {
                                        if (line.Length > 0) success = ReadModelLine(Encoding.UTF8.GetString(line.ToArray()), progress, model) || success;
                                        line.SetLength(0);
                                    } else { line.WriteByte(bytes[i]); if (line.Length > 65536) throw new Exception("Unexpected Ollama progress response."); }
                                }
                            }
                            line.Dispose();
                        }
                        if (!success) throw new Exception("The model download ended before verification. Retry to resume it.");
                    }
                }
                var installed = await OllamaTags(token) ?? new string[0];
                if (!installed.Contains(model) && !installed.Contains(model + ":latest")) throw new Exception("Ollama did not report " + model + " as installed. Retry to resume.");
            }
        }
    }
}
