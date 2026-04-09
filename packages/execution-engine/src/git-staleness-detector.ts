export interface StalenessCheck {
  localCommit: string;
  remoteCommit: string;
  commitsBehind: number;
  isStale: boolean;
  warning?: string;
}

/**
 * Check if local ref is behind remote ref.
 * Returns staleness info including commits behind count.
 *
 * @param repoPath - Absolute path to the git repository
 * @param localRef - Local branch/ref name (e.g., "master", "HEAD")
 * @param remoteRef - Remote ref name (e.g., "origin/master")
 * @param execGit - Git execution function that takes args array and cwd
 * @returns Promise resolving to staleness check result
 *
 * @example
 * ```typescript
 * const result = await checkStaleness(
 *   "/path/to/repo",
 *   "master",
 *   "origin/master",
 *   execGit
 * );
 * if (result.isStale) {
 *   console.log(`Branch is ${result.commitsBehind} commits behind`);
 * }
 * ```
 */
export async function checkStaleness(
  repoPath: string,
  localRef: string,
  remoteRef: string,
  execGit: (args: string[], cwd: string) => Promise<string>
): Promise<StalenessCheck> {
  try {
    // Get local commit SHA
    const localCommit = (
      await execGit(["rev-parse", localRef], repoPath)
    ).trim();

    // Get remote commit SHA
    const remoteCommit = (
      await execGit(["rev-parse", remoteRef], repoPath)
    ).trim();

    // If commits are the same, not stale
    if (localCommit === remoteCommit) {
      return {
        localCommit,
        remoteCommit,
        commitsBehind: 0,
        isStale: false,
      };
    }

    // Count commits behind using rev-list
    // Format: localRef..remoteRef shows commits in remote that aren't in local
    const countOutput = await execGit(
      ["rev-list", "--count", `${localRef}..${remoteRef}`],
      repoPath
    );
    const commitsBehind = parseInt(countOutput.trim(), 10);

    return {
      localCommit,
      remoteCommit,
      commitsBehind,
      isStale: commitsBehind > 0,
    };
  } catch (error) {
    // Handle missing refs or other git errors
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    // Try to get whatever commit SHAs we can for debugging
    let localCommit = "";
    let remoteCommit = "";

    try {
      localCommit = (await execGit(["rev-parse", localRef], repoPath)).trim();
    } catch {
      // Local ref doesn't exist
    }

    try {
      remoteCommit = (
        await execGit(["rev-parse", remoteRef], repoPath)
      ).trim();
    } catch {
      // Remote ref doesn't exist
    }

    return {
      localCommit,
      remoteCommit,
      commitsBehind: 0,
      isStale: false,
      warning: `Failed to check staleness: ${errorMessage}`,
    };
  }
}
