import net from "node:net";

/** Network address validation for agent-initiated downloads. A DNS name that
 * resolves to a private, reserved or translated address must never reach the
 * dial, so the checks here run inside the connect-time lookup rather than in a
 * separate pre-flight resolution that DNS rebinding could bypass. */

export type LookupEntry = { address: string; family: number };
export type LookupCallback = (error: NodeJS.ErrnoException | null, address?: string | LookupEntry[], family?: number) => void;

export function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) {
    const value = parseIpv6(address);
    if (value === undefined) return true;
    // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) addresses carry an
    // IPv4 target in their low 32 bits; Linux dials those as plain IPv4, so
    // they must be judged as IPv4 rather than by their IPv6 prefixes. The
    // prefix occupies the top 96 bits: trailing ffff for mapped, a shifted
    // 64:ff9b for NAT64.
    const prefix96 = value >> 32n;
    if (prefix96 === 0xffffn || prefix96 === (0x64ff9bn << 64n)) {
      return isPrivateIpv4(ipv4String(value & 0xffffffffn));
    }
    return ipv6SpecialRanges.some(([start, end]) => value >= start && value <= end);
  }
  return true;
}

export function parseIpv6(input: string): bigint | undefined {
  const text = input.trim().toLowerCase();
  if (!text.includes(":")) return undefined;
  // An IPv4 tail (as in ::ffff:10.0.0.1 or 64:ff9b::192.0.2.1) becomes two
  // groups; any "::" compression then expands to the remaining zero groups.
  let body = text;
  const tailGroups: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".");
    if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return undefined;
    const [a, b, c, d] = octets.map(Number);
    tailGroups.push((a << 8) | b, (c << 8) | d);
    body = text.slice(0, lastColon);
  }
  const doubleIndex = body.indexOf("::");
  const hasDouble = doubleIndex !== -1;
  if (hasDouble && body.indexOf("::", doubleIndex + 1) !== -1) return undefined;
  const left = hasDouble ? body.slice(0, doubleIndex).split(":").filter(Boolean) : body.split(":");
  const right = hasDouble ? body.slice(doubleIndex + 2).split(":").filter(Boolean) : [];
  if (!hasDouble) {
    if (left.some((group) => !group) || left.length + tailGroups.length !== 8) return undefined;
  } else if (left.length + right.length + tailGroups.length > 7) {
    return undefined;
  }
  const groups = [...left, ...(hasDouble ? Array(8 - left.length - right.length - tailGroups.length).fill("0") : []), ...right];
  let value = 0n;
  for (const group of [...groups, ...tailGroups.map((entry) => entry.toString(16))]) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function ipv4String(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join(".");
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function ipv6Range(base: string, prefixBits: number): [bigint, bigint] {
  const hostBits = BigInt(128 - prefixBits);
  const start = parseIpv6(base)! & -(1n << hostBits);
  return [start, start | ((1n << hostBits) - 1n)];
}

// IANA IPv6 special-purpose registry entries that must never be dialed: ::/96
// (unspecified/loopback/IPv4-translated), discard, benchmarking, documentation,
// ORCHID, Teredo, 6to4, SRv6, ULA, link-local and multicast. NAT64's
// well-known prefix is handled above by inspecting its embedded IPv4.
const ipv6SpecialRanges: ReadonlyArray<readonly [bigint, bigint]> = [
  ipv6Range("::", 96),
  ipv6Range("64:ff9b:1::", 48),
  ipv6Range("100::", 64),
  ipv6Range("2001::", 32),
  ipv6Range("2001:2::", 48),
  ipv6Range("2001:10::", 28),
  ipv6Range("2001:20::", 28),
  ipv6Range("2001:db8::", 32),
  ipv6Range("2002::", 16),
  ipv6Range("3fff::", 20),
  ipv6Range("5f00::", 16),
  ipv6Range("fc00::", 7),
  ipv6Range("fe80::", 10),
  ipv6Range("ff00::", 8),
];

/** Wrap a DNS resolver in a net.connect-compatible lookup that rejects names
 * resolving to private or reserved addresses and returns only validated
 * entries, pinning the dial to the addresses that were checked. */
export function makeValidatingLookup(
  resolve: (hostname: string, family: number) => Promise<LookupEntry[]>,
) {
  return (hostname: string, options: { family?: number; all?: boolean } | LookupCallback, callback?: LookupCallback): void => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const done = callback as LookupCallback;
    resolve(hostname, options?.family ?? 0).then((entries) => {
      if (!entries.length) {
        done(Object.assign(new Error("Asset hostname did not resolve"), { code: "ENOTFOUND" }));
        return;
      }
      for (const { address } of entries) {
        if (isPrivateAddress(address)) {
          done(Object.assign(new Error(`Private/reserved network address is blocked (${address})`), { code: "EACCES" }));
          return;
        }
      }
      if (options?.all) done(null, entries);
      else done(null, entries[0].address, entries[0].family);
    }, (error: NodeJS.ErrnoException) => done(error));
  };
}
