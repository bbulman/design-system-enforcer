/**
 * The catalog search every finder ranks with. A project that already has its
 * own (Workshopr's scripts/ds-search.mjs, shared with ds:find) names it in
 * config searchModule; everyone else gets the bundled search.mjs, which reads
 * the catalog and synonyms the config names.
 */
import { pathToFileURL } from 'url';
import { config, projectPath } from './config.js';

let current = null, currentPath = null;

export async function loadSearch() {
  const target = config.searchModule ? projectPath(config.searchModule) : new URL('./search.mjs', import.meta.url).pathname;
  if (target !== currentPath) {
    current = await import(pathToFileURL(target).href);
    currentPath = target;
  }
  return current;
}

/** The loaded search module. Call loadSearch() first; it is a no-op once loaded. */
export const search = new Proxy({}, {
  get(_, key) {
    if (!current) throw new Error('catalog search not loaded');
    return current[key];
  },
});

await loadSearch();
