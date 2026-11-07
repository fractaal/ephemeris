// ZIPs downloaded by the studio: Windows ships bsdtar; unzip preserves macOS app-bundle permissions elsewhere.
import { execFileSync } from 'node:child_process';

export function extractZip(zip, dir) {
  if (process.platform === 'win32') execFileSync('tar.exe', ['-xf', zip, '-C', dir], { windowsHide: true });
  else execFileSync('unzip', ['-q', '-o', zip, '-d', dir]);
}
