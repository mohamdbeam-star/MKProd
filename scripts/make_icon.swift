import AppKit

// Renders the MK Prod app icon to a 1024px PNG.
let size = 1024.0
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let rect = NSRect(x: 0, y: 0, width: size, height: size).insetBy(dx: 80, dy: 80)
let path = NSBezierPath(roundedRect: rect, xRadius: 190, yRadius: 190)
NSGradient(colors: [NSColor(red: 0.48, green: 0.41, blue: 0.93, alpha: 1), NSColor(red: 0.84, green: 0.25, blue: 0.62, alpha: 1)])!
    .draw(in: path, angle: -45)
let check = NSBezierPath()
check.lineWidth = 70
check.lineCapStyle = .round
check.lineJoinStyle = .round
check.move(to: NSPoint(x: 330, y: 560))
check.line(to: NSPoint(x: 460, y: 430))
check.line(to: NSPoint(x: 700, y: 680))
NSColor.white.withAlphaComponent(0.95).setStroke()
check.stroke()
let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 150, weight: .heavy), .foregroundColor: NSColor.white]
let s = NSAttributedString(string: "MK", attributes: attrs)
s.draw(at: NSPoint(x: (size - s.size().width) / 2, y: 190))
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
