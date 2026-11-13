import Foundation
import UniformTypeIdentifiers

/// What another app handed the share sheet, read from the extension's input items:
/// Safari's preprocessing result (address, title, selection), a link, plain text, or a file.
struct SharedContent: Equatable {
    var url: URL?
    var title: String?
    var selection: String?
    var text: String?
    var file: File?
    /// Why this can't be sent, when it can't (an unsupported or too large file).
    var refusal: String?

    struct File: Equatable {
        var name: String
        var mediaType: String
        var size: Int
        var text: String?
    }

    /// The envelope's context, in the contract's kinds.
    var context: [ContextItem] {
        var items: [ContextItem] = []
        if let url { items.append(ContextItem(kind: "url", url: url.absoluteString, title: title)) }
        if let selection, !selection.isEmpty { items.append(ContextItem(kind: "selection", url: url?.absoluteString, text: String(selection.prefix(InvocationLimits.textChars)))) }
        if let text, !text.isEmpty, url == nil { items.append(ContextItem(kind: "text", text: String(text.prefix(InvocationLimits.textChars)))) }
        if let file, let content = file.text { items.append(ContextItem(kind: "document", text: content, name: file.name, mediaType: file.mediaType, size: file.size)) }
        return items
    }

    var summary: String {
        if let file { return file.name }
        if let title, !title.isEmpty { return title }
        if let url { return url.host ?? url.absoluteString }
        return String((text ?? selection ?? "").prefix(120))
    }

    static func load(from items: [NSExtensionItem]) async -> SharedContent {
        var content = SharedContent()
        for item in items {
            if content.title == nil, let title = item.attributedContentText?.string, !title.isEmpty { content.title = title }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier),
                   let dict = try? await provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier) as? NSDictionary,
                   let page = dict[NSExtensionJavaScriptPreprocessingResultsKey] as? NSDictionary {
                    // Safari: the page itself, as Preprocess.js read it.
                    if let address = page["url"] as? String, let url = URL(string: address) { content.url = url }
                    if let title = page["title"] as? String, !title.isEmpty { content.title = title }
                    if let selection = page["selection"] as? String, !selection.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { content.selection = selection }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
                          let fileURL = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) as? URL {
                    var refusal = content.refusal
                    content.file = File.read(fileURL, refusal: &refusal)
                    content.refusal = refusal
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                          let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    if url.isFileURL {
                        var refusal = content.refusal
                        content.file = File.read(url, refusal: &refusal)
                        content.refusal = refusal
                    } else if content.url == nil {
                        content.url = url
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    // A shared "text" that is only a web address is a link.
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let url = URL(string: trimmed), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), !trimmed.contains(" ") {
                        if content.url == nil { content.url = url }
                    } else if content.url != nil {
                        content.selection = content.selection ?? trimmed
                    } else {
                        content.text = trimmed
                    }
                } else if content.refusal == nil {
                    let type = provider.registeredTypeIdentifiers.first ?? "this item"
                    content.refusal = "PersonalOS can't take \(type) yet. It takes web pages, text, and text documents."
                }
            }
        }
        if content.text != nil, content.text!.count > InvocationLimits.textChars {
            content.refusal = "That text is longer than PersonalOS takes (\(InvocationLimits.textChars) characters)."
        }
        return content
    }
}

extension SharedContent.File {
    /// A text document PersonalOS can read, or nil with the reason.
    static func read(_ url: URL, refusal: inout String?) -> SharedContent.File? {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let type = UTType(filenameExtension: url.pathExtension)
        let mediaType = type?.preferredMIMEType ?? "application/octet-stream"
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard InvocationLimits.documentTypes.contains(mediaType) else {
            refusal = "PersonalOS can't read \(url.lastPathComponent) (\(mediaType)) yet. It takes web pages, text, and text documents."
            return nil
        }
        guard size <= InvocationLimits.documentBytes else {
            refusal = "\(url.lastPathComponent) is \(size / 1024) KB; PersonalOS takes documents up to \(InvocationLimits.documentBytes / 1024) KB."
            return nil
        }
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else {
            refusal = "\(url.lastPathComponent) isn't readable text."
            return nil
        }
        return SharedContent.File(name: url.lastPathComponent, mediaType: mediaType, size: size, text: text)
    }
}
