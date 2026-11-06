# Proxy modules: the 10.7.0.1 loopback

Poki on the phone talks to the phone's own developer services (lockdown on 62078, RemotePairing on
49152) at 10.7.0.1. Something on the phone has to send connections to 10.7.0.1 straight back to the
phone. iOS allows only one VPN at a time, so instead of Poki taking that slot, the proxy app the user
already runs does it. Keep the address at 10.7.0.1: Shadowrocket hard-codes it, and SideStore-style
tools use the same one.

The reflect swaps the addresses only, not the ports: a connection to 10.7.0.1:49152 arrives at the
phone's own port 49152. Each setup below also keeps IPv6 off on the proxy's tunnel interface,
because tools that look for this loopback skip a tunnel interface that has an IPv6 address. Poki
Probe (`native/ios-runner/PokiProbe`) shows whether the loopback works: the 10.7.0.x interface,
whether it has IPv6, and a TCP connect to 10.7.0.1 on both ports.

## Surge (iOS 5.23.0 or later)

Install [`poki-loopback.sgmodule`](poki-loopback.sgmodule) as a module and enable it. Enhanced Mode
must be on: `[IP Rewrite]` only applies to traffic in Surge's VIF, so reflect does nothing in plain
proxy mode. The module turns off `ipv6-vif` and adds 10.7.0.1/32 to `tun-included-routes`, so the
address reaches the VIF even if it falls in an excluded or local range.
Reference: [Surge manual, IP Rewrite](https://manual.nssurge.com/features/ip-rewrite.html).

## Loon (3.5.3, build 1007, or later)

Import [`poki-loopback.lpx`](poki-loopback.lpx) as a plugin and enable it. `include-tun` sends
10.7.0.1 into Loon's TUN, and `[IP Rewrite]` reflects it. The IP Rewrite line has to come from a
plugin, not the main configuration. The plugin's `loon_version` stops older Loon from accepting it
without supporting it. Reference: [Loon include-tun](https://nsloon.app/docs/General/#include-tun).

## sing-box (1.12.0 or later)

Add `"loopback_address": ["10.7.0.1"]` to the existing `tun` inbound. The `"type": "tun"` inbound
in [`sing-box-loopback.json`](sing-box-loopback.json) shows where it goes; merge that key into your
own inbound rather than replacing it. Leave IPv6 out of the tun `address` list. sing-box's loopback
handles TCP only, which is all Poki needs. Reference:
[sing-box tun inbound](https://sing-box.sagernet.org/configuration/inbound/tun/).

## Shadowrocket

No file is needed: turn on Settings > Other > "Include route 10.7.0.1/32". (Taken from the app's
settings as reported to us; not checked against Shadowrocket documentation.)
