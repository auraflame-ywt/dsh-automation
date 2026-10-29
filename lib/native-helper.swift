// dsh-automation native helper (macOS).
//
// Protocol: `native-helper <command> [json-args]`
//   - success: prints one JSON object to stdout and exits 0
//   - failure: prints {"error": "...", "code": "..."} to stdout and exits 1
//
// The helper is compiled once by lib/native.mjs with swiftc and invoked through
// `execFile(binary, [command, JSON.stringify(args)])`. It must never print
// anything besides the single JSON result on stdout; diagnostics go to stderr.
//
// Commands:
//   permissions               -> {accessibility, screenRecording, platform, ...}
//   request-screen            -> {granted, prompted}
//   request-accessibility     -> {granted, prompted}
//   displays                  -> {displays, cursor, frontmostApp}
//   cursor                    -> {x, y}
//   windows                   -> {windows: [{windowId, app, title, bounds, layer, ...}], screenRecording}
//   apps                      -> {apps: [{name, bundleId, pid, active, hidden, windows: [...]}]}
//   app-action                -> {ok, app}
//   app-windows               -> {windows: [{title, bounds, minimized}]}
//   move                      -> {ok, action, x, y, verified}
//   click                     -> {ok, action, x, y, button, count}
//   drag                      -> {ok, action, from, to}
//   scroll                    -> {ok, action, deltaX, deltaY}
//   key                       -> {ok, action, key, keyCode, modifiers}
//   type                      -> {ok, action, typed}

import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

// MARK: - JSON output

func writeJSON(_ object: [String: Any]) {
    var data: Data
    if #available(macOS 10.13, *) {
        data = (try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])) ?? Data()
    } else {
        data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    }
    if data.isEmpty {
        data = Data("{\"error\":\"failed to encode JSON output\",\"code\":\"INTERNAL\"}".utf8)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String, code: String, hint: String? = nil) -> Never {
    var object: [String: Any] = ["error": message, "code": code]
    if let hint, !hint.isEmpty { object["hint"] = hint }
    writeJSON(object)
    exit(1)
}

// MARK: - Argument helpers

func argValue(_ args: [String: Any], _ key: String) -> Any? {
    guard let value = args[key], !(value is NSNull) else { return nil }
    return value
}

func optionalString(_ args: [String: Any], _ key: String) -> String? {
    guard let value = argValue(args, key) else { return nil }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func requiredString(_ args: [String: Any], _ key: String, code: String = "BAD_ARGS") -> String {
    guard let text = optionalString(args, key), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        fail("missing required argument '\(key)' (non-empty string)", code: code)
    }
    return text
}

func optionalDouble(_ args: [String: Any], _ key: String) -> Double? {
    guard let value = argValue(args, key) else { return nil }
    if let number = value as? NSNumber { return number.doubleValue }
    if let text = value as? String, let number = Double(text) { return number }
    return nil
}

func requiredDouble(_ args: [String: Any], _ key: String, code: String = "BAD_ARGS") -> Double {
    guard let value = optionalDouble(args, key), value.isFinite else {
        fail("missing required numeric argument '\(key)'", code: code)
    }
    return value
}

func optionalInt(_ args: [String: Any], _ key: String) -> Int? {
    guard let value = optionalDouble(args, key) else { return nil }
    return Int(value.rounded())
}

func optionalBool(_ args: [String: Any], _ key: String) -> Bool? {
    guard let value = argValue(args, key) else { return nil }
    if let boolean = value as? Bool { return boolean }
    if let number = value as? NSNumber { return number.boolValue }
    if let text = value as? String {
        switch text.lowercased() {
        case "true", "1", "yes": return true
        case "false", "0", "no": return false
        default: return nil
        }
    }
    return nil
}

func stringList(_ args: [String: Any], _ key: String) -> [String] {
    guard let value = argValue(args, key) else { return [] }
    if let list = value as? [String] { return list }
    if let single = value as? String { return [single] }
    if let list = value as? [Any] {
        return list.compactMap { item in
            if let text = item as? String { return text }
            if let number = item as? NSNumber { return number.stringValue }
            return nil
        }
    }
    return []
}

func pointArg(_ args: [String: Any], _ key: String) -> CGPoint? {
    guard let value = argValue(args, key) else { return nil }
    if let dictionary = value as? [String: Any],
       let x = optionalDouble(dictionary, "x"),
       let y = optionalDouble(dictionary, "y") {
        return CGPoint(x: x, y: y)
    }
    if let list = value as? [Any], list.count >= 2,
       let x = (list[0] as? NSNumber)?.doubleValue,
       let y = (list[1] as? NSNumber)?.doubleValue {
        return CGPoint(x: x, y: y)
    }
    return nil
}

func pointJSON(_ point: CGPoint) -> [String: Any] {
    ["x": Double(point.x), "y": Double(point.y)]
}

