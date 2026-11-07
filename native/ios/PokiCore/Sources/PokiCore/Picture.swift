import Foundation
#if canImport(CoreGraphics) && canImport(ImageIO)
import CoreGraphics
import ImageIO
#endif

/// A coarse look at a screenshot: the picture as a small grid of grey levels, so two reads can be
/// told apart by what a person would call a change, not by a pixel. A scroll indicator fading out,
/// a cursor blinking or the clock ticking moves a few cells a little; a sheet, a photo or a page
/// coming in moves many cells a lot.
struct PictureSketch: Equatable {
    static let columns = 32, rows = 64
    var cells: [UInt8]
    /// The exact bytes, where the picture cannot be decoded (Linux): then only sameness is known.
    var hash: UInt64?

    /// How the picture differs from another: the share of cells that moved by more than 12 of 255,
    /// and the box holding all of them, in parts of the width and height (0 to 1). nil where only
    /// sameness is known (hashed).
    struct Change: Equatable { var share: Double; var x: Double, y: Double, width: Double, height: Double }
    func change(from other: PictureSketch) -> Change? {
        guard hash == nil, other.hash == nil, cells.count == other.cells.count, !cells.isEmpty else { return nil }
        var moved = 0, left = Self.columns, right = -1, top = Self.rows, bottom = -1
        for (i, (a, b)) in zip(cells, other.cells).enumerated() where abs(Int(a) - Int(b)) > 12 {
            moved += 1
            let column = i % Self.columns, row = i / Self.columns
            left = min(left, column); right = max(right, column); top = min(top, row); bottom = max(bottom, row)
        }
        guard moved > 0 else { return Change(share: 0, x: 0, y: 0, width: 0, height: 0) }
        return Change(share: Double(moved) / Double(cells.count), x: Double(left) / Double(Self.columns), y: Double(top) / Double(Self.rows),
                      width: Double(right - left + 1) / Double(Self.columns), height: Double(bottom - top + 1) / Double(Self.rows))
    }

    /// Whether a person would see a change: over 1 % of the cells differ by more than 12 of 255.
    func differs(from other: PictureSketch) -> Bool {
        if let hash, let o = other.hash { return hash != o }
        guard let change = change(from: other) else { return true }
        return change.share > 0.01
    }

    init(png: Data) {
        #if canImport(CoreGraphics) && canImport(ImageIO)
        if let source = CGImageSourceCreateWithData(png as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
           let context = CGContext(data: nil, width: Self.columns, height: Self.rows, bitsPerComponent: 8, bytesPerRow: Self.columns, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) {
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: Self.columns, height: Self.rows))
            if let data = context.data {
                cells = Array(UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: Self.columns * Self.rows))
                hash = nil
                return
            }
        }
        #endif
        cells = []
        hash = fingerprint(png)
    }
}
