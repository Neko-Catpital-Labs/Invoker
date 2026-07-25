export interface PrRepairIdentity {
  repo: string;
  prNumber: number;
}

export function resolvePrRepairIdentity(reviewUrl: string, reviewId: string): PrRepairIdentity | undefined {
  const fromUrl = resolvePrRepairIdentityFromUrl(reviewUrl);
  if (fromUrl) return fromUrl;
  return resolvePrRepairIdentityFromId(reviewId);
}

function resolvePrRepairIdentityFromUrl(reviewUrl: string): PrRepairIdentity | undefined {
  try {
    const url = new URL(reviewUrl);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!match) return undefined;
    return { repo: `${match[1]}/${match[2]}`, prNumber: Number(match[3]) };
  } catch {
    return undefined;
  }
}

function resolvePrRepairIdentityFromId(reviewId: string): PrRepairIdentity | undefined {
  const match = reviewId.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (!match) return undefined;
  return { repo: match[1], prNumber: Number(match[2]) };
}
