# Poki Runner icon

The Poki app keeps the main logo (`../poki-icon.png`). The runner bundle (the XCTest
host that drives other apps) uses this variant: the same bear peeking in from the
bottom on the same blue (#2084FD), plus a big white play triangle in the top-right corner (no box)
that marks it as the runner.

- `play-badge.svg`: the triangle overlay, composited onto `../poki-icon.png` with sharp.
- `AppIcon-*.png`: full-bleed renders for the Xcode AppIcon set (1024, 180, 167, 152, 120).
- `poki-runner-icon-*.png`: masked previews.

Re-render with sharp: `sharp(svg,{density:600}).resize(n,n).flatten({background:'#2084FD'})`.
