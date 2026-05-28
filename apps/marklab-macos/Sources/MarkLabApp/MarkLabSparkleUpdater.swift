import Combine
import Foundation
import Sparkle
import SwiftUI

enum MarkLabSparkleUpdater {
  static let checkForUpdatesTitle = "Check for Updates..."

  static func isConfigured(feedURL: String?, publicEDKey: String?) -> Bool {
    guard
      let feedURL = feedURL?.trimmingCharacters(in: .whitespacesAndNewlines),
      let publicEDKey = publicEDKey?.trimmingCharacters(in: .whitespacesAndNewlines),
      !feedURL.isEmpty,
      !publicEDKey.isEmpty,
      URL(string: feedURL)?.scheme?.lowercased() == "https"
    else {
      return false
    }
    return true
  }

  static func isConfigured(bundle: Bundle = .main) -> Bool {
    isConfigured(
      feedURL: bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String,
      publicEDKey: bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String
    )
  }

  @MainActor
  static func makeControllerIfConfigured(bundle: Bundle = .main) -> SPUStandardUpdaterController? {
    guard isConfigured(bundle: bundle) else { return nil }
    return SPUStandardUpdaterController(
      startingUpdater: true,
      updaterDelegate: nil,
      userDriverDelegate: nil
    )
  }
}

@MainActor
final class MarkLabCheckForUpdatesViewModel: ObservableObject {
  @Published var canCheckForUpdates = false

  init(updater: SPUUpdater) {
    updater.publisher(for: \.canCheckForUpdates)
      .receive(on: RunLoop.main)
      .assign(to: &$canCheckForUpdates)
  }
}

struct MarkLabCheckForUpdatesView: View {
  @ObservedObject private var viewModel: MarkLabCheckForUpdatesViewModel
  private let updater: SPUUpdater

  init(updater: SPUUpdater) {
    self.updater = updater
    viewModel = MarkLabCheckForUpdatesViewModel(updater: updater)
  }

  var body: some View {
    Button(MarkLabSparkleUpdater.checkForUpdatesTitle) {
      updater.checkForUpdates()
    }
    .disabled(!viewModel.canCheckForUpdates)
  }
}

struct MarkLabUpdateCommands: Commands {
  let updater: SPUUpdater?

  var body: some Commands {
    CommandGroup(after: .appInfo) {
      if let updater {
        MarkLabCheckForUpdatesView(updater: updater)
      }
    }
  }
}
