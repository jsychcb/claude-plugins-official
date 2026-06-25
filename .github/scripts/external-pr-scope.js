'use strict';
// Shared logic for the external-PR allowlist (keyed on source org, not on individuals).
//
// A pull request opened by a non-member is "in scope" only if it ADDS plugin entries to
// .claude-plugin/marketplace.json whose source.url is under an allowlisted prefix
// (.github/external-pr-allowed-sources.json) and changes nothing else — no other files,
// no removals, no edits to existing entries.
//
// Used by:
//   - close-external-prs.yml      (skip the auto-close when in scope)
//   - external-pr-scope-guard.yml (required status check: fail a non-member PR that is out of scope)
//
// Security: evaluate() reads the head marketplace.json as DATA via the API and parses it;
// it never checks out or executes head code. The allowlist + this script are read from the
// trusted base checkout.

const fs = require('fs');
const MARKETPLACE = '.claude-plugin/marketplace.json';

function normalizeUrl(u) {
  return String(u).trim().toLowerCase()
    .replace(/^git\+/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');   // no trailing slash; matching adds the boundary
}

function loadAllowed(allowlistPath) {
  const j = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  return (j.allowed_sources || []).map(normalizeUrl);
}

function pluginsByName(json) {
  const map = {};
  for (const p of (json && json.plugins) || []) { if (p && p.name) map[p.name] = p; }
  return map;
}

function sourceAllowed(url, allowed) {
  const n = normalizeUrl(url);
  if (n.split('/').length < 3) return false;          // require a real host/org/repo path
  // Boundary-safe: exact repo, or strictly under the allowed prefix.
  return allowed.some(a => n === a || n.startsWith(a + '/'));
}

// Pure decision over an already-computed diff. Returns { ok, problems, added, removed, modified }.
function analyze({ changedFiles, base, head, allowed }) {
  const problems = [];

  const off = changedFiles.filter(n => n !== MARKETPLACE);
  if (off.length) problems.push(`changes files other than ${MARKETPLACE}: ${off.join(', ')}`);

  const baseNames = new Set(Object.keys(base));
  const headNames = new Set(Object.keys(head));
  const removed = [...baseNames].filter(n => !headNames.has(n));
  const added = [...headNames].filter(n => !baseNames.has(n));
  const modified = [...headNames].filter(
    n => baseNames.has(n) && JSON.stringify(base[n]) !== JSON.stringify(head[n])
  );

  if (removed.length)  problems.push(`removes existing entr${removed.length > 1 ? 'ies' : 'y'}: ${removed.join(', ')}`);
  if (modified.length) problems.push(`modifies existing entr${modified.length > 1 ? 'ies' : 'y'}: ${modified.join(', ')}`);
  if (!off.length && !added.length && !removed.length && !modified.length) {
    problems.push('makes no in-scope change (expected additions to marketplace.json)');
  }

  for (const name of added) {
    const url = head[name] && head[name].source && head[name].source.url;
    if (!url) { problems.push(`added "${name}" has no source.url to validate`); continue; }
    if (!sourceAllowed(url, allowed)) {
      problems.push(`added "${name}" points at ${url}, outside the allowed sources`);
    }
  }

  return { ok: problems.length === 0, problems, added, removed, modified };
}

async function readPlugins(github, owner, repo, ref) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, ref, path: MARKETPLACE });
    return pluginsByName(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')));
  } catch (e) {
    return null;
  }
}

// API wrapper used by both workflows. Fetches the diff and delegates to analyze().
async function evaluate({ github, context, allowlistPath }) {
  const pr = context.payload.pull_request;
  const owner = context.repo.owner, repo = context.repo.repo;

  const allowed = loadAllowed(allowlistPath);
  if (!allowed.length) return { ok: false, problems: ['allowed_sources is empty'], added: [], removed: [], modified: [] };

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner, repo, pull_number: pr.number, per_page: 100,
  });
  const changedFiles = files.map(f => f.filename);

  const base = await readPlugins(github, owner, repo, pr.base.sha);
  const head = await readPlugins(github, pr.head.repo.owner.login, pr.head.repo.name, pr.head.sha);
  if (base === null || head === null) {
    return { ok: false, problems: ['could not read marketplace.json at base and/or head'], added: [], removed: [], modified: [] };
  }

  return analyze({ changedFiles, base, head, allowed });
}

module.exports = { normalizeUrl, sourceAllowed, analyze, readPlugins, evaluate, MARKETPLACE };
