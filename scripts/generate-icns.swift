#!/usr/bin/env swift
/**
 * generate-icns.swift — Generates AppIcon.icns from the pizza slice design.
 *
 * Draws the same pizza slice icon used in the menu bar at all required
 * macOS icon sizes, creates an iconset, and converts to .icns.
 *
 * Usage: swift scripts/generate-icns.swift
 * Output: desktop/macos/Resources/AppIcon.icns
 */

import AppKit

func drawPizzaSlice(in rect: CGRect, ctx: CGContext) {
    let w = rect.width
    let h = rect.height
    let scale = w / 18.0  // Original design is 18x18

    // Background circle (subtle)
    ctx.setFillColor(NSColor(white: 0.15, alpha: 1.0).cgColor)
    ctx.fillEllipse(in: rect.insetBy(dx: w * 0.05, dy: h * 0.05))

    // Pizza slice
    ctx.setFillColor(NSColor(white: 0.95, alpha: 1.0).cgColor)
    ctx.setStrokeColor(NSColor(white: 0.95, alpha: 1.0).cgColor)
    ctx.setLineWidth(1.5 * scale)

    let path = CGMutablePath()
    path.move(to: CGPoint(x: 9 * scale, y: h - 2 * scale))     // tip (top)
    path.addLine(to: CGPoint(x: 2 * scale, y: 3 * scale))       // bottom left
    path.addQuadCurve(
        to: CGPoint(x: 16 * scale, y: 3 * scale),
        control: CGPoint(x: 9 * scale, y: 1 * scale)
    )
    path.closeSubpath()
    ctx.addPath(path)
    ctx.fillPath()

    // Outline
    ctx.addPath(path)
    ctx.strokePath()

    // Pepperoni (dark circles on light slice)
    ctx.setFillColor(NSColor(white: 0.15, alpha: 1.0).cgColor)
    ctx.fillEllipse(in: CGRect(x: 7 * scale, y: h - 10 * scale, width: 3 * scale, height: 3 * scale))
    ctx.fillEllipse(in: CGRect(x: 5 * scale, y: 4.5 * scale, width: 2.5 * scale, height: 2.5 * scale))
    ctx.fillEllipse(in: CGRect(x: 10 * scale, y: 5 * scale, width: 2.5 * scale, height: 2.5 * scale))
}

func createIcon(size: Int) -> NSImage {
    let s = CGFloat(size)
    let image = NSImage(size: NSSize(width: s, height: s))
    image.lockFocus()
    let ctx = NSGraphicsContext.current!.cgContext
    drawPizzaSlice(in: CGRect(x: 0, y: 0, width: s, height: s), ctx: ctx)
    image.unlockFocus()
    return image
}

// Required icon sizes for .iconset
let sizes: [(Int, String)] = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png"),
]

// Create iconset directory
let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
let projectRoot = scriptDir.deletingLastPathComponent()
let iconsetDir = projectRoot.appendingPathComponent("desktop/macos/Resources/AppIcon.iconset")
let icnsPath = projectRoot.appendingPathComponent("desktop/macos/Resources/AppIcon.icns")

try? FileManager.default.removeItem(at: iconsetDir)
try FileManager.default.createDirectory(at: iconsetDir, withIntermediateDirectories: true)

for (size, filename) in sizes {
    let image = createIcon(size: size)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()

    let data = rep.representation(using: .png, properties: [:])!
    let filePath = iconsetDir.appendingPathComponent(filename)
    try data.write(to: filePath)
}

// Convert iconset to icns using iconutil
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconsetDir.path, "-o", icnsPath.path]
try process.run()
process.waitUntilExit()

if process.terminationStatus == 0 {
    // Clean up iconset
    try? FileManager.default.removeItem(at: iconsetDir)
    print("✅ Generated: \(icnsPath.path)")
} else {
    print("❌ iconutil failed")
    exit(1)
}
