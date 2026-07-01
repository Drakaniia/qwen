; Qwin Video Downloader — Inno Setup Installer Script
; ======================================================
; Build with: ISCC.exe packaging/qwin-installer.iss
;
; For the complete build pipeline, use:
;   .\packaging\build-installer.ps1

#define MyAppName "Qwin Video Downloader"
#define MyAppPublisher "Qwin"
#define MyAppURL "https://github.com/qwin-video-downloader/qwin"
#define MyAppExeName ""

; Version is passed from the build script via /dMyAppVersion=<version>
; If not provided, default to 1.0.0
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
  #pragma message "Warning: MyAppVersion not set via /d flag. Using 1.0.0"
#endif

#define InstallerSource "installer-source"

[Setup]
AppId={{8A2E5F3C-1A2B-4C3D-8E4F-5A6B7C8D9E0F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={commonpf}\Qwin
DefaultGroupName=Qwin Video Downloader
AllowNoIcons=yes
LicenseFile=..\LICENSE
OutputDir=..\dist
OutputBaseFilename=Qwin-Video-Downloader-v{#MyAppVersion}-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\extension\qwin-video-downloader.crx
UninstallDisplayName={#MyAppName} {#MyAppVersion}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} — Self-contained video downloader for Chrome, Firefox, and Yandex Browser
MinVersion=10.0.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "full"; Description: "Full installation"
Name: "custom"; Description: "Custom installation"; Flags: iscustom

[Components]
Name: "extension"; Description: "Browser extension (.crx for Chrome/Edge/Yandex)"; Types: full custom; Flags: fixed
Name: "nativehost"; Description: "Native helper (download engine, tools)"; Types: full custom; Flags: fixed
Name: "cdm"; Description: "Widevine CDM (for DRM decryption, sourced from Chrome browser)"; Types: full; ExtraDiskSpaceRequired: 0
Name: "shortcuts"; Description: "Start Menu shortcuts"; Types: full custom

[Files]
; ── Browser Extension ───────────────────────────────────────────────────
Source: "{#InstallerSource}\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: extension

; ── Native Host (PyInstaller .exe) ──────────────────────────────────────
Source: "{#InstallerSource}\native-host\qwin-host.exe"; DestDir: "{app}\native-host"; Flags: ignoreversion; Components: nativehost
Source: "..\src\native_host\qwin_video_host.bat"; DestDir: "{app}\native-host"; Flags: ignoreversion; Components: nativehost
Source: "..\src\native_host\register-host.ps1"; DestDir: "{app}\native-host"; Flags: ignoreversion; Components: nativehost

; ── CDM Installation Script ─────────────────────────────────────────────
Source: "install-cdm.ps1"; DestDir: "{app}\native-host"; Flags: ignoreversion; Components: cdm

; ── Native Messaging Manifests ──────────────────────────────────────────
Source: "{#InstallerSource}\native-manifests\com.qwin.video_downloader.chrome.json"; DestDir: "{app}\native-host"; Flags: ignoreversion; Components: nativehost
Source: "{#InstallerSource}\native-manifests\com.qwin.video_downloader.firefox.json"; DestDir: "{app}\native-host"; Flags: ignoreversion; Components: nativehost
Source: "{#InstallerSource}\native-manifests\com.qwin.video_downloader.yandex.json"; DestDir: "{app}\native-host"; Flags: ignoreversion; Components: nativehost

; ── External Tools ──────────────────────────────────────────────────────
Source: "{#InstallerSource}\tools\aria2\aria2c.exe"; DestDir: "{app}\tools\aria2"; Flags: ignoreversion; Components: nativehost
Source: "{#InstallerSource}\tools\n_m3u8dl-re\N_m3u8DL-RE.exe"; DestDir: "{app}\tools\n_m3u8dl-re"; Flags: ignoreversion; Components: nativehost
Source: "{#InstallerSource}\tools\capture\qwin-capture.exe"; DestDir: "{app}\tools\capture"; Flags: ignoreversion; Components: nativehost
Source: "{#InstallerSource}\tools\lux\lux.exe"; DestDir: "{app}\tools\lux"; Flags: ignoreversion; Components: nativehost

[Dirs]
Name: "{app}\tools\cdm"; Components: nativehost

[Icons]
Name: "{group}\Qwin Video Downloader"; Filename: "{app}\extension"; Components: shortcuts; Comment: "Open the extension folder to load in your browser"
Name: "{group}\Uninstall Qwin Video Downloader"; Filename: "{uninstallexe}"; Components: shortcuts

[Run]
; ── Native Host Registration (Chrome/Chromium-based) ────────────────────
; Chrome
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\native-host\register-host.ps1"" -Browser chrome -ManifestPath ""{app}\native-host\com.qwin.video_downloader.chrome.json"" -InstallDir ""{app}\native-host"""; Flags: runhidden; Description: "Register native host for Chrome"; StatusMsg: "Registering native host for Chrome..."; Check: IsChromeInstalled
; Edge
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\native-host\register-host.ps1"" -Browser edge -ManifestPath ""{app}\native-host\com.qwin.video_downloader.chrome.json"" -InstallDir ""{app}\native-host"""; Flags: runhidden; Description: "Register native host for Edge"; StatusMsg: "Registering native host for Edge..."; Check: IsEdgeInstalled
; Brave
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\native-host\register-host.ps1"" -Browser brave -ManifestPath ""{app}\native-host\com.qwin.video_downloader.chrome.json"" -InstallDir ""{app}\native-host"""; Flags: runhidden; Description: "Register native host for Brave"; StatusMsg: "Registering native host for Brave..."; Check: IsBraveInstalled
; Yandex
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\native-host\register-host.ps1"" -Browser yandex -ManifestPath ""{app}\native-host\com.qwin.video_downloader.yandex.json"" -InstallDir ""{app}\native-host"""; Flags: runhidden; Description: "Register native host for Yandex Browser"; StatusMsg: "Registering native host for Yandex Browser..."; Check: IsYandexInstalled
; Firefox
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\native-host\register-host.ps1"" -Browser firefox -ManifestPath ""{app}\native-host\com.qwin.video_downloader.firefox.json"" -InstallDir ""{app}\native-host"""; Flags: runhidden; Description: "Register native host for Firefox"; StatusMsg: "Registering native host for Firefox..."; Check: IsFirefoxInstalled
; Chromium
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\native-host\register-host.ps1"" -Browser chromium -ManifestPath ""{app}\native-host\com.qwin.video_downloader.yandex.json"" -InstallDir ""{app}\native-host"""; Flags: runhidden; Description: "Register native host for Chromium"; StatusMsg: "Registering native host for Chromium..."; Check: IsChromiumInstalled

; ── Widevine CDM Detection ──────────────────────────────────────────────
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\native-host\install-cdm.ps1"" -TargetDir ""{app}\tools\cdm"""; Flags: runhidden; StatusMsg: "Searching for Widevine CDM in installed browsers..."; Components: cdm

[UninstallRun]
; Clean up native messaging host registrations
Filename: "reg.exe"; Parameters: "delete ""HKCU\Software\Google\Chrome\NativeMessagingHosts\com.qwin.video_downloader"" /f"; Flags: runhidden; RunOnceId: "unreg-chrome"
Filename: "reg.exe"; Parameters: "delete ""HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.qwin.video_downloader"" /f"; Flags: runhidden; RunOnceId: "unreg-edge"
Filename: "reg.exe"; Parameters: "delete ""HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.qwin.video_downloader"" /f"; Flags: runhidden; RunOnceId: "unreg-brave"
Filename: "reg.exe"; Parameters: "delete ""HKCU\Software\Yandex\YandexBrowser\NativeMessagingHosts\com.qwin.video_downloader"" /f"; Flags: runhidden; RunOnceId: "unreg-yandex"
Filename: "reg.exe"; Parameters: "delete ""HKCU\Software\Chromium\NativeMessagingHosts\com.qwin.video_downloader"" /f"; Flags: runhidden; RunOnceId: "unreg-chromium"
Filename: "reg.exe"; Parameters: "delete ""HKCU\Software\Mozilla\NativeMessagingHosts\com.qwin.video_downloader"" /f"; Flags: runhidden; RunOnceId: "unreg-firefox"

[Code]
function IsFileOnDisk(Path: String): Boolean;
begin
  Result := FileExists(Path) or DirExists(Path);
end;

function IsChromeInstalled: Boolean;
begin
  Result := IsFileOnDisk(ExpandConstant('{pf64}\Google\Chrome\Application\chrome.exe')) or
            IsFileOnDisk(ExpandConstant('{pf32}\Google\Chrome\Application\chrome.exe')) or
            IsFileOnDisk(ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe'));
end;

function IsEdgeInstalled: Boolean;
begin
  Result := IsFileOnDisk(ExpandConstant('{pf64}\Microsoft\Edge\Application\msedge.exe')) or
            IsFileOnDisk(ExpandConstant('{pf32}\Microsoft\Edge\Application\msedge.exe'));
end;

function IsBraveInstalled: Boolean;
begin
  Result := IsFileOnDisk(ExpandConstant('{pf64}\BraveSoftware\Brave-Browser\Application\brave.exe')) or
            IsFileOnDisk(ExpandConstant('{pf32}\BraveSoftware\Brave-Browser\Application\brave.exe'));
end;

function IsYandexInstalled: Boolean;
begin
  Result := IsFileOnDisk(ExpandConstant('{pf64}\Yandex\YandexBrowser\Application\browser.exe')) or
            IsFileOnDisk(ExpandConstant('{pf32}\Yandex\YandexBrowser\Application\browser.exe'));
end;

function IsFirefoxInstalled: Boolean;
begin
  Result := IsFileOnDisk(ExpandConstant('{pf64}\Mozilla Firefox\firefox.exe')) or
            IsFileOnDisk(ExpandConstant('{pf32}\Mozilla Firefox\firefox.exe'));
end;

function IsChromiumInstalled: Boolean;
begin
  Result := IsFileOnDisk(ExpandConstant('{pf64}\Chromium\Application\chrome.exe')) or
            IsFileOnDisk(ExpandConstant('{pf32}\Chromium\Application\chrome.exe'));
end;
