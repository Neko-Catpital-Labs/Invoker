import { spawnSync } from 'node:child_process';
import {
  readInvokerConfigFile,
  updateInvokerConfigFile,
  type InvokerConfigRecord,
} from '@invoker/contracts';

export const AUTO_APPROVE_AUTHORS_CONFIG_KEY = 'autoApproveAuthors';

export type AutoApproveAuthorsSnapshot = {
  authors: string[];
  allowlistOk: boolean;
  reason?: 'missing' | 'empty' | 'unreadable';
};

export type GithubLoginLookup = () => Promise<string | null>;

function normalizeAutoApproveAuthors(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  const authors: string[] = [];
  for (const raw of logins) {
    const login = raw.trim();
    if (!login) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push(login);
  }
  return authors;
}

function authorsFromConfigValue(value: unknown): AutoApproveAuthorsSnapshot {
  if (value === undefined) return { authors: [], allowlistOk: false, reason: 'missing' };
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return { authors: [], allowlistOk: false, reason: 'unreadable' };
  }
  const authors = normalizeAutoApproveAuthors(value);
  if (authors.length === 0) return { authors: [], allowlistOk: false, reason: 'empty' };
  return { authors, allowlistOk: true };
}

export function readAutoApproveAuthors(config: InvokerConfigRecord): AutoApproveAuthorsSnapshot {
  return authorsFromConfigValue(config[AUTO_APPROVE_AUTHORS_CONFIG_KEY]);
}

export function writeAutoApproveAuthors(
  config: InvokerConfigRecord,
  authors: readonly string[],
): string[] {
  const next = normalizeAutoApproveAuthors(authors);
  config[AUTO_APPROVE_AUTHORS_CONFIG_KEY] = next;
  return next;
}

export function addAutoApproveAuthor(
  config: InvokerConfigRecord,
  login: string,
): string[] {
  const current = readAutoApproveAuthors(config).authors;
  return writeAutoApproveAuthors(config, [...current, login]);
}

export function lookupCurrentGithubLoginWithGh(): string | null {
  const result = spawnSync('gh', ['api', 'user', '--jq', '.login'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const login = (result.stdout ?? '').trim();
  return login.length > 0 ? login : null;
}

export async function applyAutoApproveAuthorsAction(options: {
  configPath: string;
  action: 'get' | 'set' | 'add' | 'add_current_github_user' | 'clear';
  authors?: string[];
  login?: string;
  lookupGithubLogin?: GithubLoginLookup;
}): Promise<AutoApproveAuthorsSnapshot> {
  const lookup = options.lookupGithubLogin ?? (async () => lookupCurrentGithubLoginWithGh());

  if (options.action === 'get') {
    return readAutoApproveAuthors(readInvokerConfigFile(options.configPath));
  }

  if (options.action === 'clear') {
    updateInvokerConfigFile(options.configPath, (config) => {
      writeAutoApproveAuthors(config, []);
    });
    return readAutoApproveAuthors(readInvokerConfigFile(options.configPath));
  }

  if (options.action === 'set') {
    if (!options.authors) {
      throw new Error('authors is required for set');
    }
    updateInvokerConfigFile(options.configPath, (config) => {
      writeAutoApproveAuthors(config, options.authors ?? []);
    });
    return readAutoApproveAuthors(readInvokerConfigFile(options.configPath));
  }

  if (options.action === 'add') {
    const login = options.login?.trim();
    if (!login) throw new Error('login is required for add');
    updateInvokerConfigFile(options.configPath, (config) => {
      addAutoApproveAuthor(config, login);
    });
    return readAutoApproveAuthors(readInvokerConfigFile(options.configPath));
  }

  const login = (await lookup())?.trim();
  if (!login) {
    throw new Error('Could not read the current GitHub login. Run `gh auth login`, then retry.');
  }
  updateInvokerConfigFile(options.configPath, (config) => {
    addAutoApproveAuthor(config, login);
  });
  return readAutoApproveAuthors(readInvokerConfigFile(options.configPath));
}

export async function runAutoApproveAuthorsCommand(
  args: string[],
  options: {
    configPath: string;
    lookupGithubLogin?: GithubLoginLookup;
    stdout?: (text: string) => void;
  },
): Promise<number> {
  const write = options.stdout ?? ((text: string) => {
    process.stdout.write(text);
  });
  let action: 'get' | 'set' | 'add' | 'add_current_github_user' | 'clear' = 'get';
  let json = false;
  const setAuthors: string[] = [];
  let addLogin: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--clear') {
      action = 'clear';
    } else if (arg === '--add-current-github-user') {
      action = 'add_current_github_user';
    } else if (arg === '--set') {
      action = 'set';
      while (args[i + 1] && !args[i + 1]!.startsWith('--')) {
        setAuthors.push(args[++i]!);
      }
    } else if (arg === '--add') {
      action = 'add';
      addLogin = args[++i];
      if (!addLogin) throw new Error('Missing value for --add');
    } else {
      throw new Error(`Unknown option for auto-approve-authors: "${arg}"`);
    }
  }

  const result = await applyAutoApproveAuthorsAction({
    configPath: options.configPath,
    action,
    authors: action === 'set' ? setAuthors : undefined,
    login: addLogin,
    lookupGithubLogin: options.lookupGithubLogin,
  });

  if (json) {
    write(`${JSON.stringify({ autoApproveAuthors: result.authors, allowlistOk: result.allowlistOk, reason: result.reason ?? null })}\n`);
  } else if (result.authors.length === 0) {
    write('autoApproveAuthors: (empty — auto-approve will not act on anyone)\n');
  } else {
    write(`autoApproveAuthors:\n${result.authors.map((login) => `  ${login}\n`).join('')}`);
  }
  return 0;
}
