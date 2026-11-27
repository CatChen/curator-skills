// A per-run, salted fingerprint of the observed page path. The raw path stays in page scope.
// It detects navigation between pages; it is not account-session identity evidence.
export function pagePathFingerprint(input) {
  if (!input || !Array.isArray(input.salt) || input.salt.length !== 16 || !input.salt.every(x=>Number.isInteger(x) && x>=0 && x<=255)) return null;
  if (!['https://store.steampowered.com','https://steamcommunity.com'].includes(location.origin)) return null;
  const text = 'curator/page-path/v1\0' + location.origin + location.pathname;
  if (!/^[\x00-\x7f]*$/.test(text)) return null;
  const bytes = input.salt.concat([...text].map(c=>c.charCodeAt(0)));

  return sha256(bytes);
}
