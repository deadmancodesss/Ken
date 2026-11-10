/**
 * Addresses this build can name without asking anyone, because the build itself used
 * them. They are public chain addresses, not secrets.
 *
 * The testnet faucet address was read from the faucet's own challenge on 2026-11-04
 * (GET /v3/challenge) and matched a transfer in the testnet history this build reads.
 * A faucet can rotate its sending address, so a miss falls back to the raw address
 * rather than to a guess about what the address is.
 */
const FAUCETS = new Map<string, string>([
  ["0x059e21c19f9a8233f4fcbc11fba713c022dcf9d3632961b7ac7836a9ffa8d94f", "Sui testnet faucet"],
]);

export function faucetLabel(address: string): string | null {
  return FAUCETS.get(address.toLowerCase()) ?? null;
}

export function isFaucet(address: string): boolean {
  return FAUCETS.has(address.toLowerCase());
}
