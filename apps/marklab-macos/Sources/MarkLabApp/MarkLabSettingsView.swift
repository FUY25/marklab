import AppKit
import SwiftUI

enum MarkLabAppSettings {
  static let localAutosaveEnabledDefaultsKey = "MarkLabLocalAutosaveEnabled"
  static let localAutosaveLabel = "Autosave Local Files"
  static let localAutosaveDescription = "Only applies when a file is not sharing. Shared documents sync automatically and create online version checkpoints."
  static let accountSectionTitle = "Account"
  static let accountSignedOutDescription = "Sign in before sharing or opening shared documents in MarkLab.app."
  static let signInLabel = "Sign In"
  static let signOutLabel = "Sign Out"
}

struct MarkLabSettingsView: View {
  @AppStorage(MarkLabAppSettings.localAutosaveEnabledDefaultsKey)
  private var localAutosaveEnabled = false
  @State private var account: NativeStoredAccount?
  @State private var accountStatus: String?
  private let accountStore: NativeAccountStore
  private let hostedDefaults: NativeHostedDefaults

  init(
    accountStore: NativeAccountStore = .defaultStore(),
    hostedDefaults: NativeHostedDefaults = .fromEnvironment()
  ) {
    self.accountStore = accountStore
    self.hostedDefaults = hostedDefaults
    _account = State(initialValue: try? accountStore.load())
  }

  var body: some View {
    Form {
      Section(MarkLabAppSettings.accountSectionTitle) {
        if let account {
          Text(account.displayName)
            .font(.headline)
          Text(account.email)
            .foregroundStyle(.secondary)
          Text(account.workspaceName)
            .foregroundStyle(.secondary)
          Button(MarkLabAppSettings.signOutLabel) {
            signOut()
          }
        } else {
          Text(MarkLabAppSettings.accountSignedOutDescription)
            .font(.callout)
            .foregroundStyle(.secondary)
          Button(MarkLabAppSettings.signInLabel) {
            NSWorkspace.shared.open(signInURL)
          }
        }
        if let accountStatus {
          Text(accountStatus)
            .font(.callout)
            .foregroundStyle(.secondary)
        }
      }

      Section("Editing") {
        Toggle(MarkLabAppSettings.localAutosaveLabel, isOn: $localAutosaveEnabled)
        Text(MarkLabAppSettings.localAutosaveDescription)
          .font(.callout)
          .foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
    .padding(20)
    .frame(width: 440)
  }

  private var signInURL: URL {
    var components = URLComponents(url: hostedDefaults.webBaseURL.appending(path: "signin"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "native", value: "1")]
    return components.url!
  }

  private func signOut() {
    do {
      try accountStore.clear()
      account = nil
      accountStatus = "Signed out."
    } catch {
      accountStatus = "Unable to sign out."
    }
  }
}
