// Draws an image centred on a square canvas, optionally on a solid colour, and writes a PNG.
//   swift compose.swift <in.png> <out.png> <size px> <fraction of the canvas the image spans> [<#RRGGBB>]
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 5, let size = Int(args[3]), let fraction = Double(args[4]) else {
  FileHandle.standardError.write("usage: compose.swift in.png out.png size fraction [#RRGGBB]\n".data(using: .utf8)!); exit(2)
}
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  FileHandle.standardError.write("cannot read \(args[1])\n".data(using: .utf8)!); exit(1)
}
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let opaque = args.count > 5
guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
if opaque {
  let hex = args[5].trimmingCharacters(in: CharacterSet(charactersIn: "#"))
  let value = UInt32(hex, radix: 16) ?? 0x2084FD
  context.setFillColor(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
  context.fill(CGRect(x: 0, y: 0, width: size, height: size))
}
context.interpolationQuality = .high
let side = Double(size) * fraction, origin = (Double(size) - side) / 2
let aspect = Double(image.width) / Double(image.height)
let w = aspect >= 1 ? side : side * aspect, h = aspect >= 1 ? side / aspect : side
context.draw(image, in: CGRect(x: origin + (side - w) / 2, y: origin + (side - h) / 2, width: w, height: h))
guard let output = context.makeImage(), let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(destination, output, nil)
exit(CGImageDestinationFinalize(destination) ? 0 : 1)
