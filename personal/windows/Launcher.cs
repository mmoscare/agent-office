using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Reflection;

[assembly: AssemblyTitle("Agent Office")]
[assembly: AssemblyProduct("Agent Office")]
[assembly: AssemblyDescription("Launcher for your personal Agent Office")]
[assembly: AssemblyVersion("1.0.0.0")]

public sealed class LauncherConfig {
    public string CodeDir { get; set; }
    public string OfficeDir { get; set; }
    public string NodePath { get; set; }
    public int Port { get; set; }
    public string Branch { get; set; }
}

internal static class Program {
    internal static readonly string InstallDir = AppDomain.CurrentDomain.BaseDirectory;
    internal static readonly string PasswordFile = Path.Combine(InstallDir, "password.dat");
    internal static readonly object LogLock = new object();
    internal static LauncherConfig Config;
    internal static string Url { get { return "http://localhost:" + Config.Port; } }
    // The server binds IPv4 (0.0.0.0). Probing "localhost" tries ::1 first, which can hang on Windows
    // long enough to exhaust the timeout every time, so the health check names the IPv4 loopback.
    internal static string HealthUrl { get { return "http://127.0.0.1:" + Config.Port + "/api/health"; } }

    [STAThread]
    private static void Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try {
            Config = new JavaScriptSerializer().Deserialize<LauncherConfig>(File.ReadAllText(Path.Combine(InstallDir, "launcher.json")));
            Validate();
            if (args.Length > 0 && args[0] == "--check") {
                Console.WriteLine("Agent Office launcher configuration is valid; personal checkout: " + Config.CodeDir);
                return;
            }
            bool first;
            using (var mutex = new Mutex(true, "Local\\AgentOfficeLauncher-" + Environment.UserName, out first)) {
                if (!first || Healthy()) { OpenBrowser(); return; }
                using (var context = new OfficeContext()) {
                    if (context.StartOffice()) Application.Run(context);
                }
            }
        } catch (Exception error) {
            MessageBox.Show(error.Message, "Agent Office", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Environment.ExitCode = 1;
        }
    }

    private static void Validate() {
        if (Config == null || !File.Exists(Config.NodePath) || !Directory.Exists(Config.OfficeDir))
            throw new Exception("The configured Node installation or office folder is missing. Run the launcher installer again.");
        if (!File.Exists(Path.Combine(Config.CodeDir, "dist", "server", "server", "cli.js")))
            throw new Exception("Your personal Agent Office needs a build. Run npm run build in " + Config.CodeDir);
        string head = Path.Combine(Config.CodeDir, ".git", "HEAD");
        if (!File.Exists(head) || File.ReadAllText(head).Trim() != "ref: refs/heads/" + Config.Branch)
            throw new Exception("This launcher uses your personal branch. Switch the Agent Office checkout to " + Config.Branch + " before launching.");
    }

    internal static bool Healthy() {
        try {
            var request = (HttpWebRequest)WebRequest.Create(HealthUrl);
            request.Timeout = 600;
            request.Proxy = null;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
                return Regex.IsMatch(reader.ReadToEnd(), "\"ok\"\\s*:\\s*true");
        } catch { return false; }
    }

    internal static void OpenBrowser() { Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true }); }
    internal static string Quote(string value) {
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            quoted.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
            quoted.Append(ch); slashes = 0;
        }
        return quoted.Append('\\', slashes * 2).Append('"').ToString();
    }
    internal static void Log(string line) {
        if (line == null) return;
        lock (LogLock) {
            try { File.AppendAllText(Path.Combine(InstallDir, "server.log"), line + Environment.NewLine); } catch { }
        }
    }

    internal static string Password() {
        if (File.Exists(PasswordFile)) {
            try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(PasswordFile), null, DataProtectionScope.CurrentUser)); }
            catch { /* Ask again if this Windows account cannot decrypt the saved password. */ }
        }
        // Reuse Agent Office's saved login configuration when one already exists.
        string settings = Path.Combine(Config.OfficeDir, ".agent-office", "config.json");
        if (File.Exists(settings)) {
            var saved = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(settings)) as System.Collections.Generic.Dictionary<string, object>;
            if (saved != null && saved.ContainsKey("verifier")) return null;
        }
        using (var form = new Form { Text = "Agent Office", ClientSize = new Size(410, 174), FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterScreen, MinimizeBox = false, MaximizeBox = false }) {
            form.Icon = new Icon(Path.Combine(InstallDir, "Agent Office.ico"));
            var label = new Label { Text = "Enter the password you use for Agent Office.\nWindows will remember it for this launcher.", Left = 20, Top = 18, Width = 370, Height = 43 };
            var field = new TextBox { Left = 20, Top = 74, Width = 370, UseSystemPasswordChar = true };
            var start = new Button { Text = "Open Agent Office", Left = 232, Top = 119, Width = 158, DialogResult = DialogResult.OK };
            var cancel = new Button { Text = "Cancel", Left = 138, Top = 119, Width = 84, DialogResult = DialogResult.Cancel };
            form.Controls.AddRange(new Control[] { label, field, start, cancel });
            form.AcceptButton = start; form.CancelButton = cancel;
            if (form.ShowDialog() != DialogResult.OK || String.IsNullOrEmpty(field.Text)) throw new OperationCanceledException();
            File.WriteAllBytes(PasswordFile, ProtectedData.Protect(Encoding.UTF8.GetBytes(field.Text), null, DataProtectionScope.CurrentUser));
            return field.Text;
        }
    }
}

