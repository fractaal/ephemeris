// Generated .cmd launchers contain UTF-8 installation paths. Use that code page only for the command, then restore
// the caller's console and return the command's status. setlocal keeps the launcher's environment out of the shell.
export const batchScript = (command) => `@echo off
setlocal
for /f "tokens=2 delims=:" %%c in ('chcp') do set "_eph_cp=%%c"
chcp 65001 >nul
${command}
set "_eph_status=%errorlevel%"
chcp %_eph_cp% >nul
exit /b %_eph_status%
`.replace(/\r?\n/g, '\r\n');

// Git Bash accepts drive-letter paths with forward slashes. Quote them as one literal shell word, as on Unix.
export const shellQuote = (p) => `'${(process.platform === 'win32' ? p.replaceAll('\\', '/') : p).replaceAll("'", "'\\''")}'`;
