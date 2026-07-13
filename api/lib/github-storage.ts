const DEFAULT_OWNER = 'dicoge';
const DEFAULT_REPO = 'hunterCard';
const DEFAULT_BRANCH = 'main';

export type JsonValue = Record<string, unknown> | unknown[];

type GitHubContentResponse = {
  content?: string;
  sha?: string;
};

function env(name: string): string | undefined {
  return process.env[name];
}

function getRepoConfig() {
  return {
    owner: env('GITHUB_OWNER') || DEFAULT_OWNER,
    repo: env('GITHUB_REPO') || DEFAULT_REPO,
    branch: env('GITHUB_BRANCH') || DEFAULT_BRANCH,
    token: env('GITHUB_TOKEN') || env('GH_TOKEN'),
  };
}

function encodeContent(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

function decodeContent(content: string): string {
  return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
}

async function githubFetch(pathname: string, init: RequestInit = {}) {
  const { token } = getRepoConfig();
  if (!token) {
    throw new Error('Missing GITHUB_TOKEN');
  }

  const res = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'hunterCard-push-api',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`GitHub API ${res.status}: ${text}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  return res;
}

export async function readJsonFile<T extends JsonValue>(filePath: string, fallback: T): Promise<T> {
  const { owner, repo, branch } = getRepoConfig();
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');

  try {
    const res = await githubFetch(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`);
    const data = await res.json() as GitHubContentResponse;
    if (!data.content) return fallback;
    return JSON.parse(decodeContent(data.content)) as T;
  } catch (err: any) {
    if (err?.status === 404) return fallback;
    throw err;
  }
}

export async function writeJsonFile(filePath: string, content: JsonValue, message: string): Promise<void> {
  const { owner, repo, branch } = getRepoConfig();
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  let sha: string | undefined;

  try {
    const current = await githubFetch(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`);
    const data = await current.json() as GitHubContentResponse;
    sha = data.sha;
  } catch (err: any) {
    if (err?.status !== 404) throw err;
  }

  await githubFetch(`/repos/${owner}/${repo}/contents/${encodedPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: encodeContent(`${JSON.stringify(content, null, 2)}\n`),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
}