internal sealed class OfficeContext : ApplicationContext {
    private Process server;
    private Process terminal;
    private readonly NotifyIcon tray;
    private readonly System.Windows.Forms.Timer monitor;
    private bool stopping;

    internal OfficeContext() {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Agent Office", null, delegate { Program.OpenBrowser(); });
        menu.Items.Add("Show server terminal", null, delegate { ShowTerminal(); });
        menu.Items.Add("Restart Agent Office", null, delegate { if (StopOffice() && !StartOffice()) ExitThread(); });
        menu.Items.Add("Stop Agent Office and exit", null, delegate { if (StopOffice()) ExitThread(); });
        tray = new NotifyIcon { Icon = new Icon(Path.Combine(Program.InstallDir, "Agent Office.ico")), Text = "Agent Office", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { Program.OpenBrowser(); };
        monitor = new System.Windows.Forms.Timer { Interval = 1500 };
        monitor.Tick += delegate {
            if (!stopping && server != null && server.HasExited) {
                monitor.Stop();
                MessageBox.Show("Agent Office stopped. See server.log in " + Program.InstallDir + " for details.", "Agent Office");
                ExitThread();
            }
        };
    }

    internal bool StartOffice() {
        try {
            var config = Program.Config;
            string password = Program.Password();
            var start = new ProcessStartInfo(config.NodePath) {
                Arguments = Program.Quote(Path.Combine(Program.InstallDir, "host.mjs")) + " " + Program.Quote(config.CodeDir) + " " + Program.Quote(config.OfficeDir) + " " + config.Port,
                WorkingDirectory = config.CodeDir, UseShellExecute = false, CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            if (password != null) start.EnvironmentVariables["AGENT_OFFICE_PASSWORD"] = password;
            server = new Process { StartInfo = start };
            server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Program.Log(e.Data); };
            server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Program.Log(e.Data); };
            Program.Log("--- Agent Office started " + DateTime.Now.ToString("s") + " ---");
            server.Start(); server.BeginOutputReadLine(); server.BeginErrorReadLine();
            ShowTerminal();
            // Wait by the clock, not by attempt count: a refused probe returns instantly, a hung one takes the whole timeout.
            DateTime deadline = DateTime.UtcNow.AddSeconds(90);
            while (DateTime.UtcNow < deadline) {
                if (server.HasExited) throw new Exception("Agent Office could not start. See server.log in " + Program.InstallDir);
                if (Program.Healthy()) { monitor.Start(); Program.OpenBrowser(); return true; }
                Thread.Sleep(300);
            }
            throw new Exception("Agent Office did not become ready. See server.log in " + Program.InstallDir);
        } catch (OperationCanceledException) { return false; }
        catch (Exception error) { StopOffice(); MessageBox.Show(error.Message, "Agent Office", MessageBoxButtons.OK, MessageBoxIcon.Error); return false; }
    }

    // The server itself stays hidden (a console of its own kept it from coming up); this window follows server.log live.
    private void ShowTerminal() {
        if (terminal != null && !terminal.HasExited) return;
        string log = Path.Combine(Program.InstallDir, "server.log").Replace("'", "''");
        string script = "$Host.UI.RawUI.WindowTitle = 'Agent Office server'; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; "
            + "Write-Host 'Live output of the Agent Office server. Closing this window does not stop the office; use the tray icon for that.' -ForegroundColor DarkGray; "
            + "Get-Content -LiteralPath '" + log + "' -Wait -Tail 40 -Encoding UTF8";
        try {
            terminal = Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -NoLogo -ExecutionPolicy Bypass -Command " + Program.Quote(script)) { UseShellExecute = true });
        } catch (Exception error) { Program.Log("terminal window: " + error.Message); }
    }

    private void CloseTerminal() {
        if (terminal == null) return;
        try { if (!terminal.HasExited) terminal.Kill(); } catch { }
        terminal.Dispose(); terminal = null;
    }

    private bool StopOffice() {
        monitor.Stop(); stopping = true;
        CloseTerminal();
        if (server != null) {
            try {
                if (!server.HasExited) {
                    server.StandardInput.WriteLine("stop"); server.StandardInput.Flush();
                    if (!server.WaitForExit(10000)) throw new Exception("The office is still shutting down. Wait before launching it again.");
                }
            } catch (Exception error) {
                Program.Log(error.Message);
                stopping = false;
                monitor.Start();
                MessageBox.Show(error.Message, "Agent Office");
                return false;
            }
            server.Dispose(); server = null;
        }
        stopping = false;
        return true;
    }

    protected override void Dispose(bool disposing) {
        if (disposing) { StopOffice(); monitor.Dispose(); tray.Visible = false; tray.Dispose(); }
        base.Dispose(disposing);
    }
}
