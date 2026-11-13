import SwiftUI
import UIKit

/// The share extension's entry point (NSExtensionPrincipalClass): hosts ShareView, and closes the
/// share sheet when the person is done. Work continues in PersonalOS after it closes.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(
            model: model,
            onDone: { [weak self] in self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil) },
            onCancel: { [weak self] in self?.extensionContext?.cancelRequest(withError: NSError(domain: "PersonalOSShare", code: NSUserCancelledError)) }
        ))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        Task { await model.load(items) }
    }
}
