import AppKit
import MarkLabMacOS
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
  private let accountTransport: NativeHTTPTransport

  init(
    accountStore: NativeAccountStore = .defaultStore(),
    hostedDefaults: NativeHostedDefaults = .fromEnvironment(),
    accountTransport: NativeHTTPTransport = URLSessionNativeHTTPTransport()
  ) {
    self.accountStore = accountStore
    self.hostedDefaults = hostedDefaults
    self.accountTransport = accountTransport
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
    .onReceive(NotificationCenter.default.publisher(for: .markLabAccountDidSignIn)) { _ in
      account = try? accountStore.load()
      if account != nil {
        accountStatus = "Signed in."
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: .markLabAccountDidSignOut)) { notification in
      let token = notification.userInfo?[NativeAccountSignOutNotification.tokenKey] as? String
      if token == nil || token == account?.token {
        account = nil
        accountStatus = "Signed out."
      }
    }
  }

  private var signInURL: URL {
    var components = URLComponents(url: hostedDefaults.webBaseURL.appending(path: "signin"), resolvingAgainstBaseURL: false)!
    let appState = NativeAuthPendingState.generate()
    try? accountStore.savePendingAuthState(appState)
    components.queryItems = [
      URLQueryItem(name: "native", value: "1"),
      URLQueryItem(name: "appState", value: appState),
    ]
    return components.url!
  }

  private func signOut() {
    guard let currentAccount = account else {
      accountStatus = "Signed out."
      return
    }
    accountStatus = "Signing out..."
    Task { @MainActor in
      let client = NativeAccountClient(
        apiBaseURL: currentAccount.apiBaseURL,
        bearerToken: currentAccount.token,
        transport: accountTransport
      )
      let didLogout = (try? await client.logout()) != nil
      do {
        try accountStore.clear()
        account = nil
        accountStatus = didLogout ? "Signed out." : "Signed out locally. Server session may already be expired."
        NotificationCenter.default.post(
          name: .markLabAccountDidSignOut,
          object: nil,
          userInfo: [NativeAccountSignOutNotification.tokenKey: currentAccount.token]
        )
      } catch {
        accountStatus = "Unable to clear the local account."
      }
    }
  }
}