func rectJSON(_ rect: CGRect) -> [String: Any] {
    [
        "x": Double(rect.origin.x.rounded()),
        "y": Double(rect.origin.y.rounded()),
        "width": Double(rect.width.rounded()),
        "height": Double(rect.height.rounded()),
    ]
}

func permissionHintScreenRecording() -> String {
    "Grant Screen Recording to DeepSeek Harness in System Settings → Privacy & Security → Screen Recording, then restart DeepSeek Harness (macOS only applies the change to a fresh process) and run the computer_permissions tool to confirm."
}

func permissionHintAccessibility() -> String {
    "Grant Accessibility to DeepSeek Harness in System Settings → Privacy & Security → Accessibility, then run the computer_permissions tool (and retry)."
}

// MARK: - Permissions

func permissionsPayload() -> [String: Any] {
    let processInfo = ProcessInfo.processInfo
    return [
        "accessibility": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "platform": "macos",
        "arch": machineArchitecture(),
        "osVersion": processInfo.operatingSystemVersionString,
        "cursor": pointJSON(cursorPoint()),
        "frontmostApp": frontmostApplicationPayload(),
    ]
}

func machineArchitecture() -> String {
    #if arch(arm64)
    return "arm64"
    #elseif arch(x86_64)
    return "x86_64"
    #else
    return "unknown"
    #endif
}

// MARK: - Displays / cursor / frontmost app

func primaryScreen() -> NSScreen? {
    NSScreen.screens.first
}

func screenDisplays() -> [[String: Any]] {
    let screens = NSScreen.screens
    let mainDisplayID = CGMainDisplayID()
    let primaryHeight = primaryScreen()?.frame.height ?? 0
    var result: [[String: Any]] = []
    for (index, screen) in screens.enumerated() {
        let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        let displayID = number?.uint32Value ?? 0
        var bounds = CGDisplayBounds(displayID)
        if bounds.isEmpty {
            let frame = screen.frame
            bounds = CGRect(
                x: frame.origin.x,
                y: primaryHeight - frame.origin.y - frame.height,
                width: frame.width,
                height: frame.height
            )
        }
        var entry: [String: Any] = [
            "id": Int(displayID),
            "index": index + 1,
            "main": displayID == mainDisplayID,
            "bounds": rectJSON(bounds),
            "scale": Double(screen.backingScaleFactor),
        ]
        let localized = screen.localizedName
        if !localized.isEmpty { entry["name"] = localized }
        result.append(entry)
    }
    if result.isEmpty {
        // Headless / no GUI session: still report the main display size from CG.
        let bounds = CGDisplayBounds(mainDisplayID)
        result.append([
            "id": Int(mainDisplayID),
            "index": 1,
            "main": true,
            "bounds": rectJSON(bounds),
            "scale": 1.0,
            "name": "Main Display",
        ])
    }
    return result
}

func cursorPoint() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

func frontmostApplicationPayload() -> [String: Any] {
    guard let app = NSWorkspace.shared.frontmostApplication else {
        return ["name": "", "bundleId": "", "pid": 0]
    }
    return [
        "name": app.localizedName ?? "",
        "bundleId": app.bundleIdentifier ?? "",
        "pid": Int(app.processIdentifier),
    ]
}

// MARK: - Window list (CGWindowListCopyWindowInfo)

