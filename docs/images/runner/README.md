# Poki Runner icon

The Poki app keeps the main logo (`../poki-icon.png`). The runner bundle (the XCTest
host that drives other apps) uses this variant: the same bear peeking in from the
bottom on the same blue (#2084FD), plus a white play badge in the top-right corner
that marks it as the runner.

- `poki-runner-icon.svg`: source, squircle-masked, for docs and previews.
- `poki-runner-icon-fullbleed.svg`: same art without the mask; iOS applies its own.
- `AppIcon-*.png`: full-bleed renders for the Xcode AppIcon set (1024, 180, 167, 152, 120).
- `poki-runner-icon-*.png`: masked previews.

Re-render with sharp: `sharp(svg,{density:600}).resize(n,n).flatten({background:'#2084FD'})`.
