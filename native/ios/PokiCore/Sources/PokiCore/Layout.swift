import Foundation

/// Where things are on one read of the screen: what lies on top of an element, the point a tap on it
/// can reach, and the part of a scrolling list a swipe should start in. Facts from the frames only.
struct Layout {
    let all: [Element]
    let screen: Rect

    init(all: [Element], screen: ScreenSize) {
        self.all = all
        self.screen = Rect(x: 0, y: 0, width: screen.width, height: screen.height)
    }

    /// Bars sit on top of the content wherever they are in the tree.
    static let bars: Set<String> = ["NavigationBar", "TabBar", "Toolbar", "Keyboard", "StatusBar"]
    static let scrollers: Set<String> = ["ScrollView", "Table", "CollectionView", "WebView"]

    /// The elements drawn over `target`: bars, and elements later in the tree that are neither inside
    /// it nor around it and that are not big containers (half the screen or more holds things, it
    /// does not cover them).
    ///
    /// Not covers: a bar or a textless frame that wholly encloses the target (the control sits in it:
    /// a Send button in an input bar or a keyboard, listed apart from it), and a textless frame with
    /// nothing listed inside it (a transparent host view).
    func covers(_ target: Element) -> [Element] {
        all.filter { c in
            guard c.node != target.node, !c.contains(target), !target.contains(c), c.frame.intersects(target.frame) else { return false }
            let encloses = c.frame.x <= target.frame.x + 0.5 && c.frame.y <= target.frame.y + 0.5 && c.frame.maxX >= target.frame.maxX - 0.5 && c.frame.maxY >= target.frame.maxY - 0.5
            if encloses && (Self.bars.contains(c.type) || c.text.isEmpty) { return false }
            if c.text.isEmpty && !all.contains(where: { c.contains($0) && !$0.text.isEmpty }) { return false }
            if Self.bars.contains(c.type) { return true }
            guard c.node > target.end, !Self.scrollers.contains(c.type) else { return false }
            return c.frame.area < 0.5 * screen.area
        }
    }

    /// A point inside `target` that is on screen and not under anything: its centre when that is free,
    /// otherwise the free point nearest to it. Nil when no part of it can be reached.
    func hitPoint(_ target: Element) -> (x: Double, y: Double)? {
        let visible = target.frame.intersection(screen)
        guard visible.width >= 2, visible.height >= 2 else { return nil }
        let over = covers(target).map(\.frame)
        func free(_ p: (x: Double, y: Double)) -> Bool { !over.contains { $0.contains(p) } }
        let centre = target.frame.centre
        if visible.contains(centre), free(centre) { return centre }
        var best: (point: (x: Double, y: Double), distance: Double)?
        let steps = 9
        for i in 0..<steps {
            for j in 0..<steps {
                let p = (x: visible.x + visible.width * (Double(i) + 0.5) / Double(steps), y: visible.y + visible.height * (Double(j) + 0.5) / Double(steps))
                guard free(p) else { continue }
                let d = hypot(p.x - centre.x, p.y - centre.y)
                if best == nil || d < best!.distance { best = (p, d) }
            }
        }
        return best?.point
    }

    /// Why `hitPoint` found nothing, in words.
    func unreachable(_ target: Element) -> String {
        let visible = target.frame.intersection(screen)
        if visible.width < 2 || visible.height < 2 {
            return "its frame \(target.frame.described) is off the screen (\(Int(screen.width))x\(Int(screen.height)) points)"
        }
        let names = covers(target).prefix(2).map { "\($0.type)\($0.text.isEmpty ? "" : " \"\($0.text.prefix(30))\"") \($0.frame.described)" }
        return "its visible part is covered by \(names.joined(separator: " and "))"
    }

    /// The biggest scrolling container on screen, or the one named.
    func scroller(_ named: Element?) -> Element? {
        if let named { return named }
        return all.filter { Self.scrollers.contains($0.type) }.max { $0.frame.intersection(screen).area < $1.frame.intersection(screen).area }
    }

    /// The part of the list a swipe should start and end in: the list's frame on screen, less the bars
    /// and anything spanning most of its width that is drawn over it (a reply bar, a tab bar), less the
    /// screen edges where swipes are the system's (Home, Notification Centre).
    func swipeArea(_ named: Element?) -> Rect {
        let list = scroller(named)
        var area = (list?.frame ?? screen).intersection(screen)
        if area.height < 80 || area.width < 80 { area = screen }
        let over = list.map(covers) ?? all.filter { Self.bars.contains($0.type) }
        for c in over.map(\.frame) where c.width >= 0.5 * area.width {
            if c.centre.y > area.centre.y {
                area.height = max(0, min(area.maxY, c.y) - area.y)
            } else {
                let top = min(area.maxY, max(area.y, c.maxY))
                area.height = area.maxY - top
                area.y = top
            }
        }
        let top = max(area.y, screen.height * 0.06), bottom = min(area.maxY, screen.height - 40)
        if bottom - top < 80 {
            let middle = screen.height / 2
            return Rect(x: area.x, y: middle - screen.height * 0.3, width: area.width, height: screen.height * 0.6)
        }
        return Rect(x: area.x, y: top, width: area.width, height: bottom - top)
    }
}

// MARK: The list a read answers with

extension Element {
    /// A scroll indicator: thin, and named a scroll bar (as UIKit names them in English), or typed so.
    var isScrollBar: Bool {
        if type == "ScrollBar" { return true }
        return type == "Other" && min(frame.width, frame.height) <= 12 && text.lowercased().contains("scroll bar")
    }
}

/// Types that only show text: dropped when an element around them already says it.
let textOnlyTypes: Set<String> = ["StaticText", "Other", "Group", "TextView"]
/// Types that only hold other elements: dropped when something to tap inside says the same.
let holderTypes: Set<String> = ["Other", "Group", "Window", "ScrollView", "Table", "CollectionView"]

/// The listable elements with the repeats taken out: scroll bars, text already said by an element
/// around it (a post's text and then each of its lines), and holders that say what the button inside
/// them says. `full` keeps everything.
func lean(_ elements: [Element], full: Bool) -> [Element] {
    if full { return elements }
    let items = elements.filter { !$0.isScrollBar }
    var drop = Set<Int>()
    var around: [Int] = []
    for (i, e) in items.enumerated() {
        while let last = around.last, !items[last].contains(e) { around.removeLast() }
        for a in around.reversed() {
            let outer = items[a]
            if textOnlyTypes.contains(e.type), outer.text.contains(e.text) { drop.insert(i); break }
            if holderTypes.contains(outer.type), !textOnlyTypes.contains(e.type), outer.text == e.text { drop.insert(a) }
        }
        around.append(i)
    }
    return items.enumerated().filter { !drop.contains($0.offset) }.map(\.element)
}

/// One element that says a lot and has nothing listed inside it: an app collapsed a cell (a post with
/// its buttons) into one element, so its parts cannot be named.
func isCollapsed(_ e: Element, in all: [Element]) -> Bool {
    guard !e.fromPicture, e.text.count >= 60, e.frame.height >= 40, !["StaticText", "TextView", "TextField", "SecureTextField", "Keyboard"].contains(e.type) else { return false }
    return !all.contains { e.contains($0) && !$0.text.isEmpty }
}

/// FNV-1a: the same bytes give the same number, so an unchanged screenshot is seen as unchanged.
func fingerprint(_ data: Data) -> UInt64 {
    var hash: UInt64 = 0xcbf29ce484222325
    data.withUnsafeBytes { raw in
        for byte in raw.bindMemory(to: UInt8.self) { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
    }
    return hash
}