func windowListPayload(appFilter: String?) -> [String: Any] {
    let options: CGWindowListOption = [.optionAll]
    guard let rawList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        fail("the system returned no window list", code: "WINDOW_LIST_FAILED")
    }
    let wanted = appFilter?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let wantedPID: pid_t? = {
        guard let raw = appFilter, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return resolveStringApp(raw)?.processIdentifier
    }()
    var windows: [[String: Any]] = []
    for raw in rawList {
        guard let windowNumber = raw[kCGWindowNumber as String] as? NSNumber else { continue }
        let ownerName = raw[kCGWindowOwnerName as String] as? String ?? ""
        if let wanted, !wanted.isEmpty {
            let ownerMatches = ownerName.lowercased().contains(wanted)
            let pidMatches = wantedPID.map { (raw[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == $0 } ?? false
            if !ownerMatches && !pidMatches { continue }
        }
        var bounds = CGRect.zero
        if let dictionary = raw[kCGWindowBounds as String] as? [String: Any],
           let x = (dictionary["X"] as? NSNumber)?.doubleValue,
           let y = (dictionary["Y"] as? NSNumber)?.doubleValue,
           let width = (dictionary["Width"] as? NSNumber)?.doubleValue,
           let height = (dictionary["Height"] as? NSNumber)?.doubleValue {
            bounds = CGRect(x: x, y: y, width: width, height: height)
        }
        if bounds.width <= 0 || bounds.height <= 0 { continue }
        let layer = (raw[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        let alpha = (raw[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1.0
        let onscreen = (raw[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
        let pid = (raw[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
        let title = raw[kCGWindowName as String] as? String ?? ""
        windows.append([
            "windowId": windowNumber.intValue,
            "app": ownerName,
            "title": title,
            "bounds": rectJSON(bounds),
            "layer": layer,
            "alpha": alpha,
            "onscreen": onscreen,
            "pid": pid,
        ])
    }
    return ["windows": windows, "screenRecording": CGPreflightScreenCaptureAccess()]
}

// MARK: - Applications

func runningApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular && $0.processIdentifier > 0
    }
}

func resolveStringApp(_ spec: String) -> NSRunningApplication? {
    let trimmed = spec.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let lower = trimmed.lowercased()
    let candidates = runningApps()
    // Bundle identifier: exact match, or a suffix match so "Finder" finds
    // com.apple.finder even when the localized app name is not English.
    if let exact = candidates.first(where: { $0.bundleIdentifier?.lowercased() == lower }) {
        return exact
    }
    if !lower.contains(" ") {
        if let suffix = candidates.first(where: { app in
            guard let bundle = app.bundleIdentifier?.lowercased() else { return false }
            return bundle.hasSuffix(".\(lower)") || bundle.contains(".\(lower).")
        }) {
            return suffix
        }
    }
    // Absolute or .app path.
    if lower.hasSuffix(".app") {
        let expanded = (trimmed as NSString).expandingTildeInPath
        let targetURL = URL(fileURLWithPath: expanded).standardizedFileURL
        if let byPath = candidates.first(where: { $0.bundleURL?.standardizedFileURL == targetURL }) {
            return byPath
        }
        if expanded.contains("/") {
            let base = targetURL.deletingPathExtension().lastPathComponent.lowercased()
            if let byBase = candidates.first(where: { ($0.localizedName ?? "").lowercased() == base }) {
                return byBase
            }
        }
    }
    if let exact = candidates.first(where: { ($0.localizedName ?? "").lowercased() == lower }) {
        return exact
    }
    if let partial = candidates.first(where: { ($0.localizedName ?? "").lowercased().contains(lower) }) {
        return partial
    }
    return nil
}

func resolveApp(_ spec: Any?) -> NSRunningApplication? {
    guard let spec else { return nil }
    if let number = spec as? NSNumber {
        return NSRunningApplication(processIdentifier: pid_t(number.intValue))
    }
    if let text = spec as? String {
        return resolveStringApp(text)
    }
    return nil
}

func appNotFound(_ spec: Any?) -> Never {
    let label: String
    if let text = spec as? String {
        label = text
    } else if let number = spec as? NSNumber {
        label = "pid \(number.intValue)"
    } else {
        label = "unspecified"
    }
    let names = runningApps()
        .compactMap { $0.localizedName }
        .sorted()
        .prefix(12)
        .joined(separator: ", ")
    fail(
        "application '\(label)' is not running or cannot be found",
        code: "APP_NOT_FOUND",
        hint: "Use the computer_apps tool with action=apps_list to see running applications, or launch it first with action=launch. Running apps include: \(names)"
    )
}

func appPayload(_ app: NSRunningApplication, includeWindows: Bool = false) -> [String: Any] {
    var payload: [String: Any] = [
        "name": app.localizedName ?? app.bundleURL?.deletingPathExtension().lastPathComponent ?? "",
        "bundleId": app.bundleIdentifier ?? "",
        "pid": Int(app.processIdentifier),
        "active": app.isActive,
        "hidden": app.isHidden,
    ]
    if let url = app.bundleURL { payload["bundlePath"] = url.path }
    if includeWindows {
        let (windows, _) = axWindows(for: app.processIdentifier)
        payload["windows"] = windows
    }
    return payload
}

// MARK: - Accessibility windows

func axValueCGPoint(_ value: CFTypeRef?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    let axValue = unsafeDowncast(value, to: AXValue.self)
    guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }
    return point
}

func axValueCGSize(_ value: CFTypeRef?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    let axValue = unsafeDowncast(value, to: AXValue.self)
    guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }
    return size
}

func axWindows(for pid: pid_t) -> ([[String: Any]], AXError) {
    let appElement = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(appElement, 0.5)
    var rawWindows: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &rawWindows)
    if error != .success { return ([], error) }
    guard let windowElements = rawWindows as? [AXUIElement] else { return ([], .success) }
    var windows: [[String: Any]] = []
    for window in windowElements {
        AXUIElementSetMessagingTimeout(window, 0.5)
        var titleValue: CFTypeRef?
        AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleValue)
        let title = titleValue as? String ?? ""

        var positionValue: CFTypeRef?
        AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionValue)
        var sizeValue: CFTypeRef?
        AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeValue)

        var minimizedValue: CFTypeRef?
        AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimizedValue)
        let minimized = (minimizedValue as? NSNumber)?.boolValue ?? (minimizedValue as? Bool) ?? false

        let point = axValueCGPoint(positionValue) ?? CGPoint.zero
        let size = axValueCGSize(sizeValue) ?? CGSize.zero
        windows.append([
            "title": title,
            "bounds": rectJSON(CGRect(origin: point, size: size)),
            "minimized": minimized,
        ])
    }
    return (windows, .success)
}

