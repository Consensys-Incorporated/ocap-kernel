/**
 * Token symbol/name resolution via the MetaMask Token API.
 *
 * Resolves human-readable token identifiers (e.g. "USDC") to contract
 * addresses on a specific chain. Uses a single search request that returns
 * addresses, symbols, names, and decimals for all matching tokens.
 *
 * Testnets are not indexed — provide addresses directly for test networks.
 */

const TOKEN_API = 'https://token.api.cx.metamask.io';

const ETH_ADDRESS_RE = /^0x[\da-f]{40}$/iu;

/**
 * Parse a contract address from a CAIP-19 asset ID.
 *
 * @param assetId - e.g. "eip155:1/erc20:0xa0b8...".
 * @returns The lowercase contract address, or null if not parseable.
 */
function parseAddressFromAssetId(assetId: string): string | null {
  // Format: eip155:{chainId}/erc20:{address}
  const match = /\/erc20:(0x[\da-f]{40})/iu.exec(assetId);
  return match?.[1]?.toLowerCase() ?? null;
}

export type TokenMatch = {
  address: string;
  name: string;
  symbol: string;
  decimals?: number;
};

export type TokenResolution = {
  address: string;
  resolved: boolean;
  name?: string;
  symbol?: string;
  decimals?: number | undefined;
};

/**
 * Build the standard ambiguity error for multiple token matches.
 *
 * @param token - The user-supplied token query.
 * @param matches - The matching token records.
 * @returns The ambiguity error.
 */
function makeAmbiguousTokenError(token: string, matches: TokenMatch[]): Error {
  const list = matches
    .map((match) => `${match.name} (${match.symbol}): ${match.address}`)
    .join('\n  ');

  return new Error(
    `Multiple tokens match "${token}":\n  ${list}\n` +
      'Please specify the contract address.',
  );
}

/**
 * Resolve a token symbol or name to contract addresses via MetaMask Token API.
 *
 * @param options - Resolution options.
 * @param options.query - Token symbol or name (e.g. "USDC").
 * @param options.chainId - EVM chain ID to filter results.
 * @returns Matching tokens with addresses on the given chain.
 */
export async function resolveTokenBySymbol(options: {
  query: string;
  chainId: number;
}): Promise<TokenMatch[]> {
  const { query, chainId } = options;

  const searchUrl =
    `${TOKEN_API}/tokens/search?` +
    `query=${encodeURIComponent(query)}` +
    `&chains=${String(chainId)}` +
    '&limit=10';

  const res = await fetch(searchUrl);
  if (!res.ok) {
    throw new Error(
      `Token search failed (HTTP ${String(res.status)}). ` +
        'Try again or provide the contract address.',
    );
  }

  const data = (await res.json()) as {
    data?: {
      assetId: string;
      name: string;
      symbol: string;
      decimals: number;
    }[];
  };

  if (!Array.isArray(data.data) || data.data.length === 0) {
    return [];
  }

  // Deduplicate by address (API may return variants)
  const seen = new Set<string>();
  const results: TokenMatch[] = [];

  for (const token of data.data) {
    const address = parseAddressFromAssetId(token.assetId);
    if (!address || !ETH_ADDRESS_RE.test(address) || seen.has(address)) {
      continue;
    }
    seen.add(address);
    results.push({
      address,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
    });
  }

  return results;
}

/**
 * Resolve a token parameter that may be an address or a symbol/name.
 * Returns the address as-is if it already looks like one, otherwise
 * queries the MetaMask Token API.
 *
 * @param options - Resolution options.
 * @param options.token - Token address or symbol/name.
 * @param options.chainId - EVM chain ID.
 * @returns The resolved contract address and metadata.
 */
export async function resolveTokenParam(options: {
  token: string;
  chainId: number;
}): Promise<TokenResolution> {
  if (ETH_ADDRESS_RE.test(options.token)) {
    return { address: options.token, resolved: false };
  }

  const matches = await resolveTokenBySymbol({
    query: options.token,
    chainId: options.chainId,
  });

  const [firstMatch] = matches;
  if (firstMatch === undefined) {
    throw new Error(
      `No token found matching "${options.token}" on chain ${String(options.chainId)}. ` +
        'Please provide the contract address directly.',
    );
  }

  // If there's an exact symbol match, only auto-select when it is unique.
  const lowerQuery = options.token.toLowerCase();
  const exactMatches = matches.filter(
    (match) => match.symbol.toLowerCase() === lowerQuery,
  );
  if (exactMatches.length > 1) {
    throw makeAmbiguousTokenError(options.token, exactMatches);
  }

  const exactMatch = exactMatches[0];
  const best = exactMatch ?? firstMatch;

  // If multiple distinct tokens match and no exact symbol match, ask user
  if (!exactMatch && matches.length > 1) {
    throw makeAmbiguousTokenError(options.token, matches);
  }

  return {
    address: best.address,
    resolved: true,
    name: best.name,
    symbol: best.symbol,
    decimals: best.decimals,
  };
}
