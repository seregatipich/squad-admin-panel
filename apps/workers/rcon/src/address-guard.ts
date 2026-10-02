import { type HostCidr, isPrivateHostAllowed, isRestrictedNetworkHost } from '@squad/shared-types';

/** Why a resolved address set must not be dialled. */
export type AddressRefusal = 'restricted' | 'private_outside_allowlist';

/**
 * Judges the addresses a hostname resolved to, for an operator-supplied
 * (external) server. A name is only as safe as what it resolves to (#96): a
 * public hostname whose record points at 127.0.0.1 passes the string checks
 * of `externalRconHost` and would aim the panel's sockets at the panel host.
 * One bad address among several refuses the whole set, because a client may
 * try any of them.
 *
 * @param addresses - every address the resolver returned for the host
 * @param privateHostAllowlist - private LAN ranges the operator allowed, or `null` for no restriction
 * @returns the reason to refuse, or `null` when every address may be dialled
 */
export function refuseResolvedAddresses(
  addresses: readonly string[],
  privateHostAllowlist: readonly HostCidr[] | null,
): AddressRefusal | null {
  if (addresses.length === 0) return 'restricted';
  if (addresses.some((address) => isRestrictedNetworkHost(address))) return 'restricted';
  if (addresses.some((address) => !isPrivateHostAllowed(address, privateHostAllowlist))) {
    return 'private_outside_allowlist';
  }
  return null;
}
