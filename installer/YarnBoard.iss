#define AppName "YarnBoard"
#define AppVersion "0.1.0"
#define AppPublisher "YarnBoard"
#define AppExeName "YarnBoard.exe"

[Setup]
AppId={{91FFAAD9-9B63-41B8-858E-D1ACF37C7E7C}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=YarnBoardSetup
Compression=lzma
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=admin

[Files]
; Your PyInstaller onedir output
Source: "..\dist\YarnBoard\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

; WebView2 Evergreen Standalone installer (downloaded by workflow)
Source: "deps\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

; .NET 8 Desktop Runtime installer (downloaded by workflow)
Source: "deps\windowsdesktop-runtime-win-x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"

[Run]
; Install WebView2 silently
Filename: "{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft WebView2 Runtime..."; Flags: waituntilterminated

; Install .NET Desktop Runtime silently
Filename: "{tmp}\windowsdesktop-runtime-win-x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing .NET Desktop Runtime..."; Flags: waituntilterminated

; Launch app after install (optional)
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
