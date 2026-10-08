using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

// Local GUI helper. No shell, execution-policy change, or network access is required.
internal static class FilePicker
{
    [STAThread]
    private static int Main(string[] args)
    {
        // A GUI process has redirected pipes, but no console whose code page can be set.
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
        try
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Length == 1 && args[0] == "--check")
            {
                using (var folder = new FolderBrowserDialog())
                using (var file = new OpenFileDialog())
                {
                    Console.Write("ready");
                }
                return 0;
            }
            if (args.Length != 2 || args[0] != "--kind" ||
                (args[1] != "folder" && args[1] != "lyrics" && args[1] != "cover"))
            {
                Console.Error.Write("Invalid picker arguments");
                return 2;
            }
            string selected = null;
            if (args[1] == "folder")
            {
                using (var dialog = new FolderBrowserDialog())
                {
                    dialog.Description = "选择 CD 音乐文件夹（只读取，不修改原文件）";
                    dialog.ShowNewFolderButton = false;
                    if (dialog.ShowDialog() == DialogResult.OK)
                        selected = dialog.SelectedPath;
                }
            }
            else
            {
                using (var dialog = new OpenFileDialog())
                {
                    dialog.Title = args[1] == "lyrics" ? "选择歌词文件" : "选择封面图片";
                    dialog.Filter = args[1] == "lyrics" ? "歌词文件|*.lrc;*.txt" : "封面图片|*.jpg;*.jpeg;*.png;*.webp";
                    dialog.CheckFileExists = true;
                    dialog.Multiselect = false;
                    if (dialog.ShowDialog() == DialogResult.OK)
                        selected = dialog.FileName;
                }
            }
            if (selected != null) Console.Write(selected);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.Write(error.ToString());
            return 1;
        }
    }
}
