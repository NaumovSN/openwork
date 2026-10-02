import AppKit
import QuartzCore

/// Shows the person where the agent is acting: an outline around the approved
/// window and a highlighted agent cursor that glides to each dispatched input.
/// Presentation only. It never receives events (input passes through to the
/// person's apps) and is excluded from capture, so observations stay unchanged.
/// Inputs are posted to the app, not the system cursor, so without this the
/// person sees no pointer at all.
@MainActor
final class AgentCursor {
    static let shared = AgentCursor()

    private var window: NSWindow?
    private let outline = CAShapeLayer()
    private let cursor = CALayer()
    private let label = CATextLayer()
    private var cursorPoint: CGPoint?
    private var paused = false
    private var hideLabel: DispatchWorkItem?

    private static let accent = NSColor(srgbRed: 0.31, green: 0.66, blue: 1.0, alpha: 1)

    /// Global Quartz coordinates (top-left origin) to Cocoa screen coordinates.
    private static func cocoa(_ point: CGPoint) -> CGPoint {
        CGPoint(x: point.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - point.y)
    }
    private static func cocoa(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX, y: (NSScreen.screens.first?.frame.maxY ?? 0) - rect.maxY, width: rect.width, height: rect.height)
    }

    func begin(windowFrame: CGRect) {
        paused = false
        if window == nil { build() }
        place(windowFrame: windowFrame)
        window?.alphaValue = 1
        window?.orderFrontRegardless()
    }

    func setPaused(_ value: Bool) {
        guard window != nil, paused != value else { return }
        paused = value
        // The person has control: dim the outline and hide the agent cursor.
        CATransaction.begin(); CATransaction.setAnimationDuration(0.2)
        outline.strokeColor = (value ? NSColor.systemOrange : Self.accent).withAlphaComponent(value ? 0.55 : 0.9).cgColor
        cursor.opacity = value ? 0 : 1
        label.opacity = 0
        CATransaction.commit()
    }

    func feedback(action: String, phase: InputFeedback.Phase, screenPoint: CGPoint?, windowFrame: CGRect) {
        guard !paused, phase != .uncertain else { return }
        if window == nil { begin(windowFrame: windowFrame) } else { place(windowFrame: windowFrame) }
        guard let container = window?.contentView?.layer, let frame = window?.frame else { return }
        let target: CGPoint
        if let screenPoint {
            let point = Self.cocoa(screenPoint)
            target = CGPoint(x: point.x - frame.minX, y: point.y - frame.minY)
        } else if let cursorPoint {
            target = cursorPoint
        } else {
            let rect = Self.cocoa(windowFrame)
            target = CGPoint(x: rect.midX - frame.minX, y: rect.midY - frame.minY)
        }
        if cursorPoint != target {
            // Glide like a person's pointer instead of teleporting.
            let move = CABasicAnimation(keyPath: "position")
            move.fromValue = NSValue(point: cursorPoint ?? target)
            move.toValue = NSValue(point: target)
            move.duration = cursorPoint == nil ? 0 : 0.18
            move.timingFunction = CAMediaTimingFunction(name: .easeOut)
            CATransaction.begin(); CATransaction.setDisableActions(true)
            cursor.position = target
            CATransaction.commit()
            cursor.add(move, forKey: "move")
            cursorPoint = target
        }
        cursor.opacity = 1
        if phase == .down || (phase == .dispatched && screenPoint != nil && action != "scroll") { ripple(at: target, in: container) }
        if phase != .move && phase != .up { show(Self.title(action), at: target) }
    }

    func end() {
        hideLabel?.cancel(); hideLabel = nil
        window?.orderOut(nil); window = nil
        cursorPoint = nil; paused = false
    }

    private static func title(_ action: String) -> String {
        switch action {
        case "click": return "Click"
        case "double_click": return "Double-click"
        case "triple_click": return "Triple-click"
        case "type", "set_value": return "Typing"
        case "key": return "Key press"
        case "scroll": return "Scrolling"
        case "drag": return "Dragging"
        case "press": return "Press"
        case "move": return "Pointing"
        default: return "Working"
        }
    }

    private func build() {
        // Displays usually have separate Spaces, so one window cannot span them;
        // place() moves this window to the screen holding the approved window.
        let bounds = NSScreen.main?.frame ?? CGRect(x: 0, y: 0, width: 1, height: 1)
        let window = NSWindow(contentRect: bounds, styleMask: .borderless, backing: .buffered, defer: false)
        window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = false
        window.ignoresMouseEvents = true
        window.sharingType = .none
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        window.isReleasedWhenClosed = false
        let view = NSView(frame: NSRect(origin: .zero, size: bounds.size))
        view.wantsLayer = true
        view.autoresizingMask = [.width, .height]
        window.contentView = view
        guard let root = view.layer else { return }
        let scale = NSScreen.main?.backingScaleFactor ?? 2

        outline.fillColor = nil
        outline.strokeColor = Self.accent.withAlphaComponent(0.9).cgColor
        outline.lineWidth = 3
        outline.shadowColor = Self.accent.cgColor
        outline.shadowOpacity = 0.9; outline.shadowRadius = 10; outline.shadowOffset = .zero
        root.addSublayer(outline)

        // A classic arrow in the accent color with a white rim and a soft halo.
        cursor.bounds = CGRect(x: 0, y: 0, width: 44, height: 44)
        cursor.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        let halo = CALayer()
        halo.frame = cursor.bounds
        halo.cornerRadius = 22
        halo.backgroundColor = Self.accent.withAlphaComponent(0.22).cgColor
        let pulse = CABasicAnimation(keyPath: "transform.scale")
        pulse.fromValue = 0.85; pulse.toValue = 1.1; pulse.duration = 0.9
        pulse.autoreverses = true; pulse.repeatCount = .infinity
        halo.add(pulse, forKey: "pulse")
        cursor.addSublayer(halo)
        let arrow = CAShapeLayer()
        let path = CGMutablePath()
        // Tip at the layer center so the tip marks the exact input point.
        let tip = CGPoint(x: 22, y: 22)
        path.move(to: tip)
        path.addLine(to: CGPoint(x: tip.x, y: tip.y - 21))
        path.addLine(to: CGPoint(x: tip.x + 5, y: tip.y - 16))
        path.addLine(to: CGPoint(x: tip.x + 9, y: tip.y - 24))
        path.addLine(to: CGPoint(x: tip.x + 12, y: tip.y - 22.5))
        path.addLine(to: CGPoint(x: tip.x + 8, y: tip.y - 14.5))
        path.addLine(to: CGPoint(x: tip.x + 15, y: tip.y - 14.5))
        path.closeSubpath()
        arrow.path = path
        arrow.fillColor = Self.accent.cgColor
        arrow.strokeColor = NSColor.white.cgColor
        arrow.lineWidth = 1.5; arrow.lineJoin = .round
        arrow.shadowColor = NSColor.black.cgColor
        arrow.shadowOpacity = 0.45; arrow.shadowRadius = 3; arrow.shadowOffset = CGSize(width: 0, height: -1)
        cursor.addSublayer(arrow)
        cursor.opacity = 0
        root.addSublayer(cursor)

        label.fontSize = 12
        label.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        label.foregroundColor = NSColor.white.cgColor
        label.backgroundColor = Self.accent.withAlphaComponent(0.95).cgColor
        label.cornerRadius = 9
        label.alignmentMode = .center
        label.contentsScale = scale
        label.opacity = 0
        root.addSublayer(label)
        self.window = window
    }

    private func place(windowFrame: CGRect) {
        guard let window, Geometry.valid(windowFrame) else { return }
        let target = Self.cocoa(windowFrame)
        let screen = NSScreen.screens.max { lhs, rhs in
            let a = lhs.frame.intersection(target), b = rhs.frame.intersection(target)
            return (a.isNull ? 0 : a.width * a.height) < (b.isNull ? 0 : b.width * b.height)
        }
        if let screen, window.frame != screen.frame {
            window.setFrame(screen.frame, display: false)
            cursorPoint = nil
        }
        let rect = target.offsetBy(dx: -window.frame.minX, dy: -window.frame.minY).insetBy(dx: -3, dy: -3)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        outline.path = CGPath(roundedRect: rect, cornerWidth: 12, cornerHeight: 12, transform: nil)
        CATransaction.commit()
    }

    private func ripple(at point: CGPoint, in container: CALayer) {
        let ring = CAShapeLayer()
        ring.path = CGPath(ellipseIn: CGRect(x: -14, y: -14, width: 28, height: 28), transform: nil)
        ring.position = point
        ring.fillColor = Self.accent.withAlphaComponent(0.25).cgColor
        ring.strokeColor = Self.accent.cgColor
        ring.lineWidth = 2
        container.insertSublayer(ring, below: cursor)
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.4; grow.toValue = 1.8
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1; fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]; group.duration = 0.45
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ring.opacity = 0
        ring.add(group, forKey: "ripple")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { ring.removeFromSuperlayer() }
    }

    private func show(_ text: String, at point: CGPoint) {
        let width = ceil((text as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold)]).width) + 20
        CATransaction.begin(); CATransaction.setDisableActions(true)
        label.string = text
        label.frame = CGRect(x: point.x + 18, y: point.y - 44, width: width, height: 20)
        CATransaction.commit()
        label.opacity = 1
        hideLabel?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.label.opacity = 0 }
        hideLabel = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
    }
}
