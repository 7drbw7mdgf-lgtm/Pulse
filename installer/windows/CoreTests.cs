using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace PulseSetup {
    sealed class FakeGitHub : HttpMessageHandler {
        public int Requests;
        public byte[] Bytes = Encoding.UTF8.GetBytes("abc");
        public bool Redirect;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
            token.ThrowIfCancellationRequested(); Requests++;
            var response = new HttpResponseMessage(Redirect ? HttpStatusCode.Redirect : HttpStatusCode.OK);
            if (Redirect) response.Headers.Location = new Uri("https://evil.example/payload.exe");
            response.Content = new ByteArrayContent(Bytes); return Task.FromResult(response);
        }
    }
    static class CoreTests {
        static int checks;
        static void Expect(bool value, string name) { checks++; if (!value) throw new Exception("FAIL: " + name); }
        static void Reject(Action action, string name) { try { action(); } catch { checks++; return; } throw new Exception("FAIL: accepted " + name); }
        static int Main() {
            var folder = Path.Combine(Path.GetTempPath(), "Pulse-setup-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);
            try {
                var file = Path.Combine(folder, "payload"); File.WriteAllText(file, "abc");
                var hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
                var asset = new Asset { name = "Pulse-2.1.1-Windows-x64-Setup.exe", size = 3, digest = "sha256:" + hash,
                    browser_download_url = "https://github.com/" + SetupCore.Repo + "/releases/download/v2.1.1/Pulse-2.1.1-Windows-x64-Setup.exe" };
                var release = new Release { tag_name = "v2.1.1", assets = new[] { asset } };
                var manifest = new Manifest { schema = 1, version = "2.1.1", bundled = new[] { "python", "pdf", "ocr", "search-ranker" },
                    components = new System.Collections.Generic.Dictionary<string, Component> { { "windows-x64", new Component { file = asset.name, bytes = 3, sha256 = hash } } } };
                Expect(SetupCore.Hash(file) == hash && SetupCore.Verified(file, asset), "known hash");
                File.WriteAllText(file, "abd"); Expect(!SetupCore.Verified(file, asset), "corrupt cache");
                Expect(SetupCore.MakePlan(manifest, release).Version == "2.1.1", "plan");
                release.draft = true; Reject(() => SetupCore.MakePlan(manifest, release), "draft"); release.draft = false;
                release.tag_name = "v2.1.2"; Reject(() => SetupCore.MakePlan(manifest, release), "tag mismatch"); release.tag_name = "v2.1.1";
                Reject(() => SetupCore.MakePlan(manifest, release, "macos-arm64"), "missing platform");
                manifest.bundled = new[] { "python" }; Reject(() => SetupCore.MakePlan(manifest, release), "incomplete runtime");
                manifest.bundled = new[] { "python", "pdf", "ocr", "search-ranker" };
                manifest.version = "2.0.1"; Reject(() => SetupCore.MakePlan(manifest, release), "legacy runtime"); manifest.version = "2.1.1";
                var original = asset.browser_download_url;
                foreach (var url in new[] { original.Replace("https:", "http:"), original.Replace("github.com/", "github.com.evil.example/"), original + "?token=bad", original.Replace(SetupCore.Repo, "other/repo") }) {
                    asset.browser_download_url = url; Reject(() => SetupCore.AssetUrl(asset, SetupCore.Repo, "v2.1.1"), "untrusted URL");
                }
                asset.browser_download_url = original;
                Expect(SetupCore.ReadModelLine("{\"status\":\"success\"}", null, "model"), "model success");
                Reject(() => SetupCore.ReadModelLine("{\"error\":\"disk full\"}", null, "model"), "model error");
                var handler = new FakeGitHub();
                using (var core = new SetupCore(Path.Combine(folder, "cache"), null, handler)) {
                    var download = core.Download(asset, SetupCore.Repo, "v2.1.1", CancellationToken.None).GetAwaiter().GetResult();
                    Expect(SetupCore.Verified(download, asset), "streamed download");
                    core.Download(asset, SetupCore.Repo, "v2.1.1", CancellationToken.None).GetAwaiter().GetResult();
                    Expect(handler.Requests == 1, "verified cache avoids network");
                    File.WriteAllText(download, "bad");
                    core.Download(asset, SetupCore.Repo, "v2.1.1", CancellationToken.None).GetAwaiter().GetResult();
                    Expect(handler.Requests == 2 && SetupCore.Verified(download, asset), "corrupt cache repaired");
                    File.Delete(download); handler.Bytes = Encoding.UTF8.GetBytes("abd");
                    Reject(() => core.Download(asset, SetupCore.Repo, "v2.1.1", CancellationToken.None).GetAwaiter().GetResult(), "bad checksum");
                    Expect(!File.Exists(download), "bad file never committed");
                    handler.Redirect = true;
                    Reject(() => core.Download(asset, SetupCore.Repo, "v2.1.1", CancellationToken.None).GetAwaiter().GetResult(), "untrusted redirect");
                    handler.Redirect = false;
                    var cancel = new CancellationTokenSource(); cancel.Cancel();
                    Reject(() => core.Download(asset, SetupCore.Repo, "v2.1.1", cancel.Token).GetAwaiter().GetResult(), "cancelled download");
                }
                // Serializer shape used by OllamaTags: object arrays must work too.
                var json = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>("{\"models\":[{\"name\":\"gemma3:4b\"}]}");
                Expect(json["models"] is System.Collections.IEnumerable, "model list shape");
                Console.WriteLine("Pulse Windows setup: " + checks + " checks passed"); return 0;
            } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
            finally { Directory.Delete(folder, true); }
        }
    }
}
