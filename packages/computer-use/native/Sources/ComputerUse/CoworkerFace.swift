import AppKit

/// The coworker's cut-paper face, drawn natively for its desktop cursor and
/// window pill. Geometry mirrors `packages/ui/src/react/coworker-avatar-artwork.tsx`
/// (122×122 view box); keep the two in step when the artwork changes.
struct CoworkerFace {
    enum Mood { case neutral, focused, curious, happy, blink }

    let fill: NSColor
    let edge: NSColor
    let depth: NSColor
    let glasses: String

    private static let body = "M26 8h65c15 0 23 10 23 26v46c0 15-8 24-23 24H57l-15 9c-5 3-10 0-10-6v-3h-5C12 104 5 95 5 80V34C5 18 12 8 26 8Z"
    private static let ink = NSColor(srgbRed: 0.043, green: 0.055, blue: 0.078, alpha: 1)
    private static let frame = NSColor(srgbRed: 0.067, green: 0.082, blue: 0.114, alpha: 1)

    func image(size: CGFloat, mood: Mood, scale: CGFloat) -> CGImage? {
        let pixels = Int((size * scale).rounded(.up))
        guard pixels > 0, let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        // SVG coordinates: origin top-left, y down, in the artwork's 122-unit box.
        let unit = CGFloat(pixels) / 122
        context.translateBy(x: 0, y: CGFloat(pixels))
        context.scaleBy(x: unit, y: -unit)
        context.setLineCap(.round); context.setLineJoin(.round)

        let body = SVGPath.parse(Self.body)
        context.saveGState()
        context.translateBy(x: 3, y: 3)
        context.setAlpha(0.72)
        context.addPath(body); context.setFillColor(depth.cgColor); context.fillPath()
        context.restoreGState()
        context.addPath(body); context.setFillColor(fill.cgColor); context.fillPath()
        context.addPath(body); context.setStrokeColor(edge.cgColor); context.setLineWidth(1.25); context.strokePath()
        stroke(context, "M26 11h64c12 0 20 7 21 19", NSColor.white.withAlphaComponent(0.24), 1)

        switch mood {
        case .happy:
            stroke(context, "M31.5 60.5q6-7.5 12 0", Self.ink, 4.5)
            stroke(context, "M76.5 60.5q6-7.5 12 0", Self.ink, 4.5)
        case .blink:
            stroke(context, "M32 57.5q5.5 4.5 11 0", Self.ink, 3.4)
            stroke(context, "M77 57.5q5.5 4.5 11 0", Self.ink, 3.4)
        case .neutral, .focused, .curious:
            // Focused eyes look down toward the work.
            let drop: CGFloat = mood == .focused ? 4 : 0
            context.setFillColor(Self.ink.cgColor)
            for x in [34.5, 79.5] as [CGFloat] {
                context.addPath(CGPath(roundedRect: CGRect(x: x, y: 50 + drop, width: 6, height: 14), cornerWidth: 3, cornerHeight: 3, transform: nil))
            }
            context.fillPath()
        }
        drawGlasses(context)
        switch mood {
        case .happy:
            context.setFillColor(NSColor(srgbRed: 1, green: 0.56, blue: 0.64, alpha: 1).cgColor)
            context.fillEllipse(in: CGRect(x: 20.5, y: 78.4, width: 13, height: 7.2))
            context.fillEllipse(in: CGRect(x: 86.5, y: 78.4, width: 13, height: 7.2))
            stroke(context, "M53.5 86.5q6.5 6 13 0", Self.frame, 3.4)
        case .curious:
            context.setStrokeColor(Self.frame.cgColor); context.setLineWidth(2.8)
            context.strokeEllipse(in: CGRect(x: 57.4, y: 85.8, width: 5.2, height: 6.4))
        default: break
        }
        return context.makeImage()
    }

