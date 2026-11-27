// Which Curator Home does this process use? One answer for the hook, the saver and the binder.
//
// Default: ~/.curator/game-curator (unchanged for normal users). To use another home (a scratch home for testing, or a user-chosen location) the
// CURATOR_HOME environment variable names its absolute directory. Claude Code applies the `env` setting of a settings file to Bash commands and to
// hook commands alike, so setting it there (for example the project's .claude/settings.local.json) reaches the hook and the saver without anyone
// having to repeat a path on every command; an `export` inside one shell command would not reach a hook.
//
// A selected home is never silently replaced by the default: if CURATOR_HOME is set and the directory is missing, is not a directory, is not
// absolute, or holds no regular settings.json of its own, resolution THROWS. Nothing here reads a path from a page, an envelope or a tool result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class CuratorHomeError extends Error {}

export function resolveCuratorHome({env = process.env, homedir = os.homedir()} = {}) {
  const selected = env.CURATOR_HOME;
  if (selected === undefined) {
    const home = path.join(homedir, '.curator/game-curator');
    return {source: 'default', home, settings: path.join(home, 'settings.json'), cache: path.join(home, 'cache/steam')};
  }
  const bad = why => new CuratorHomeError(`CURATOR_HOME is set but unusable (${why}); refusing to fall back to the default Curator Home. Fix or unset CURATOR_HOME.`);
  if (typeof selected !== 'string' || selected === '' || selected.includes('\0') || !path.isAbsolute(selected)) throw bad('it must be a non-empty absolute path');
  let real;
  try { real = fs.realpathSync(selected); if (!fs.statSync(real).isDirectory()) throw new Error('not a directory'); } catch { throw bad('the directory does not exist or is not a directory'); }
  const settings = path.join(real, 'settings.json');
  let st; try { st = fs.lstatSync(settings); } catch { throw bad('it has no settings.json, so no consent is recorded for it'); }
  if (!st.isFile() || st.isSymbolicLink()) throw bad('settings.json is not a regular file');
  return {source: 'env', home: real, settings, cache: path.join(real, 'cache/steam')};
}

// For explicit --dest/--settings arguments: while a custom home is selected they may only name that home's own paths.
export function assertWithinSelectedHome(selected, {dest, settings} = {}) {
  if (selected.source !== 'env') return;
  const real = p => { let q = path.resolve(p); const tail = []; while (!fs.existsSync(q)) { tail.unshift(path.basename(q)); q = path.dirname(q); } return path.join(fs.realpathSync(q), ...tail); };
  if (dest !== undefined && real(dest) !== real(selected.cache)) throw new CuratorHomeError('CURATOR_HOME selects a custom Curator Home: --dest must be omitted or be that home\'s own cache/steam directory');
  if (settings !== undefined && real(settings) !== real(selected.settings)) throw new CuratorHomeError('CURATOR_HOME selects a custom Curator Home: --settings must be omitted or be that home\'s own settings.json');
}