func requireAccessibility() {
    if !AXIsProcessTrusted() {
        fail(
            "Accessibility permission is not granted, so app windows cannot be inspected",
            code: "PERMISSION_ACCESSIBILITY",
            hint: permissionHintAccessibility()
        )
    }
}

func axErrorDescription(_ error: AXError) -> String {
    switch error {
    case .apiDisabled: return "Accessibility API is disabled"
    case .failure: return "AX API failure"
    case .cannotComplete: return "AX API cannot complete (target app may be unresponsive)"
    case .invalidUIElement: return "invalid UI element"
    case .attributeUnsupported: return "attribute unsupported"
    case .notImplemented: return "not implemented"
    case .illegalArgument: return "illegal argument"
    default: return "AX error \(error.rawValue)"
    }
}

// MARK: - Launch / app actions

func applicationURL(for spec: String) -> URL? {
    let trimmed = spec.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasSuffix(".app") {
        let expanded = (trimmed as NSString).expandingTildeInPath
        if FileManager.default.fileExists(atPath: expanded) {
            return URL(fileURLWithPath: expanded)
        }
    }
    if trimmed.contains(".") {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: trimmed) {
            return url
        }
    }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let roots = [
        "/Applications",
        "/Applications/Utilities",
        "/System/Applications",
        "/System/Applications/Utilities",
        "\(home)/Applications",
    ]
    let lower = trimmed.lowercased()
    for root in roots {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: root) else { continue }
        for entry in entries where entry.lowercased().hasSuffix(".app") {
            let name = String(entry.dropLast(4))
            if name.lowercased() == lower {
                return URL(fileURLWithPath: "\(root)/\(entry)")
            }
        }
    }
    // Last resort: accept a substring match such as "chrome" for "Google Chrome".
    for root in roots {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: root) else { continue }
        for entry in entries where entry.lowercased().hasSuffix(".app") {
            let name = String(entry.dropLast(4))
            if name.lowercased().contains(lower) {
                return URL(fileURLWithPath: "\(root)/\(entry)")
            }
        }
    }
    return nil
}

func launchApplication(at url: URL) -> (NSRunningApplication?, Error?) {
    final class Box: @unchecked Sendable {
        var app: NSRunningApplication?
        var error: Error?
        var done = false
    }
    let box = Box()
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
        box.app = app
        box.error = error
        box.done = true
    }
    let deadline = Date().addingTimeInterval(8)
    while !box.done && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return (box.app, box.error)
}

func activateApp(_ app: NSRunningApplication) -> Bool {
    if #available(macOS 14.0, *) {
        return app.activate(from: NSRunningApplication.current, options: [.activateAllWindows])
    } else {
        return app.activate(options: [.activateIgnoringOtherApps])
    }
}

func waitForExit(_ app: NSRunningApplication, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !app.isTerminated && Date() < deadline {
        usleep(50_000)
    }
    return app.isTerminated
}

func runAppAction(action: String, spec: Any?, extra: [String: Any]) -> [String: Any] {
    switch action {
    case "launch":
        guard let raw = spec as? String ?? (spec as? NSNumber)?.stringValue else {
            fail("app-action launch requires an app name, bundle id or pid", code: "BAD_ARGS")
        }
        if let running = resolveStringApp(raw) {
            _ = activateApp(running)
            return ["ok": true, "action": action, "alreadyRunning": true, "app": appPayload(running)]
        }
        guard let url = applicationURL(for: raw) else {
            fail(
                "could not find an application named '\(raw)'",
                code: "APP_NOT_FOUND",
                hint: "Pass a bundle id such as com.apple.Safari, a full path ending in .app, or an app name installed under /Applications."
            )
        }
        let (launched, error) = launchApplication(at: url)
        if let error {
            fail(
                "failed to launch '\(raw)'",
                code: "APP_LAUNCH_FAILED",
                hint: "\(error.localizedDescription). Try opening the app manually first."
            )
        }
        let app = launched ?? runningApps().first(where: { running in
            guard let bundleURL = running.bundleURL?.standardizedFileURL else { return false }
            return bundleURL == url.standardizedFileURL
        })
        guard let app else {
            return ["ok": true, "action": action, "app": ["name": url.deletingPathExtension().lastPathComponent, "bundleId": "", "pid": 0, "active": true, "hidden": false]]
        }
        if !app.isActive { _ = activateApp(app) }
        return ["ok": true, "action": action, "app": appPayload(app)]

    case "activate":
        guard let app = resolveApp(spec) else { appNotFound(spec) }
        let ok = activateApp(app)
        return ["ok": ok, "action": action, "app": appPayload(app)]

    case "quit":
        guard let app = resolveApp(spec) else { appNotFound(spec) }
        let force = (extra["force"] as? Bool) ?? (extra["force"] as? NSNumber)?.boolValue ?? false
        let before = appPayload(app)
        let accepted = force ? app.forceTerminate() : app.terminate()
        let terminated = accepted ? waitForExit(app, timeout: 3.0) : true
        var result: [String: Any] = ["ok": accepted, "action": action, "force": force, "terminated": terminated, "app": before]
        if !terminated {
            result["hint"] = "The quit request was accepted but the app is still running; it may be showing a dialog, or macOS blocked the Automation/quit event. Retry with force=true."
        }
        return result

    case "hide":
        guard let app = resolveApp(spec) else { appNotFound(spec) }
        _ = app.hide()
        usleep(150_000)
        return ["ok": app.isHidden, "action": action, "app": appPayload(app)]

    case "show":
        guard let app = resolveApp(spec) else { appNotFound(spec) }
        if app.isHidden { _ = app.unhide() }
        _ = activateApp(app)
        usleep(150_000)
        return ["ok": !app.isHidden, "action": action, "app": appPayload(app)]

    default:
        fail(
            "unknown app action '\(action)'",
            code: "UNSUPPORTED_ACTION",
            hint: "Supported actions: launch, activate, quit, hide, show."
        )
    }
}

