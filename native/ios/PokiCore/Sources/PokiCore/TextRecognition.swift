import Foundation
#if canImport(Vision) && canImport(ImageIO)
import Vision
import ImageIO
#endif

/// A line of text read from the screenshot. `box` is in parts of the picture (0 to 1, from the top
/// left), so it maps to screen points by multiplying with the screen size.
public struct RecognizedText: Sendable, Equatable {
    public var text: String
    public var box: Rect
    public init(text: String, box: Rect) {
        self.text = text
        self.box = box
    }
}

/// Text recognition on the phone (Vision). Nil where Vision is missing (Linux) or the picture cannot
/// be read.
enum TextRecognizer {
    static func recognize(png: Data) -> [RecognizedText]? {
        #if canImport(Vision) && canImport(ImageIO)
        guard let source = CGImageSourceCreateWithData(png as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        if #available(iOS 16, macOS 13, *) { request.automaticallyDetectsLanguage = true }
        do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) } catch { return nil }
        return (request.results ?? []).compactMap { observation in
            guard let best = observation.topCandidates(1).first, !best.string.isEmpty else { return nil }
            let b = observation.boundingBox
            return RecognizedText(text: best.string, box: Rect(x: Double(b.minX), y: Double(1 - b.maxY), width: Double(b.width), height: Double(b.height)))
        }
        #else
        return nil
        #endif
    }
}

extension CoreHost {
    /// Vision on the phone; a host may answer differently (tests do).
    public func recognizeText(inPNG png: Data) async -> [RecognizedText]? { TextRecognizer.recognize(png: png) }
}
