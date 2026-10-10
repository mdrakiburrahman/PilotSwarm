param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$ArgumentsJson
)
$ErrorActionPreference = 'Stop'

# A kill-on-close job owns every browser descendant even when Edge's launcher exits.
# Create suspended, assign to the job, then resume: no child can escape before assignment.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PilotSwarmBrowserTree {
    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO {
        public uint cb;
        public IntPtr reserved, desktop, title;
        public uint x, y, xSize, ySize, xChars, yChars, fillAttribute, flags;
        public ushort showWindow, reserved2;
        public IntPtr reservedPointer, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct BASIC_LIMIT {
        public long processTime, jobTime;
        public uint flags;
        public UIntPtr minimumWorkingSet, maximumWorkingSet;
        public uint activeProcessLimit;
        public UIntPtr affinity;
        public uint priorityClass, schedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemoryLimit, jobMemoryLimit, peakProcessMemory, peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)]
    struct ACCOUNTING {
        public long userTime, kernelTime, periodUserTime, periodKernelTime;
        public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref EXTENDED_LIMIT limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int type, out ACCOUNTING info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    public static void Run(string executable, string[] arguments) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        try {
            var limits = new EXTENDED_LIMIT();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
            var command = new StringBuilder(Quote(executable));
            foreach (string argument in arguments) command.Append(" ").Append(Quote(argument));
            var startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(startup);
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false,
                0x4 | 0x08000000, IntPtr.Zero, null, ref startup, out process)) throw new Win32Exception();
            if (!AssignProcessToJobObject(job, process.process)) {
                TerminateProcess(process.process, 1);
                throw new Win32Exception();
            }
            if (ResumeThread(process.thread) == 0xffffffff) throw new Win32Exception();
            ACCOUNTING info;
            do {
                Thread.Sleep(100);
                if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero)) throw new Win32Exception();
            } while (info.activeProcesses != 0);
        } finally {
            CloseHandle(job);
            if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
            if (process.process != IntPtr.Zero) CloseHandle(process.process);
        }
    }
}
'@
try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsJson))
    [string[]]$browserArguments = ConvertFrom-Json $json
    [PilotSwarmBrowserTree]::Run($Executable, $browserArguments)
} catch {
    # No exception dump: native errors may include private profile or browser data.
    [Console]::Error.WriteLine('Dedicated browser process tree could not start.')
    exit 1
}