// MARK: - Event flags / key codes

func eventFlags(from rawNames: [String]) -> (CGEventFlags, [String]) {
    var flags: CGEventFlags = []
    var unknown: [String] = []
    for raw in rawNames {
        switch raw.lowercased() {
        case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
        case "ctrl", "control": flags.insert(.maskControl)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        case "fn", "function": flags.insert(.maskSecondaryFn)
        case "capslock", "caps": flags.insert(.maskAlphaShift)
        default: unknown.append(raw)
        }
    }
    return (flags, unknown)
}

let keyCodeMap: [String: CGKeyCode] = [
    // letters (US layout virtual key codes; hotkeys are layout independent)
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    // digits
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
    "m": 46, ".": 47, "`": 50,
    // named keys
    "return": 36, "enter": 36, "tab": 48, "space": 49, "spacebar": 49,
    "backspace": 51, "delete": 51, "forwarddelete": 117, "deleteforward": 117, "del": 117,
    "escape": 53, "esc": 53, "capslock": 57,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
    "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "help": 114,
    "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124,
    "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
    "keypadenter": 76, "keypad.": 65, "keypad,": 65, "keypadplus": 69, "keypadminus": 78,
    "keypadmultiply": 67, "keypaddivide": 75, "keypad0": 82, "keypad1": 83, "keypad2": 84,
    "keypad3": 85, "keypad4": 86, "keypad5": 87, "keypad6": 88, "keypad7": 89,
    "keypad8": 91, "keypad9": 92, "keypadclear": 71,
    "volumeup": 72, "volumedown": 73, "mute": 74,
]

func resolveKeyCode(_ name: String, modifiers: inout CGEventFlags) -> CGKeyCode {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
        fail("key must be a non-empty string", code: "BAD_ARGS")
    }
    let lower = trimmed.lowercased()
    if lower.hasPrefix("code:") {
        let digits = String(lower.dropFirst(5)).trimmingCharacters(in: .whitespaces)
        guard let value = UInt16(digits), value <= 127 else {
            fail("invalid virtual keycode '\(trimmed)', expected code:<0-127>", code: "BAD_ARGS")
        }
        return CGKeyCode(value)
    }
    if let code = keyCodeMap[lower] {
        if trimmed.count == 1, trimmed.uppercased() == trimmed, trimmed.lowercased() != trimmed {
            modifiers.insert(.maskShift)
        }
        return code
    }
    if trimmed.count == 1, let code = keyCodeMap[trimmed] {
        return code
    }
    let keys = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o",
                "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "0", "1", "2", "3", "4",
                "5", "6", "7", "8", "9", "return", "tab", "escape", "backspace", "space",
                "left", "right", "up", "down", "home", "end", "pageup", "pagedown",
                "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"]
        .joined(separator: ", ")
    fail(
        "unsupported key '\(trimmed)'",
        code: "UNSUPPORTED_KEY",
        hint: "Supported keys: \(keys). For arbitrary text use the keyboard 'type' action."
    )
}

// MARK: - Mouse / keyboard primitives

func postMouseEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, clickState: Int64, flags: CGEventFlags) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        fail("could not create a mouse event", code: "INPUT_FAILED")
    }
    if clickState > 0 {
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
    }
    event.flags = flags
    event.post(tap: .cghidEventTap)
}

func moveMouse(to target: CGPoint, durationMs: Double, steps requestedSteps: Int?) {
    let start = cursorPoint()
    let distance = hypot(target.x - start.x, target.y - start.y)
    if distance < 0.5 {
        return
    }
    let defaultSteps = Int((distance / 18.0).rounded())
    let steps = max(2, min(60, requestedSteps ?? max(3, defaultSteps)))
    let duration = max(0, durationMs)
    let perStep = duration / Double(steps)
    for step in 1...steps {
        let t = Double(step) / Double(steps)
        let point = CGPoint(x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t)
        if let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
            event.post(tap: .cghidEventTap)
        }
        if perStep > 0 {
            usleep(useconds_t(perStep * 1000))
        } else {
            usleep(1000)
        }
    }
}

