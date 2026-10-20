using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Pulse Setup")]
[assembly: System.Reflection.AssemblyProduct("Pulse Setup")]
[assembly: System.Reflection.AssemblyCompany("Pulse")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

namespace PulseSetup {
    sealed class SetupForm : Form {
        readonly Label heading = new Label();
        readonly Label subtitle = new Label();
        readonly Label status = new Label();
        readonly Label detail = new Label();
        readonly CheckBox ai = new CheckBox();
        readonly Button primary = new Button();
        readonly Button cancel = new Button();
        readonly ProgressBar bar = new ProgressBar();
        CancellationTokenSource cancellation;
        Plan plan;
        bool busy, finished, installed;
        int page;
        readonly bool preview;
        public SetupForm(bool preview) {
            this.preview = preview;
            Text = "Pulse Setup"; ClientSize = new Size(650, 650); MinimumSize = Size; MaximumSize = Size;
            FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 10); BackColor = Color.FromArgb(246, 248, 250);
            var brand = LabelAt("●  PULSE   /   SETUP", 38, 28, 574, 25, 10); brand.ForeColor = Color.Teal;
            Position(heading, "Set up Pulse", 38, 65, 574, 45, 25); heading.Font = new Font(Font.FontFamily, 25, FontStyle.Bold);
            Position(subtitle, "Your research workspace, ready in a few steps.", 38, 116, 574, 40, 11);
            LabelAt("✓  Pulse · required\n\nLibrary, discovery, graphs and Trends. Python, PDF tools, OCR and the offline search ranker are included.", 38, 166, 574, 102, 10);
            ai.Text = "Add local AI"; ai.SetBounds(38, 289, 574, 28); ai.Font = new Font(Font, FontStyle.Bold); Controls.Add(ai);
            if (Environment.OSVersion.Version.Major < 10 || Environment.OSVersion.Version.Build < 19045) {
                ai.Enabled = false; ai.Text = "Local AI needs Windows 10 22H2 or newer";
            }
            LabelAt("Private chat and semantic embeddings with Ollama, Gemma 3 4B and nomic-embed-text. Optional · about 5 GB download · allow 16 GB free.\n\nApps download from GitHub. AI weights come from the Ollama registry. Missing WebView2 is supplied by Microsoft's installer.", 38, 325, 574, 110, 9);
            bar.SetBounds(38, 452, 574, 6); bar.Style = ProgressBarStyle.Marquee; Controls.Add(bar);
            Position(status, "Checking the latest release on GitHub…", 38, 474, 574, 64, 10);
            Position(detail, "Installs for your account. Your library and settings stay in place.", 38, 543, 574, 42, 9); detail.ForeColor = Color.DimGray;
            var releases = new Button { Text = "Release page" }; releases.SetBounds(236, 603, 120, 30); Controls.Add(releases);
            releases.Click += delegate { Process.Start(new ProcessStartInfo("https://github.com/" + SetupCore.Repo + "/releases/latest") { UseShellExecute = true }); };
            cancel.Text = "Cancel"; cancel.SetBounds(368, 603, 86, 30); Controls.Add(cancel); cancel.Click += delegate { Stop(); };
            primary.Text = "Continue"; primary.SetBounds(466, 603, 146, 30); Controls.Add(primary);
            primary.Click += async delegate { await Next(); }; AcceptButton = primary;
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) { e.Cancel = true; Stop(); } };
            Shown += async delegate {
                if (!Environment.Is64BitOperatingSystem || (Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "").Equals("ARM64", StringComparison.OrdinalIgnoreCase)) {
                    status.Text = "This setup supports Windows x64. Check GitHub releases for other builds."; primary.Enabled = false; bar.Visible = false; return;
                }
                if (preview) { status.Text = "Pulse 2.1.1 · Windows x64 · preview only"; bar.Visible = false; primary.Enabled = false; }
                else await LoadPlan();
            };
        }
        Label LabelAt(string text, int x, int y, int w, int h, float size) {
            var label = new Label(); Position(label, text, x, y, w, h, size); return label;
        }
        void Position(Label label, string text, int x, int y, int w, int h, float size) {
            label.Text = text; label.SetBounds(x, y, w, h); label.Font = new Font(Font.FontFamily, size); Controls.Add(label);
        }
        void Progress(Update update) {
            status.Text = update.Text; bar.Visible = true;
            bar.Style = update.Fraction.HasValue ? ProgressBarStyle.Continuous : ProgressBarStyle.Marquee;
            if (update.Fraction.HasValue) bar.Value = Math.Max(0, Math.Min(100, (int)(update.Fraction.Value * 100)));
        }
        SetupCore Core() { return new SetupCore(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pulse Setup", "Cache"), new System.Progress<Update>(Progress)); }
        void Begin() { busy = true; primary.Enabled = false; cancel.Enabled = true; cancel.Text = "Cancel"; cancellation = new CancellationTokenSource(); }
        void Fail(Exception error) {
            busy = false; primary.Enabled = true; primary.Text = "Retry"; cancel.Enabled = true; cancel.Text = "Close";
            ai.Enabled = Environment.OSVersion.Version.Major >= 10 && Environment.OSVersion.Version.Build >= 19045; bar.Visible = false;
            status.Text = error is OperationCanceledException ?
                (cancellation.IsCancellationRequested ? "Setup cancelled. Verified downloads are kept so you can retry." : "The connection timed out. Check your network and retry.") : error.Message;
            detail.Text = installed ? "Pulse is installed. Retry optional AI setup, or open Pulse from the Start menu." : "Check your connection and disk space. Verified downloads are kept for Retry.";
        }
        async Task LoadPlan() {
            Begin();
            try {
                using (var core = Core()) { plan = await Task.Run(() => core.GetPlan(cancellation.Token)); }
                busy = false; bar.Visible = false; primary.Enabled = true; primary.Text = "Continue";
                status.Text = String.Format("Pulse {0} · Windows x64 · {1:0} MB from GitHub", plan.Version, plan.Pulse.size / 1000000.0);
            } catch (Exception error) { Fail(error); }
        }
        async Task Next() {
            if (finished) { var path = SetupCore.FindPulse(); if (path != null) { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); Close(); } return; }
            if (plan == null) { await LoadPlan(); return; }
            if (page == 0 && primary.Text != "Retry") {
                page = 1; heading.Text = "Ready to install"; primary.Text = "Download & install";
                subtitle.Text = "Pulse" + (ai.Checked ? " and local AI · allow 16 GB free." : " · no additional runtime needed.");
                status.Text = "Pulse " + plan.Version + " · current-user installation";
                detail.Text = "Close Pulse before continuing. Native setup prompts guide installation. Existing AI settings and library are preserved."; return;
            }
            var pathNow = SetupCore.FindPulse();
            if (pathNow != null) {
                var name = Path.GetFileNameWithoutExtension(pathNow);
                if (Process.GetProcessesByName(name).Any()) { status.Text = "Close Pulse, then click Retry. Your open work will be preserved."; primary.Text = "Retry"; return; }
                Version current;
                if (Version.TryParse(FileVersionInfo.GetVersionInfo(pathNow).ProductVersion, out current) && current > new Version(plan.Version)) {
                    status.Text = "A newer Pulse version is already installed. See GitHub releases for the latest compatible setup."; primary.Enabled = false; return;
                }
            }
            var localAI = ai.Checked; Begin(); ai.Enabled = false;
            detail.Text = "You can cancel downloads. A native installation in progress will finish safely.";
            try {
                using (var core = Core()) {
                    await Task.Run(async delegate {
                        SetupCore.DiskCheck(localAI);
                        if (!installed) { await core.InstallPulse(plan, cancellation.Token); installed = true; }
                        cancellation.Token.ThrowIfCancellationRequested();
                        if (localAI) { await core.EnsureOllama(cancellation.Token); await core.PullModels(cancellation.Token); }
                    });
                }
                busy = false; finished = true; heading.Text = "Pulse is ready"; subtitle.Text = "Your research workspace is installed.";
                status.Text = localAI ? "Pulse, Ollama and both AI models are ready." : "Pulse is installed. Run setup again to add local AI.";
                detail.Text = "Open Pulse to connect Mendeley, Zotero or other library services."; bar.Visible = false;
                primary.Enabled = true; primary.Text = "Open Pulse"; cancel.Enabled = true; cancel.Text = "Close";
            } catch (Exception error) { Fail(error); }
        }
        void Stop() {
            if (busy) { cancellation.Cancel(); cancel.Enabled = false; status.Text = "Cancelling · any native installation in progress will finish safely"; }
            else Close();
        }
    }
    static class Program {
        [STAThread] static int Main(string[] args) {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            if (args.Contains("--check-release")) {
                try { using (var core = new SetupCore(Path.Combine(Path.GetTempPath(), "Pulse-setup-check"), null)) {
                    var plan = core.GetPlan(CancellationToken.None).GetAwaiter().GetResult(); Console.WriteLine("Compatible release: " + plan.Version); return 0;
                } } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
            }
            bool acquired;
            var sid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
            using (var mutex = new Mutex(true, "Local\\PulseSetup-" + sid, out acquired)) {
                if (!acquired) { MessageBox.Show("Finish or close the other setup window before opening another.", "Pulse Setup is already open"); return 1; }
                try {
                    Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                    Application.Run(new SetupForm(args.Contains("--preview"))); return 0;
                } finally { mutex.ReleaseMutex(); }
            }
        }
    }
}
