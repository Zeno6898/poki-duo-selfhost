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

    /// Whether a person would see a change: over 1 % of the cells differ by more than 12 of 255.
    func differs(from other: PictureSketch) -> Bool {
        if let hash, let o = other.hash { return hash != o }
        guard cells.count == other.cells.count, !cells.isEmpty else { return true }
        var moved = 0
        for (a, b) in zip(cells, other.cells) where abs(Int(a) - Int(b)) > 12 { moved += 1 }
        return moved * 100 > cells.count
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