func verifyCursor(at point: CGPoint, tolerance: Double = 12.0) -> Bool {
    usleep(120_000)
    let actual = cursorPoint()
    return hypot(actual.x - point.x, actual.y - point.y) <= tolerance
}

func postKey(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else {
        fail("could not create a keyboard event", code: "INPUT_FAILED")
    }
    event.flags = flags
    event.post(tap: .cghidEventTap)
}

func postUnicodeChunk(_ chunk: [UniChar], flags: CGEventFlags) {
    guard !chunk.isEmpty else { return }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else {
        fail("could not create a keyboard event", code: "INPUT_FAILED")
    }
    down.flags = flags
    chunk.withUnsafeBufferPointer { buffer in
        guard let base = buffer.baseAddress else { return }
        down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: base)
    }
    down.post(tap: .cghidEventTap)

    guard let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return }
    up.flags = flags
    chunk.withUnsafeBufferPointer { buffer in
        guard let base = buffer.baseAddress else { return }
        up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: base)
    }
    up.post(tap: .cghidEventTap)
}

func typeText(_ text: String, delayMs: Double, chunkSize: Int) {
    guard !text.isEmpty else { return }
    var pending: [UniChar] = []
    func flush() {
        var index = 0
        let size = max(1, min(64, chunkSize))
        while index < pending.count {
            let end = min(index + size, pending.count)
            postUnicodeChunk(Array(pending[index..<end]), flags: [])
            index = end
            usleep(useconds_t(max(1, delayMs) * 1000))
        }
        pending.removeAll(keepingCapacity: true)
    }
    for scalar in text.unicodeScalars {
        switch scalar {
        case "\n", "\r":
            flush()
            postKey(36, down: true, flags: [])
            postKey(36, down: false, flags: [])
            usleep(useconds_t(max(1, delayMs) * 1000))
        case "\t":
            flush()
            postKey(48, down: true, flags: [])
            postKey(48, down: false, flags: [])
            usleep(useconds_t(max(1, delayMs) * 1000))
        default:
            pending.append(contentsOf: String(scalar).utf16)
        }
    }
    flush()
}

// MARK: - Command dispatch

