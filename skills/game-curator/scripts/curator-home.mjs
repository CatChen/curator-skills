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
import {fileURLToPath} from 'node:url';

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

// For explicit --dest/--settings arguments: while a custom home is selected they may only name that home's own paths, and the cache directory may not
// resolve (through a symbolic link) to somewhere outside the home.
export function assertWithinSelectedHome(selected, {dest, settings} = {}) {
  if (selected.source !== 'env') return;
  const real = p => { let q = path.resolve(p); const tail = []; while (!fs.existsSync(q)) { tail.unshift(path.basename(q)); q = path.dirname(q); } return path.join(fs.realpathSync(q), ...tail); };
  const homeReal = real(selected.home), cacheReal = real(selected.cache);
  if (cacheReal !== homeReal && !cacheReal.startsWith(homeReal + path.sep)) throw new CuratorHomeError('the selected Curator Home\'s cache directory resolves outside that home (a symbolic link); refusing to use it');
  if (dest !== undefined && real(dest) !== cacheReal) throw new CuratorHomeError('CURATOR_HOME selects a custom Curator Home: --dest must be omitted or be that home\'s own cache/steam directory');
  if (settings !== undefined && real(settings) !== real(selected.settings)) throw new CuratorHomeError('CURATOR_HOME selects a custom Curator Home: --settings must be omitted or be that home\'s own settings.json');
}

// The shared authorization entry points (checkCacheAuthorized, the binder's plans, the hook, staged-file reading) call this FIRST, so the selected-home
// boundary holds for direct API callers as well as for the command-line wrappers. With no CURATOR_HOME it only validates nothing and changes nothing.
export function guardSelectedHome(paths = {}, {env = process.env, homedir} = {}) {
  const selected = resolveCuratorHome({env, ...(homedir ? {homedir} : {})}); // throws CuratorHomeError when a selected home is unusable
  assertWithinSelectedHome(selected, paths);
  return selected;
}

// One explicit discovery step for the whole persistence workflow (profile, feedback, settings and cache): prints the Curator Home this environment selects.
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const s = resolveCuratorHome(); console.log(JSON.stringify({source: s.source === 'env' ? 'CURATOR_HOME' : 'default', home: s.home, settings: s.settings, cache: s.cache}, null, 2)); }
  catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
