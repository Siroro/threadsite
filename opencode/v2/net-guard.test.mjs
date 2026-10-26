import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress, makeValidatingLookup, parseIpv6 } from "../lib/net-guard.ts";

test("IPv4-mapped, NAT64 and translated IPv6 forms are judged by their embedded IPv4", () => {
  for (const address of [
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1",
    "::ffff:192.168.1.1", "::ffff:169.254.1.1", "::ffff:0.0.0.0", "::ffff:224.0.0.1",
    "64:ff9b:10.0.0.1", "64:ff9b::a00:1", "64:ff9b::7f00:1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["::ffff:93.184.216.34", "64:ff9b::5db8:d822", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("reserved IPv6 ranges and IPv4 private ranges are blocked", () => {
  for (const address of [
    "::", "::1", "::2", "::10.0.0.1", "100::", "2001::1", "2001:2::1", "2001:10::1", "2001:20::1",
    "2001:db8::1", "2002:0a00:1::1", "3fff::1", "5f00::1", "64:ff9b:1::1", "fc00::1", "fd12:3456::1",
    "fe80::1", "febf::1", "ff02::1",
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.2.1", "192.168.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111", "2a00:1450:4001::1"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
  // Malformed input is never treated as a usable address.
  for (const address of ["", "example.com", "10.0.0.256", "::1::2", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:1.2.3.4"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
});

test("the IPv6 parser expands compression and dotted tails exactly", () => {
  assert.equal(parseIpv6("::"), 0n);
  assert.equal(parseIpv6("::1"), 1n);
  assert.equal(parseIpv6("::ffff:1.2.3.4"), 0xffff01020304n);
  assert.equal(parseIpv6("64:ff9b::a00:1"), (0x64ff9bn << 96n) | 0xa000001n);
  assert.equal(parseIpv6("1:2:3:4:5:6:7:8"), 0x00010002000300040005000600070008n);
  assert.equal(parseIpv6("1::2"), (1n << 112n) | 2n);
  assert.equal(parseIpv6(":::1"), undefined);
  assert.equal(parseIpv6("1.2.3.4"), undefined);
  assert.equal(parseIpv6("1:2:3:4:5:6:7:8:9"), undefined);
});

test("the validating lookup rejects mixed records and pins the dial to checked addresses", async () => {
  const blocked = makeValidatingLookup(async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "::ffff:10.0.0.5", family: 6 },
  ]);
  const failure = await new Promise((resolve) => blocked("rebind.example", { all: true }, (error) => resolve(error)));
  assert.match(failure.message, /Private\/reserved network address is blocked \(::ffff:10\.0\.0\.5\)/);

  const empty = makeValidatingLookup(async () => []);
  const unresolved = await new Promise((resolve) => empty("missing.example", {}, (error) => resolve(error)));
  assert.match(unresolved.message, /did not resolve/);

  const pinned = makeValidatingLookup(async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:4700::1111", family: 6 },
  ]);
  const single = await new Promise((resolve) => pinned("ok.example", {}, (error, address, family) => resolve({ error, address, family })));
  assert.deepEqual(single, { error: null, address: "93.184.216.34", family: 4 });
  const every = await new Promise((resolve) => pinned("ok.example", { all: true }, (error, list) => resolve({ error, list })));
  assert.deepEqual(every, { error: null, list: [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }] });
});