    private func drawGlasses(_ context: CGContext) {
        context.setStrokeColor(Self.frame.cgColor)
        let bridgeAndArms = { (bridge: String) in
            stroke(context, bridge, Self.frame, 5)
            stroke(context, "M15 57h4.5M100.5 57h4.5", Self.frame, 7)
        }
        switch glasses {
        case "round", "star":
            context.setLineWidth(5)
            context.strokeEllipse(in: CGRect(x: 20, y: 39.5, width: 35, height: 35))
            context.strokeEllipse(in: CGRect(x: 65, y: 39.5, width: 35, height: 35))
            bridgeAndArms("M57.5 57c1.25-4 3.75-4 5 0")
            if glasses == "star" {
                let star = SVGPath.parse("M100 34.5 102 38.8 106.7 39.4 103.2 42.6 104.1 47.2 100 44.9 95.9 47.2 96.8 42.6 93.3 39.4 98 38.8Z")
                context.addPath(star); context.setFillColor(Self.frame.cgColor); context.fillPath()
            }
        case "oval":
            context.setLineWidth(5)
            context.strokeEllipse(in: CGRect(x: 19.5, y: 43, width: 36, height: 28))
            context.strokeEllipse(in: CGRect(x: 64.5, y: 43, width: 36, height: 28))
            bridgeAndArms("M57.5 57c1.25-4 3.75-4 5 0")
        case "square":
            context.setLineWidth(5)
            for x in [19.5, 64.5] as [CGFloat] {
                context.addPath(CGPath(roundedRect: CGRect(x: x, y: 39, width: 36, height: 36), cornerWidth: 10, cornerHeight: 10, transform: nil))
            }
            context.strokePath()
            bridgeAndArms("M58 57c1-3.5 3-3.5 4 0")
        case "sunglasses":
            for x in [19.5, 64.5] as [CGFloat] {
                let lens = CGPath(roundedRect: CGRect(x: x, y: 41, width: 36, height: 32), cornerWidth: 12, cornerHeight: 12, transform: nil)
                context.addPath(lens); context.setFillColor(NSColor(srgbRed: 0.15, green: 0.2, blue: 0.29, alpha: 0.24).cgColor); context.fillPath()
                context.addPath(lens); context.setLineWidth(4.5); context.strokePath()
            }
            stroke(context, "M57.5 55c1.25-2.5 3.75-2.5 5 0M15 55h4.5M100.5 55h4.5", Self.frame, 4.5)
            stroke(context, "M27 47h12M72 47h12", NSColor.white.withAlphaComponent(0.25), 1.5)
        case "monocle":
            context.setLineWidth(3.5)
            context.strokeEllipse(in: CGRect(x: 65, y: 39.5, width: 35, height: 35))
            stroke(context, "M96 68l2 2", Self.frame, 2.5)
        default: break
        }
    }

    private func stroke(_ context: CGContext, _ path: String, _ color: NSColor, _ width: CGFloat) {
        context.addPath(SVGPath.parse(path))
        context.setStrokeColor(color.cgColor); context.setLineWidth(width)
        context.strokePath()
    }
}

/// Enough of SVG path syntax for the avatar artwork: M L H V C Q Z, absolute and relative.
enum SVGPath {
    static func parse(_ data: String) -> CGPath {
        var tokens: [String] = []
        var number = ""
        func flush() { if !number.isEmpty { tokens.append(number); number = "" } }
        for character in data {
            if "MmLlHhVvCcQqZz".contains(character) { flush(); tokens.append(String(character)) }
            else if character == "-" { if number.last == "e" { number.append(character) } else { flush(); number = "-" } }
            else if character == "." && number.contains(".") { flush(); number = "." }
            else if character.isNumber || character == "." || character == "e" { number.append(character) }
            else { flush() }
        }
        flush()
        let path = CGMutablePath()
        var index = 0
        var command: Character = "M"
        var point = CGPoint.zero
        var start = CGPoint.zero
        func next() -> CGFloat { defer { index += 1 }; return index < tokens.count ? CGFloat(Double(tokens[index]) ?? 0) : 0 }
        while index < tokens.count {
            if let first = tokens[index].first, first.isLetter { command = first; index += 1 }
            let relative = command.isLowercase
            let origin = relative ? point : .zero
            switch command.uppercased() {
            case "M":
                point = CGPoint(x: origin.x + next(), y: origin.y + next()); start = point
                path.move(to: point)
                command = relative ? "l" : "L"
            case "L":
                point = CGPoint(x: origin.x + next(), y: origin.y + next()); path.addLine(to: point)
            case "H":
                point.x = (relative ? point.x : 0) + next(); path.addLine(to: point)
            case "V":
                point.y = (relative ? point.y : 0) + next(); path.addLine(to: point)
            case "C":
                let c1 = CGPoint(x: origin.x + next(), y: origin.y + next())
                let c2 = CGPoint(x: origin.x + next(), y: origin.y + next())
                point = CGPoint(x: origin.x + next(), y: origin.y + next())
                path.addCurve(to: point, control1: c1, control2: c2)
            case "Q":
                let control = CGPoint(x: origin.x + next(), y: origin.y + next())
                point = CGPoint(x: origin.x + next(), y: origin.y + next())
                path.addQuadCurve(to: point, control: control)
            case "Z":
                path.closeSubpath(); point = start
                if index < tokens.count, let first = tokens[index].first, !first.isLetter { index += 1 }
            default:
                index += 1
            }
        }
        return path
    }
}