func dispatch(command: String, args: [String: Any]) {
    switch command {
    case "permissions":
        writeJSON(permissionsPayload())

    case "request-screen":
        let already = CGPreflightScreenCaptureAccess()
        if already {
            writeJSON(["granted": true, "prompted": false])
            return
        }
        let granted = CGRequestScreenCaptureAccess()
        writeJSON([
            "granted": granted,
            "prompted": true,
            "hint": granted ? "" : "macOS may require restarting DeepSeek Harness before Screen Recording takes effect.",
        ])

    case "request-accessibility":
        let already = AXIsProcessTrusted()
        if already {
            writeJSON(["granted": true, "prompted": false])
            return
        }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let granted = AXIsProcessTrustedWithOptions(options)
        writeJSON([
            "granted": granted,
            "prompted": true,
            "hint": granted ? "" : "System Settings → Privacy & Security → Accessibility; enable DeepSeek Harness.",
        ])

    case "displays":
        writeJSON([
            "displays": screenDisplays(),
            "cursor": pointJSON(cursorPoint()),
            "frontmostApp": frontmostApplicationPayload(),
        ])

    case "cursor":
        writeJSON(pointJSON(cursorPoint()))

    case "windows":
        writeJSON(windowListPayload(appFilter: optionalString(args, "app")))

    case "apps":
        let includeWindows = optionalBool(args, "includeWindows") ?? true
        let trusted = AXIsProcessTrusted()
        let apps = runningApps()
            .sorted { lhs, rhs in
                if lhs.isActive != rhs.isActive { return lhs.isActive }
                return (lhs.localizedName ?? "").localizedStandardCompare(rhs.localizedName ?? "") == .orderedAscending
            }
            .map { app -> [String: Any] in
                var payload = appPayload(app)
                if includeWindows {
                    if trusted {
                        let (windows, _) = axWindows(for: app.processIdentifier)
                        payload["windows"] = windows
                    } else {
                        payload["windows"] = []
                    }
                }
                return payload
            }
        writeJSON(["apps": apps, "accessibility": trusted, "screenRecording": CGPreflightScreenCaptureAccess()])

    case "app-action":
        let action = requiredString(args, "action")
        let spec = argValue(args, "app")
        let extra = (argValue(args, "args") as? [String: Any]) ?? [:]
        writeJSON(runAppAction(action: action, spec: spec, extra: extra))

    case "app-windows":
        let spec = argValue(args, "app")
        guard let app = resolveApp(spec) else { appNotFound(spec) }
        requireAccessibility()
        let (windows, error) = axWindows(for: app.processIdentifier)
        if error != .success {
            if error == .apiDisabled {
                fail(
                    "Accessibility permission is not granted, so app windows cannot be inspected",
                    code: "PERMISSION_ACCESSIBILITY",
                    hint: permissionHintAccessibility()
                )
            }
            fail(
                "could not read windows for '\(app.localizedName ?? "")': \(axErrorDescription(error))",
                code: "AX_ERROR"
            )
        }
        writeJSON(["windows": windows, "app": appPayload(app)])

    case "move":
        let target = CGPoint(x: requiredDouble(args, "x"), y: requiredDouble(args, "y"))
        moveMouse(to: target, durationMs: optionalDouble(args, "durationMs") ?? 120, steps: optionalInt(args, "steps"))
        let verified = verifyCursor(at: target) || { moveMouse(to: target, durationMs: 40, steps: 3); return verifyCursor(at: target) }()
        if !verified {
            fail(
                "the mouse did not move to (\(Int(target.x)), \(Int(target.y))); synthetic input may be blocked",
                code: "INPUT_NOT_DELIVERED",
                hint: permissionHintAccessibility()
            )
        }
        writeJSON([
            "ok": true,
            "action": "move",
            "x": Double(target.x),
            "y": Double(target.y),
            "verified": true,
            "accessibility": AXIsProcessTrusted(),
        ])

    case "click":
        let target = CGPoint(x: requiredDouble(args, "x"), y: requiredDouble(args, "y"))
        let buttonName = (optionalString(args, "button") ?? "left").lowercased()
        let (button, downType, upType): (CGMouseButton, CGEventType, CGEventType)
        switch buttonName {
        case "left": (button, downType, upType) = (.left, .leftMouseDown, .leftMouseUp)
        case "right": (button, downType, upType) = (.right, .rightMouseDown, .rightMouseUp)
        case "middle", "center": (button, downType, upType) = (.center, .otherMouseDown, .otherMouseUp)
        default:
            fail("unsupported mouse button '\(buttonName)'", code: "BAD_ARGS", hint: "Supported buttons: left, right, middle.")
        }
        let count = max(1, min(3, optionalInt(args, "count") ?? 1))
        let (flags, unknown) = eventFlags(from: stringList(args, "modifiers"))
        if !unknown.isEmpty {
            fail("unsupported modifier(s): \(unknown.joined(separator: ", "))", code: "BAD_ARGS", hint: "Supported modifiers: cmd, ctrl, alt, shift, fn.")
        }
        moveMouse(to: target, durationMs: optionalDouble(args, "durationMs") ?? 80, steps: nil)
        var reached = verifyCursor(at: target)
        if !reached {
            moveMouse(to: target, durationMs: 40, steps: 3)
            reached = verifyCursor(at: target)
        }
        if !reached {
            fail(
                "the pointer did not reach (\(Int(target.x)), \(Int(target.y))); synthetic input may be blocked",
                code: "INPUT_NOT_DELIVERED",
                hint: permissionHintAccessibility()
            )
        }
        for clickIndex in 1...count {
            let clickState = Int64(clickIndex)
            postMouseEvent(downType, at: target, button: button, clickState: clickState, flags: flags)
            usleep(useconds_t(count > 1 ? 30_000 : 12_000))
            postMouseEvent(upType, at: target, button: button, clickState: clickState, flags: flags)
            if clickIndex < count { usleep(70_000) }
        }
        writeJSON([
            "ok": true,
            "action": "click",
            "x": Double(target.x),
            "y": Double(target.y),
            "button": buttonName,
            "count": count,
            "accessibility": AXIsProcessTrusted(),
        ])

    case "drag":
        guard let from = pointArg(args, "from") ?? {
            if let x = optionalDouble(args, "x"), let y = optionalDouble(args, "y") { return CGPoint(x: x, y: y) }
            return nil
        }() else {
            fail("drag requires 'from' and 'to' points as {x, y}", code: "BAD_ARGS")
        }
        guard let to = pointArg(args, "to") else {
            fail("drag requires a 'to' point as {x, y}", code: "BAD_ARGS")
        }
        let buttonName = (optionalString(args, "button") ?? "left").lowercased()
        let (button, downType, upType, dragType): (CGMouseButton, CGEventType, CGEventType, CGEventType)
        switch buttonName {
        case "left": (button, downType, upType, dragType) = (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
        case "right": (button, downType, upType, dragType) = (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
        case "middle", "center": (button, downType, upType, dragType) = (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
        default: fail("unsupported mouse button '\(buttonName)'", code: "BAD_ARGS")
        }
        let (flags, unknown) = eventFlags(from: stringList(args, "modifiers"))
        if !unknown.isEmpty { fail("unsupported modifier(s): \(unknown.joined(separator: ", "))", code: "BAD_ARGS") }
        let durationMs = optionalDouble(args, "durationMs") ?? 400
        moveMouse(to: from, durationMs: 60, steps: nil)
        postMouseEvent(downType, at: from, button: button, clickState: 1, flags: flags)
        let steps = max(2, min(90, optionalInt(args, "steps") ?? Int(max(4, durationMs / 16))))
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            let point = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            postMouseEvent(dragType, at: point, button: button, clickState: 0, flags: flags)
            usleep(useconds_t(max(1, durationMs / Double(steps)) * 1000))
        }
        postMouseEvent(upType, at: to, button: button, clickState: 1, flags: flags)
        writeJSON(["ok": true, "action": "drag", "from": pointJSON(from), "to": pointJSON(to)])

    case "scroll":
        let deltaX = optionalDouble(args, "deltaX") ?? 0
        let deltaY = optionalDouble(args, "deltaY") ?? 0
        if deltaX == 0 && deltaY == 0 {
            fail("scroll requires a non-zero deltaX or deltaY", code: "BAD_ARGS")
        }
        if let x = optionalDouble(args, "x"), let y = optionalDouble(args, "y") {
            moveMouse(to: CGPoint(x: x, y: y), durationMs: 60, steps: nil)
        }
        // CoreGraphics wheel axis 1 is positive when scrolling up and axis 2 is
        // positive when scrolling left, while the model-facing API (matching the
        // tool schema) uses positive deltaY = down and positive deltaX = right.
        // Amounts are in lines (CG event unit .line, ~10 px per line).
        let wheelCount: UInt32 = (deltaX != 0 && deltaY != 0) ? 2 : 1
        var remainingX = deltaX
        var remainingY = deltaY
        let maxChunk = 10.0
        while abs(remainingX) > 0.5 || abs(remainingY) > 0.5 {
            let chunkY = max(-maxChunk, min(maxChunk, remainingY))
            let chunkX = wheelCount == 2 ? max(-maxChunk, min(maxChunk, remainingX)) : 0
            guard let event = CGEvent(
                scrollWheelEvent2Source: nil,
                units: .line,
                wheelCount: wheelCount,
                wheel1: Int32((-chunkY).rounded()),
                wheel2: Int32((-chunkX).rounded()),
                wheel3: 0
            ) else {
                fail("could not create a scroll event", code: "INPUT_FAILED")
            }
            event.post(tap: .cghidEventTap)
            remainingY -= chunkY
            remainingX -= chunkX
            if abs(remainingX) > 0.5 || abs(remainingY) > 0.5 { usleep(15_000) }
        }
        writeJSON(["ok": true, "action": "scroll", "deltaX": deltaX, "deltaY": deltaY, "accessibility": AXIsProcessTrusted()])

    case "key":
        let key = requiredString(args, "key")
        var (flags, unknown) = eventFlags(from: stringList(args, "modifiers"))
        if !unknown.isEmpty {
            fail("unsupported modifier(s): \(unknown.joined(separator: ", "))", code: "BAD_ARGS", hint: "Supported modifiers: cmd, ctrl, alt, shift, fn.")
        }
        let code = resolveKeyCode(key, modifiers: &flags)
        let delay = max(0, optionalDouble(args, "delayMs") ?? 10)
        let repeatCount = max(1, min(50, optionalInt(args, "repeat") ?? 1))
        for index in 0..<repeatCount {
            postKey(code, down: true, flags: flags)
            usleep(useconds_t(max(1, delay / 2) * 1000))
            postKey(code, down: false, flags: flags)
            if index < repeatCount - 1 { usleep(useconds_t(max(1, delay) * 1000)) }
        }
        writeJSON([
            "ok": true,
            "action": "key",
            "key": key,
            "keyCode": Int(code),
            "modifiers": stringList(args, "modifiers"),
            "accessibility": AXIsProcessTrusted(),
        ])

    case "type":
        let text = requiredString(args, "text")
        let delayMs = max(1, optionalDouble(args, "delayMs") ?? 8)
        let chunkSize = max(1, min(64, optionalInt(args, "chunkSize") ?? 20))
        typeText(text, delayMs: delayMs, chunkSize: chunkSize)
        writeJSON([
            "ok": true,
            "action": "type",
            "typed": text.count,
            "length": text.utf16.count,
            "accessibility": AXIsProcessTrusted(),
        ])

    default:
        fail(
            "unknown command '\(command)'",
            code: "UNKNOWN_COMMAND",
            hint: "Supported commands: permissions, request-screen, request-accessibility, displays, cursor, windows, apps, app-action, app-windows, move, click, drag, scroll, key, type."
        )
    }
}

// MARK: - Entry point

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("missing command name", code: "BAD_ARGS", hint: "usage: native-helper <command> [json-args]")
}
let commandName = arguments[1]
var parsedArgs: [String: Any] = [:]
if arguments.count >= 3 {
    let raw = arguments[2]
    if !raw.isEmpty {
        guard let data = raw.data(using: .utf8) else {
            fail("command arguments are not valid UTF-8", code: "BAD_ARGS")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data), let dictionary = json as? [String: Any] else {
            fail("command arguments must be a JSON object", code: "BAD_ARGS")
        }
        parsedArgs = dictionary
    }
}
dispatch(command: commandName, args: parsedArgs)
exit(0)
