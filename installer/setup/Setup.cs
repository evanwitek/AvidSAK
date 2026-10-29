using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

// Single-file setup for the Avid Swiss Army Knife panel.
// Unpacks the embedded payload to a temp folder, then runs installer\install.cmd from it.
// install.cmd does the real work (admin prompt, Node check, copy, scheduled task).
static class Setup
{
    [STAThread]
    static int Main()
    {
        string target = Path.Combine(Path.GetTempPath(), "MediaFolderPanel-Setup-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(target);
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive zip = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string dest = Path.Combine(target, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(dest);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    entry.ExtractToFile(dest, true);
                }
            }

            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + Path.Combine(target, "installer", "install.cmd") + "\"\"");
            psi.WorkingDirectory = Path.Combine(target, "installer");
            psi.UseShellExecute = false;
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("Setup could not run:\n\n" + ex.Message, "Avid Swiss Army Knife Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        // The files are not deleted here: install.cmd may relaunch itself elevated and return at once,
        // and the elevated copy still needs them.
    }
}
