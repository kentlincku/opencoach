param(
    [string]$WavPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "語音 測試", "native_voice_mic_challenge.wav"),
    [string]$ChallengePhrase = "Digital audio recording captures acoustic frequencies"
)

if (-not ([System.Management.Automation.PSTypeName]'MciRecorderW').Type) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class MciRecorderW {
    [DllImport("winmm.dll", EntryPoint = "mciSendStringW", CharSet = CharSet.Unicode)]
    public static extern int mciSendString(string cmd, StringBuilder ret, int len, IntPtr hwnd);
    [DllImport("winmm.dll", EntryPoint = "mciGetErrorStringW", CharSet = CharSet.Unicode)]
    public static extern bool mciGetErrorString(int err, StringBuilder ret, int len);

    public static void NormalizeWav(string path) {
        if (!System.IO.File.Exists(path)) return;
        byte[] bytes = System.IO.File.ReadAllBytes(path);
        if (bytes.Length < 12) return;
        if (Encoding.ASCII.GetString(bytes, 0, 4) != "RIFF") return;
        if (Encoding.ASCII.GetString(bytes, 8, 4) != "WAVE") return;

        int offset = 12;
        int dataOffset = -1;
        int dataLength = 0;

        while (offset + 8 <= bytes.Length) {
            string chunkId = Encoding.ASCII.GetString(bytes, offset, 4);
            uint chunkSize = BitConverter.ToUInt32(bytes, offset + 4);
            if (chunkId == "data") {
                dataOffset = offset + 8;
                dataLength = (int)Math.Min((long)chunkSize, (long)(bytes.Length - dataOffset));
                break;
            }
            offset += 8 + (int)chunkSize;
            if (chunkSize % 2 != 0) offset++;
        }

        if (dataOffset < 0 || dataLength <= 0) return;

        int max = 0;
        for (int i = dataOffset; i + 1 < dataOffset + dataLength; i += 2) {
            short val = BitConverter.ToInt16(bytes, i);
            int absVal = (val == short.MinValue) ? 32768 : Math.Abs((int)val);
            if (absVal > max) max = absVal;
        }

        if (max > 10 && max < 16000) {
            float gain = 24000.0f / (float)max;
            for (int i = dataOffset; i + 1 < dataOffset + dataLength; i += 2) {
                short val = BitConverter.ToInt16(bytes, i);
                int scaled = (int)Math.Round((float)val * gain);
                if (scaled > 32767) scaled = 32767;
                if (scaled < -32768) scaled = -32768;
                byte[] b = BitConverter.GetBytes((short)scaled);
                bytes[i] = b[0];
                bytes[i + 1] = b[1];
            }
            System.IO.File.WriteAllBytes(path, bytes);
        }
    }
}
"@
}

function Send-Mci($cmd) {
    $code = [MciRecorderW]::mciSendString($cmd, $null, 0, [IntPtr]::Zero)
    if ($code -ne 0) {
        $errSb = New-Object System.Text.StringBuilder 256
        [MciRecorderW]::mciGetErrorString($code, $errSb, 256)
        throw "MCI Error $code on '$cmd': $($errSb.ToString())"
    }
}

$parentDir = [System.IO.Path]::GetDirectoryName($WavPath)
if (-not [string]::IsNullOrEmpty($parentDir) -and -not (Test-Path $parentDir)) {
    [System.IO.Directory]::CreateDirectory($parentDir) | Out-Null
}

if (Test-Path $WavPath) { Remove-Item $WavPath -Force }

$mciOpened = $false
$synth = $null

try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $synth.SelectVoice("Microsoft Zira Desktop")
    } catch {}
    $synth.Rate = 0
    $synth.Volume = 90

    Write-Host "Opening MCI waveaudio with 16kHz 16-bit mono PCM..."
    Send-Mci "open new type waveaudio alias rec"
    $mciOpened = $true
    Send-Mci "set rec time format ms"
    Send-Mci "set rec alignment 2 bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000"

    Write-Host "Starting recording..."
    Send-Mci "record rec"
    Start-Sleep -Milliseconds 400

    Write-Host "Playing challenge phrase via speaker: '$ChallengePhrase'..."
    $synth.Speak($ChallengePhrase)
    Start-Sleep -Milliseconds 600

    Write-Host "Saving recording to $WavPath..."
    Send-Mci "save rec `"$WavPath`""
    Send-Mci "close rec"
    $mciOpened = $false
} finally {
    if ($mciOpened) {
        try { [MciRecorderW]::mciSendString("close rec", $null, 0, [IntPtr]::Zero) } catch {}
    }
    if ($synth -ne $null) {
        try { $synth.Dispose() } catch {}
    }
}

[MciRecorderW]::NormalizeWav($WavPath)

$item = Get-Item $WavPath
Write-Host "RECORD_SAVED: $($item.FullName) ($($item.Length) bytes)"
